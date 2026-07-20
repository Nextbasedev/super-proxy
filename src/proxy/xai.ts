import type { FastifyInstance } from 'fastify';
import { writeRawResponseHead } from '../http/response-headers.js';
import { config } from '../config.js';
import { requireProxyToken } from '../auth/token-auth.js';
import { recordUsage } from './usage.js';
import { compressionFields } from './compress.js';
import { checkLooseLimit, enforceAfterUsage, isModelAllowedForUser, logRequestResponse, shouldLogBody } from './policy.js';
import { estimateCost, estimateXaiMediaCost, estimateXaiSttCost, estimateXaiTtsCost } from './cost.js';
import { DEFAULT_XAI_MODEL, KNOWN_XAI_IMAGE_MODELS, KNOWN_XAI_MODELS, KNOWN_XAI_VIDEO_MODELS, ensureFreshXaiAccount, getXaiBatchJobAccount, getXaiVideoJobAccount, markXaiCooldown, markXaiVideoJobTruedUp, recordXaiBatchJob, recordXaiSuccess, recordXaiVideoJob, selectXaiAccount } from '../providers/xai-pool.js';
import { xaiFetchDispatcher } from '../providers/xai-proxy-agent.js';
import { isAbortTimeoutError, isModelUnavailableError, modelUnavailableError, surfaceOpenAiCompatError, surfaceOpenAiCompatStreamChunk, timeoutMessage, timeoutSeconds, transientNetworkMessage, type OpenAiCompatStreamState } from './openai-compat-errors.js';
import { catalogModelIdsWithCapability, catalogModelsForProvider } from '../providers/model-catalog.js';

const REQUEST_TIMEOUT_MS = 20 * 60 * 1000;
const XAI_MAX_SURFACE_SSE_BUFFER_CHARS = 1024 * 1024;
const XAI_IMAGE_MODEL = 'grok-imagine-image-quality';
const XAI_VIDEO_MODEL = 'grok-imagine-video-1.5-preview';
// grok-imagine-video-1.5-preview only supports plain text-to-video and
// image-to-video. The advanced Imagine video modes — video editing, video
// extension, and reference-to-video — are only supported by grok-imagine-video.
// xAI rejects these modes on grok-imagine-video-1.5-preview with errors like
// "Video editing is not supported for this model" / "reference_images is not
// supported for this model". See https://docs.x.ai/developers/model-capabilities/imagine
// ("Requires grok-imagine-video — grok-imagine-video-1.5 does not support this mode").
const XAI_VIDEO_ADVANCED_MODEL = 'grok-imagine-video';
// Models capable of reference-to-video and of video edit/extend operations.
export const XAI_VIDEO_REFERENCE_MODELS = new Set(catalogModelIdsWithCapability('xai', 'reference-to-video'));
export const XAI_VIDEO_EDIT_MODELS = new Set([
  ...catalogModelIdsWithCapability('xai', 'video-editing'),
  ...catalogModelIdsWithCapability('xai', 'video-extension'),
]);
const XAI_TTS_MODEL = 'grok-voice-tts';
const XAI_STT_MODEL = 'grok-stt';
const XAI_REALTIME_MODEL = 'grok-realtime-voice';
const XAI_REALTIME_DEFAULT_UPSTREAM_MODEL = 'grok-voice-latest';
const XAI_FILES_MODEL = 'xai-files';
const XAI_BATCH_MODEL = 'xai-batch';
export const XAI_REALTIME_MODELS = new Set(catalogModelIdsWithCapability('xai', 'realtime'));
const KNOWN_XAI_NON_TEXT_MODELS = new Set<string>([
  ...catalogModelsForProvider('xai')
    .filter((entry) => !entry.capabilities.includes('chat'))
    .map((entry) => entry.id),
  // Route pseudo-identifiers, not real provider models, remain explicit.
  XAI_FILES_MODEL,
  XAI_BATCH_MODEL,
]);
const XAI_TTS_ALLOWED_VOICES = new Set<string>(['eve', 'ara', 'rex', 'sal', 'leo']);
const XAI_MAX_TTS_CHARS = 15_000;
const XAI_STT_BODY_LIMIT_BYTES = 100 * 1024 * 1024;
const XAI_FILES_BODY_LIMIT_BYTES = 100 * 1024 * 1024;
const XAI_BATCH_BODY_LIMIT_BYTES = 100 * 1024 * 1024;
const XAI_MAX_PROMPT_CHARS = 8_000;
// xAI Imagine supports up to seven reference images for reference-to-video.
const XAI_MAX_VIDEO_REFERENCE_IMAGES = 7;
// Image editing remains capped at three input images.
const XAI_MAX_IMAGE_EDIT_SOURCE_IMAGES = 3;
const XAI_MAX_VIDEO_DURATION_SECONDS = 15;
// billed assumption when client omits duration; clamp 1–15
const XAI_DEFAULT_VIDEO_DURATION_SECONDS = 5;
const XAI_MEDIA_BODY_LIMIT_BYTES = 32 * 1024 * 1024;

// xAI returns HTTP 403 with a body like
// {"code":"The caller does not have permission ...",
//  "error":"You have run out of credits or need a Grok subscription. ... [WKE=personal-team-blocked:spending-limit]"}
// when the upstream account is out of quota or has hit a SuperGrok spending
// limit. These are not generic permission errors — they are recoverable by
// routing to a different xAI account in the pool, so we treat them like rate
// limits (cooldown the account, retry the next one).
export function isXaiOutOfQuotaError(status: number, body: string): boolean {
  if (status !== 403) return false;
  const lower = (body || '').toLowerCase();
  return /out of credits/.test(lower)
    || /grok subscription/.test(lower)
    || /spending[- ]limit/.test(lower)
    || /wke=personal-team-blocked/.test(lower)
    || /quota/.test(lower);
}

function openAiError(message: string, type = 'server_error', code?: string) {
  return { error: { message, type, code: code || null } };
}

function modelNotAllowedForUserError(message: string) {
  return { type: 'error', error: { type: 'invalid_request_error', code: 'model_not_allowed_for_user', message } };
}

function wrongXaiEndpointError(model: string) {
  return { type: 'error', error: { type: 'invalid_request_error', code: 'wrong_endpoint_for_model', message: `Model ${model} is not a /v1/xai/responses model. Use ${xaiEndpointForModel(model)} instead.` } };
}

function xaiEndpointForModel(model: string): string {
  if (XAI_REALTIME_MODELS.has(model)) return '/v1/xai/realtime/client_secrets';
  if (model === XAI_TTS_MODEL) return '/v1/xai/tts';
  if (model === XAI_STT_MODEL) return '/v1/xai/stt';
  if (KNOWN_XAI_IMAGE_MODELS.has(model)) return '/v1/xai/images/generations';
  if (KNOWN_XAI_VIDEO_MODELS.has(model)) return '/v1/xai/videos/generations';
  if (model === XAI_FILES_MODEL) return '/v1/xai/files';
  if (model === XAI_BATCH_MODEL) return '/v1/xai/batches';
  return '/v1/xai media/voice endpoint';
}

function estimateInputTokens(body: any): number {
  return Math.max(50, Math.ceil(JSON.stringify(body || {}).length / 4));
}

function retryAfterMs(value: string | null): number {
  if (!value) return 60_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 60_000;
}

function parseUsage(text: string, fallbackInput: number) {
  let usage = { inputTokens: fallbackInput, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 };
  try {
    const parsed = JSON.parse(text);
    const u = parsed?.usage || parsed?.response?.usage;
    if (u) usage = {
      inputTokens: u.input_tokens ?? u.prompt_tokens ?? fallbackInput,
      outputTokens: u.output_tokens ?? u.completion_tokens ?? 0,
      cacheCreationTokens: 0,
      cacheReadTokens: u.input_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0,
      reasoningTokens: u.output_tokens_details?.reasoning_tokens ?? u.completion_tokens_details?.reasoning_tokens ?? 0,
    };
  } catch {}
  return usage;
}

function absorbSseUsage(chunk: string, state: { pending: string; usage: any }, fallbackInput: number, force = false) {
  state.pending += chunk;
  let sepIdx;
  while ((sepIdx = state.pending.indexOf('\n\n')) !== -1) {
    const event = state.pending.slice(0, sepIdx);
    state.pending = state.pending.slice(sepIdx + 2);
    const payload = event.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
    if (!payload || payload === '[DONE]') continue;
    try {
      const parsed = JSON.parse(payload);
      const u = parsed?.usage || parsed?.response?.usage;
      if (u) state.usage = {
        inputTokens: u.input_tokens ?? u.prompt_tokens ?? state.usage.inputTokens ?? fallbackInput,
        outputTokens: u.output_tokens ?? u.completion_tokens ?? state.usage.outputTokens ?? 0,
        cacheCreationTokens: 0,
        cacheReadTokens: u.input_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? state.usage.cacheReadTokens ?? 0,
        reasoningTokens: u.output_tokens_details?.reasoning_tokens ?? u.completion_tokens_details?.reasoning_tokens ?? state.usage.reasoningTokens ?? 0,
      };
    } catch {}
  }
  if (force && state.pending.trim()) {
    const rest = state.pending;
    state.pending = '';
    absorbSseUsage(rest + '\n\n', state, fallbackInput, false);
  }
}

function consumeCompleteSseFrames(state: { pending: string }, chunk: string, force = false): string[] {
  state.pending += chunk;
  if (state.pending.length > XAI_MAX_SURFACE_SSE_BUFFER_CHARS) state.pending = '';
  const events: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = /\r?\n\r?\n/.exec(state.pending)) !== null) {
    events.push(state.pending.slice(0, match.index));
    state.pending = state.pending.slice(match.index + match[0].length);
  }
  if (force && state.pending.trim()) {
    events.push(state.pending);
    state.pending = '';
  }
  return events;
}

function surfaceXaiCompleteSseFrames(chunk: string, bufferState: { pending: string }, surfaceState: OpenAiCompatStreamState, force = false) {
  let appendSse = '';
  let forcedLogReason: string | undefined;
  for (const event of consumeCompleteSseFrames(bufferState, chunk, force)) {
    const surfaced = surfaceOpenAiCompatStreamChunk('xai', `${event}\n\n`, surfaceState);
    if (surfaced.appendSse) appendSse += surfaced.appendSse;
    if (surfaced.forcedLogReason) forcedLogReason = surfaced.forcedLogReason;
  }
  return { appendSse: appendSse || undefined, forcedLogReason };
}

async function forwardXaiResponses(req: any, reply: any) {
  const auth = await requireProxyToken(req, reply);
  if (!auth) return;
  const started = Date.now();

  const body = { ...((req.body as any) || {}) };
  const rawModel = typeof body.model === 'string' && body.model ? body.model : undefined;
  const model = rawModel || DEFAULT_XAI_MODEL;
  if (XAI_REALTIME_MODELS.has(model)) {
    req.body = body;
    return forwardXaiRealtimeClientSecret(req, reply);
  }
  if (KNOWN_XAI_IMAGE_MODELS.has(model) || KNOWN_XAI_VIDEO_MODELS.has(model) || KNOWN_XAI_NON_TEXT_MODELS.has(model)) {
    reply.code(400).send(wrongXaiEndpointError(model));
    return;
  }
  if (!KNOWN_XAI_MODELS.has(model)) {
    reply.code(400).send(modelNotAllowedForUserError(`Model ${model} is not allowed for xAI`));
    return;
  }
  const allowed = isModelAllowedForUser(auth.user, 'xai', model);
  if (!allowed.ok) {
    reply.code(400).send(modelNotAllowedForUserError(allowed.message));
    return;
  }
  body.model = model;

  const limit = checkLooseLimit(auth.user, 'xai', auth.token, model);
  if (!limit.ok) {
    reply.code(429).send(openAiError(limit.message, 'insufficient_quota', 'user_limit_exceeded'));
    return;
  }

  const stream = !!body.stream;
  const inputEstimate = estimateInputTokens(body);
  const conversationId = String(req.headers['x-conversation-id'] || req.headers['session_id'] || req.headers['x-client-request-id'] || body?.conversation_id || body?.previous_response_id || '');
  const stickyKey = `${auth.user.email}:${auth.token.label}:${conversationId || model || 'responses'}`;
  const tried: number[] = [];
  let lastError = 'No xAI account available';
  let retryAfter = 60;

  for (let attempt = 0; attempt < 5; attempt++) {
    const selected = selectXaiAccount(stickyKey, tried);
    if (!selected) break;
    tried.push(selected.id);
    let account = selected;
    try {
      account = await ensureFreshXaiAccount(selected);
      const upstream = await fetch(`${config.xaiUpstreamUrl}/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${account.secret}`, 'content-type': 'application/json', accept: stream ? 'text/event-stream' : 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ...xaiFetchDispatcher(model),
      });
      reply.header('x-gateway-provider', 'xai');
      reply.header('x-gateway-account', account.label);
      reply.header('x-gateway-attempt', String(attempt + 1));

      if (upstream.status === 429) {
        const text = await upstream.text().catch(() => '');
        const ms = retryAfterMs(upstream.headers.get('retry-after'));
        retryAfter = Math.max(1, Math.ceil(ms / 1000));
        markXaiCooldown(account.id, ms, `rate limited (${upstream.status})`);
        req.log?.info?.({ provider: 'xai', account: account.label, model, attempt: attempt + 1 }, 'xAI rate limited; switching to another account');
        recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'xai', endpoint: '/v1/xai/responses', model, stream, statusCode: upstream.status, inputTokens: inputEstimate, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: text.slice(0, 500) || 'rate limited', ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
        lastError = text.slice(0, 500) || 'rate limited';
        continue;
      }

      if (upstream.status >= 400) {
        const text = await upstream.text().catch(() => '');
        lastError = text.slice(0, 500) || String(upstream.status);
        if (isModelUnavailableError(upstream.status, text)) {
          const clean = modelUnavailableError('xai', model);
          lastError = clean.error.message;
          recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'xai', endpoint: '/v1/xai/responses', model, stream, statusCode: upstream.status, inputTokens: inputEstimate, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
          reply.code(400).send(clean);
          return;
        }
        // xAI returns 403 with a billing/subscription body when the account is
        // out of credits or has hit a SuperGrok spending limit. Treat these the
        // same as a rate limit: cool the account down, then continue the retry
        // loop so other pool accounts can serve the request.
        if (isXaiOutOfQuotaError(upstream.status, text)) {
          const cooldownMs = 6 * 60 * 60 * 1000; // 6h — spending limits usually reset on the billing cycle
          markXaiCooldown(account.id, cooldownMs, 'out_of_quota');
          req.log?.info?.({ provider: 'xai', account: account.label, model, attempt: attempt + 1 }, 'xAI account out of quota / spending limit; switching to another account');
          recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'xai', endpoint: '/v1/xai/responses', model, stream, statusCode: upstream.status, inputTokens: inputEstimate, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
          retryAfter = Math.max(retryAfter, 60);
          continue;
        }
        recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'xai', endpoint: '/v1/xai/responses', model, stream, statusCode: upstream.status, inputTokens: inputEstimate, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
        reply.code(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(text || openAiError(lastError));
        return;
      }

      if (stream && upstream.body) {
        writeRawResponseHead(reply, upstream.status, { 'content-type': upstream.headers.get('content-type') || 'text/event-stream', 'cache-control': 'no-cache', 'x-gateway-provider': 'xai', 'x-gateway-account': account.label });
        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        let assembled = '';
        let ttftMs: number | undefined;
        const sseState = { pending: '', usage: { inputTokens: inputEstimate, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 } };
        const surfaceBufferState = { pending: '' };
        const surfaceState: OpenAiCompatStreamState = { sawCompletion: false, sawContent: false };
        let forcedLogReason: string | undefined;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (ttftMs === undefined) ttftMs = Date.now() - started;
            const chunk = decoder.decode(value, { stream: true });
            assembled += chunk;
            absorbSseUsage(chunk, sseState, inputEstimate);
            reply.raw.write(chunk);
            const surfaced = surfaceXaiCompleteSseFrames(chunk, surfaceBufferState, surfaceState);
            if (surfaced.appendSse) { assembled += surfaced.appendSse; reply.raw.write(surfaced.appendSse); }
            if (surfaced.forcedLogReason) forcedLogReason = surfaced.forcedLogReason;
          }
          const tail = decoder.decode();
          if (tail) {
            assembled += tail;
            absorbSseUsage(tail, sseState, inputEstimate);
            reply.raw.write(tail);
            const surfaced = surfaceXaiCompleteSseFrames(tail, surfaceBufferState, surfaceState);
            if (surfaced.appendSse) { assembled += surfaced.appendSse; reply.raw.write(surfaced.appendSse); }
            if (surfaced.forcedLogReason) forcedLogReason = surfaced.forcedLogReason;
          }
        } catch (err: any) {
          forcedLogReason = isAbortTimeoutError(err) ? 'xai_timeout' : 'xai_stream_interrupted';
          const interrupted = surfaceOpenAiCompatError('xai', null, 'stream_interrupted', isAbortTimeoutError(err) ? timeoutMessage(timeoutSeconds(REQUEST_TIMEOUT_MS)) : undefined).appendSse!;
          assembled += interrupted;
          reply.raw.write(interrupted);
        }
        const flushed = surfaceXaiCompleteSseFrames('', surfaceBufferState, surfaceState, true);
        if (flushed.appendSse) { assembled += flushed.appendSse; reply.raw.write(flushed.appendSse); }
        if (flushed.forcedLogReason) forcedLogReason = flushed.forcedLogReason;
        absorbSseUsage('', sseState, inputEstimate, true);
        if (!surfaceState.sawCompletion && !forcedLogReason) {
          forcedLogReason = 'xai_stream_interrupted';
          const interrupted = surfaceOpenAiCompatError('xai', null, 'stream_interrupted').appendSse!;
          assembled += interrupted;
          reply.raw.write(interrupted);
        }
        reply.raw.end();
        recordXaiSuccess(account.id);
        const usageEventId = recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'xai', endpoint: '/v1/xai/responses', model, stream, statusCode: upstream.status, ...sseState.usage, ttftMs, retryCount: attempt, retryReason: attempt > 0 ? 'account_rotation' : undefined, estimatedCostUsd: estimateCost(model, sseState.usage, 'xai'), latencyMs: Date.now() - started, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
        enforceAfterUsage(auth.user, 'xai', auth.token, model);
        if (forcedLogReason) logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: { forcedLogReason, providerAccountLabel: account.label, attempt: attempt + 1, headers: req.headers, body }, responseText: assembled });
        else if (shouldLogBody(auth.user)) logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: body, responseText: assembled });
        return;
      }

      let text = await upstream.text();
      let forcedLogReason: string | undefined;
      try {
        const parsed = JSON.parse(text);
        const surfaced = surfaceOpenAiCompatError('xai', parsed, 'non_stream');
        if (surfaced.changed) text = JSON.stringify(parsed);
        forcedLogReason = surfaced.forcedLogReason;
      } catch {}
      const usage = parseUsage(text, inputEstimate);
      recordXaiSuccess(account.id);
      const usageEventId = recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'xai', endpoint: '/v1/xai/responses', model, stream, statusCode: upstream.status, ...usage, ttftMs: Date.now() - started, retryCount: attempt, retryReason: attempt > 0 ? 'account_rotation' : undefined, estimatedCostUsd: estimateCost(model, usage, 'xai'), latencyMs: Date.now() - started, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
      enforceAfterUsage(auth.user, 'xai', auth.token, model);
      if (forcedLogReason) logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: { forcedLogReason, providerAccountLabel: account.label, attempt: attempt + 1, headers: req.headers, body }, responseText: text });
      else if (shouldLogBody(auth.user)) logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: body, responseText: text });
      reply.code(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(text);
      return;
    } catch (err: any) {
      const timedOut = isAbortTimeoutError(err);
      lastError = timedOut ? timeoutMessage(timeoutSeconds(REQUEST_TIMEOUT_MS)) : transientNetworkMessage('xai');
      if (!timedOut) {
        markXaiCooldown(account.id, 60_000, `network error: ${err?.message || err}`);
        req.log?.info?.({ provider: 'xai', account: account.label, model, attempt: attempt + 1, error: String(err?.message || err) }, 'xAI network error; switching to another account');
      }
      const statusCode = timedOut ? 504 : 502;
      const usageEventId = recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'xai', endpoint: '/v1/xai/responses', model, stream, statusCode, inputTokens: inputEstimate, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
      if (timedOut) {
        logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: { forcedLogReason: 'xai_timeout', providerAccountLabel: account.label, attempt: attempt + 1, headers: req.headers, body }, responseText: JSON.stringify(openAiError(lastError, 'timeout', 'gateway_timeout')) });
        reply.code(504).send(openAiError(lastError, 'timeout', 'gateway_timeout'));
        return;
      }
    }
  }

  reply.header('retry-after', String(retryAfter));
  reply.header('x-gateway-provider', 'xai');
  reply.code(429).send(openAiError(`xAI capacity unavailable: ${lastError}`, 'rate_limit_exceeded', 'rate_limit_exceeded'));
}

function isValidXaiMediaUri(value: string): boolean {
  if (value.startsWith('data:')) return /^data:image\/(png|jpe?g|webp);base64,/i.test(value);
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0') return false;
    if (host.startsWith('[')) return false;
    if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc00:') || host.startsWith('fd00:')) return false;
    if (!host.includes('.')) return false;
    if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return false;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}

function billableXaiVideoDurationSeconds(requestedDuration: number | undefined): number {
  return Math.min(XAI_MAX_VIDEO_DURATION_SECONDS, Math.max(1, requestedDuration || XAI_DEFAULT_VIDEO_DURATION_SECONDS));
}

function validateXaiPrompt(prompt: any): string | undefined {
  if (typeof prompt !== 'string' || !prompt.trim()) return 'prompt must be a non-empty string';
  if (prompt.length > XAI_MAX_PROMPT_CHARS) return `prompt must be at most ${XAI_MAX_PROMPT_CHARS} characters`;
  return undefined;
}

function normalizeXaiVideoBody(body: any): { body?: any; error?: string; requestedDuration?: number } {
  const normalized = { ...(body || {}) };
  const explicitModel = typeof normalized.model === 'string' && normalized.model.trim() ? normalized.model.trim() : undefined;
  // Reference-to-video (reference_images / reference_image_urls) is only
  // supported by grok-imagine-video. Route reference requests to the capable
  // model by default, and reject clearly if the caller pinned an incapable
  // model — so we never forward a request the upstream will reject.
  const usesReferenceImages =
    (Array.isArray(normalized.reference_image_urls) && normalized.reference_image_urls.length > 0) ||
    (Array.isArray(normalized.reference_images) && normalized.reference_images.length > 0);
  if (usesReferenceImages) {
    if (explicitModel && !XAI_VIDEO_REFERENCE_MODELS.has(explicitModel)) {
      return { error: `reference-to-video requires model "${XAI_VIDEO_ADVANCED_MODEL}"; ${explicitModel} does not support reference images` };
    }
    normalized.model = explicitModel || XAI_VIDEO_ADVANCED_MODEL;
  } else {
    normalized.model = explicitModel || XAI_VIDEO_MODEL;
  }
  const promptError = validateXaiPrompt(normalized.prompt);
  if (promptError) return { error: promptError };
  if (typeof normalized.image_url === 'string' && normalized.image_url.trim()) {
    const url = normalized.image_url.trim();
    if (!isValidXaiMediaUri(url)) return { error: 'image_url must be an http(s) URL or image data URI' };
    normalized.image = { url };
    delete normalized.image_url;
  }
  if (normalized.image?.url != null) {
    if (typeof normalized.image.url !== 'string' || !isValidXaiMediaUri(normalized.image.url.trim())) return { error: 'image.url must be an http(s) URL or image data URI' };
    normalized.image = { ...normalized.image, url: normalized.image.url.trim() };
  }
  if (Array.isArray(normalized.reference_image_urls) && !normalized.reference_images) {
    if (normalized.reference_image_urls.length > XAI_MAX_VIDEO_REFERENCE_IMAGES) return { error: `reference_image_urls must contain at most ${XAI_MAX_VIDEO_REFERENCE_IMAGES} images` };
    normalized.reference_images = normalized.reference_image_urls
      .map((url: any) => String(url || '').trim())
      .filter(Boolean)
      .map((url: string) => ({ url }));
    delete normalized.reference_image_urls;
  }
  if (Array.isArray(normalized.reference_images)) {
    if (normalized.reference_images.length > XAI_MAX_VIDEO_REFERENCE_IMAGES) return { error: `reference_images must contain at most ${XAI_MAX_VIDEO_REFERENCE_IMAGES} images` };
    for (const image of normalized.reference_images) {
      if (typeof image?.url !== 'string' || !isValidXaiMediaUri(image.url.trim())) return { error: 'reference_images URLs must be http(s) URLs or image data URIs' };
      image.url = image.url.trim();
    }
  }
  let requestedDuration = 0;
  if (normalized.duration != null) {
    if (typeof normalized.duration !== 'number' || !Number.isFinite(normalized.duration) || normalized.duration < 0) return { error: 'duration must be a positive number' };
    if (normalized.duration === 0) {
      delete normalized.duration;
    } else {
      requestedDuration = Math.min(XAI_MAX_VIDEO_DURATION_SECONDS, normalized.duration);
      normalized.duration = requestedDuration;
    }
  }
  return { body: normalized, requestedDuration };
}

function normalizeXaiVideoSourceBody(body: any, operation: 'edit' | 'extend'): { body?: any; error?: string } {
  const normalized = { ...(body || {}) };
  // Video editing and extension are only supported by grok-imagine-video.
  // Default to the capable model and reject a pinned incapable model cleanly
  // rather than forwarding a request the upstream will reject.
  const explicitModel = typeof normalized.model === 'string' && normalized.model.trim() ? normalized.model.trim() : undefined;
  if (explicitModel && !XAI_VIDEO_EDIT_MODELS.has(explicitModel)) {
    const label = operation === 'edit' ? 'video editing' : 'video extension';
    return { error: `${label} requires model "${XAI_VIDEO_ADVANCED_MODEL}"; ${explicitModel} does not support this operation` };
  }
  normalized.model = explicitModel || XAI_VIDEO_ADVANCED_MODEL;
  const promptError = validateXaiPrompt(normalized.prompt);
  if (promptError) return { error: promptError };

  const source = normalized.video ?? normalized.video_url;
  let rawUrl: any;
  if (typeof source === 'string') rawUrl = source;
  else if (source && typeof source === 'object') rawUrl = source.url;
  else return { error: 'video must be a video URL or video object' };

  if (typeof rawUrl !== 'string') return { error: 'video.url must be an http(s) URL or image data URI' };
  const url = rawUrl.trim();
  if (!isValidXaiMediaUri(url)) return { error: 'video must be an http(s) URL or image data URI' };
  normalized.video = { url, type: 'video_url' };
  delete normalized.video_url;
  return { body: normalized };
}

function normalizeXaiVideoEditBody(body: any): { body?: any; error?: string } {
  return normalizeXaiVideoSourceBody(body, 'edit');
}

function normalizeXaiVideoExtendBody(body: any): { body?: any; error?: string } {
  return normalizeXaiVideoSourceBody(body, 'extend');
}

function normalizeXaiImageBody(body: any): { body?: any; error?: string } {
  const normalized = { ...(body || {}) };
  normalized.model = typeof normalized.model === 'string' && normalized.model ? normalized.model : XAI_IMAGE_MODEL;
  const promptError = validateXaiPrompt(normalized.prompt);
  if (promptError) return { error: promptError };
  if (normalized.image?.url != null) {
    if (typeof normalized.image.url !== 'string' || !isValidXaiMediaUri(normalized.image.url.trim())) return { error: 'image.url must be an http(s) URL or image data URI' };
    normalized.image = { ...normalized.image, url: normalized.image.url.trim() };
  }
  if (typeof normalized.image_url === 'string') {
    const url = normalized.image_url.trim();
    if (!isValidXaiMediaUri(url)) return { error: 'image_url must be an http(s) URL or image data URI' };
    normalized.image_url = url;
  }
  return { body: normalized };
}

function normalizeXaiImageEditBody(body: any): { body?: any; error?: string; sourceImageCount?: number } {
  const normalized = { ...(body || {}) };
  normalized.model = typeof normalized.model === 'string' && normalized.model ? normalized.model : XAI_IMAGE_MODEL;
  const promptError = validateXaiPrompt(normalized.prompt);
  if (promptError) return { error: promptError };

  const sources: Array<{ url: string; type: 'image_url' }> = [];
  const addSource = (value: any, field: string): string | undefined => {
    let rawUrl: any;
    if (typeof value === 'string') rawUrl = value;
    else if (value && typeof value === 'object') rawUrl = value.url;
    else return `${field} must be an image URL or image object`;

    if (typeof rawUrl !== 'string') return `${field}.url must be an http(s) URL or image data URI`;
    const url = rawUrl.trim();
    if (!isValidXaiMediaUri(url)) return `${field} must be an http(s) URL or image data URI`;
    sources.push({ url, type: 'image_url' });
    return undefined;
  };

  if (normalized.image != null) {
    const error = addSource(normalized.image, 'image');
    if (error) return { error };
  }
  if (typeof normalized.image_url === 'string' && normalized.image_url.trim()) {
    const error = addSource(normalized.image_url, 'image_url');
    if (error) return { error };
  }
  if (normalized.images != null) {
    if (!Array.isArray(normalized.images)) return { error: 'images must be an array' };
    for (const image of normalized.images) {
      const error = addSource(image, 'images');
      if (error) return { error };
    }
  }

  if (sources.length === 0) return { error: 'image edit requires a source image' };
  if (sources.length > XAI_MAX_IMAGE_EDIT_SOURCE_IMAGES) return { error: 'image edits accept at most 3 source images' };

  delete normalized.image_url;
  delete normalized.images;
  if (sources.length === 1) {
    normalized.image = sources[0];
  } else {
    delete normalized.image;
    // Verified with xAI: multi-image edits use images[] with <IMAGE_0>, etc.
    normalized.images = sources;
  }

  return { body: normalized, sourceImageCount: sources.length };
}

function xaiUpstreamCostUsd(parsed: any): number | undefined {
  const rawTicks = parsed?.usage?.cost_in_usd_ticks ?? parsed?.cost_in_usd_ticks ?? parsed?.response?.usage?.cost_in_usd_ticks;
  const ticks = typeof rawTicks === 'number' ? rawTicks : typeof rawTicks === 'string' && rawTicks.trim() ? Number(rawTicks) : NaN;
  if (!Number.isFinite(ticks) || ticks <= 0) return undefined;
  // xAI reports image/edit cost in ticks where 1 tick = 1e-10 USD.
  // Treat upstream cost as authoritative to match xAI billing and avoid edit overcharges.
  return Math.round((ticks / 10_000_000_000) * 1_000_000) / 1_000_000;
}

function xaiResponseImageCount(parsed: any, body: any): number {
  const dataCount = Array.isArray(parsed?.data) ? parsed.data.length : 0;
  if (dataCount > 0) return dataCount;
  return Number.isFinite(Number(body?.n)) && Number(body.n) > 0 ? Math.floor(Number(body.n)) : 1;
}

function xaiInputImageCount(body: any): number {
  const image = body?.image;
  const images = body?.images;
  if (Array.isArray(image)) return image.length;
  if (image) return 1;
  if (Array.isArray(images)) return images.length;
  if (typeof body?.image_url === 'string' && body.image_url.trim()) return 1;
  return 0;
}

function sanitizeXaiMediaError(status: number, text: string): string {
  let code = 'upstream_error';
  try {
    const parsed = JSON.parse(text || '{}');
    const raw = parsed?.error?.type || parsed?.error?.code || parsed?.code || parsed?.type;
    if (typeof raw === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(raw)) code = raw;
  } catch {}
  return `xAI media upstream error (${status} ${code})`;
}

function xaiMediaLogMetadata(input: { endpoint: string; model: string; statusCode: number; imageCount?: number; durationSeconds?: number; requestId?: string; charCount?: number; voice?: string; bytesOut?: number; language?: string; textLength?: number }) {
  return {
    provider: 'xai',
    endpoint: input.endpoint,
    model: input.model,
    status: input.statusCode,
    imageCount: input.imageCount,
    durationSeconds: input.durationSeconds,
    requestId: input.requestId,
    charCount: input.charCount,
    voice: input.voice,
    bytesOut: input.bytesOut,
    language: input.language,
    textLength: input.textLength,
  };
}

type XaiVideoSubmitKind = 'generation' | 'edit' | 'extend';

async function forwardXaiJsonPost(req: any, reply: any, endpoint: string, defaultModel: string, allowedMediaModels: Set<string>, normalizeBody: (body: any) => { body?: any; error?: string; requestedDuration?: number; sourceImageCount?: number }, videoSubmitKind?: XaiVideoSubmitKind) {
  const auth = await requireProxyToken(req, reply);
  if (!auth) return;
  const started = Date.now();
  const normalized = normalizeBody(req.body as any);
  if (normalized.error || !normalized.body) {
    reply.code(400).send(openAiError(normalized.error || 'Invalid xAI media request body', 'invalid_request_error', 'invalid_request'));
    return;
  }
  const body = normalized.body;
  const model = typeof body.model === 'string' && body.model ? body.model : defaultModel;

  if (!allowedMediaModels.has(model)) {
    reply.code(400).send(modelNotAllowedForUserError(`Model ${model} is not allowed for xAI`));
    return;
  }
  const allowed = isModelAllowedForUser(auth.user, 'xai', model);
  if (!allowed.ok) {
    reply.code(400).send(modelNotAllowedForUserError(allowed.message));
    return;
  }
  body.model = model;

  const limit = checkLooseLimit(auth.user, 'xai', auth.token, model);
  if (!limit.ok) {
    reply.code(429).send(openAiError(limit.message, 'insufficient_quota', 'user_limit_exceeded'));
    return;
  }

  const inputEstimate = estimateInputTokens(body);
  const conversationId = String(req.headers['x-conversation-id'] || req.headers['session_id'] || req.headers['x-client-request-id'] || '');
  const stickyKey = `${auth.user.email}:${auth.token.label}:${conversationId || model || endpoint}`;
  const tried: number[] = [];
  let lastError = 'No xAI account available';
  let retryAfter = 60;

  for (let attempt = 0; attempt < 5; attempt++) {
    const selected = selectXaiAccount(stickyKey, tried);
    if (!selected) break;
    tried.push(selected.id);
    let account = selected;
    try {
      account = await ensureFreshXaiAccount(selected);
      const upstream = await fetch(`${config.xaiUpstreamUrl}${endpoint}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${account.secret}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ...xaiFetchDispatcher(model),
      });
      reply.header('x-gateway-provider', 'xai');
      reply.header('x-gateway-account', account.label);
      reply.header('x-gateway-attempt', String(attempt + 1));

      const text = await upstream.text().catch(() => '');
      if (upstream.status === 429) {
        const ms = retryAfterMs(upstream.headers.get('retry-after'));
        retryAfter = Math.max(1, Math.ceil(ms / 1000));
        markXaiCooldown(account.id, ms, `rate limited (${upstream.status})`);
        lastError = sanitizeXaiMediaError(upstream.status, text) || 'rate limited';
        recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'xai', endpoint: `/v1/xai${endpoint}`, model, stream: false, statusCode: upstream.status, inputTokens: inputEstimate, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
        continue;
      }

      if (upstream.status >= 400) {
        lastError = sanitizeXaiMediaError(upstream.status, text);
        if (isXaiOutOfQuotaError(upstream.status, text)) {
          markXaiCooldown(account.id, 6 * 60 * 60 * 1000, 'out_of_quota');
          recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'xai', endpoint: `/v1/xai${endpoint}`, model, stream: false, statusCode: upstream.status, inputTokens: inputEstimate, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
          retryAfter = Math.max(retryAfter, 60);
          continue;
        }
        recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'xai', endpoint: `/v1/xai${endpoint}`, model, stream: false, statusCode: upstream.status, inputTokens: inputEstimate, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
        reply.code(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(text || openAiError(lastError));
        return;
      }

      let usage = { inputTokens: inputEstimate, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
      let parsed: any = null;
      try {
        parsed = JSON.parse(text);
        const u = parsed?.usage;
        if (u) usage = {
          inputTokens: u.input_tokens ?? u.prompt_tokens ?? inputEstimate,
          outputTokens: u.output_tokens ?? u.completion_tokens ?? 0,
          cacheCreationTokens: 0,
          cacheReadTokens: u.input_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0,
        };
      } catch {}
      const isImage = endpoint.startsWith('/images/');
      const isVideo = endpoint.startsWith('/videos/');
      const isEdit = endpoint === '/images/edits';
      const imageCount = isImage ? xaiResponseImageCount(parsed, body) : undefined;
      const durationSeconds = isVideo ? (videoSubmitKind === 'edit' || videoSubmitKind === 'extend' ? XAI_DEFAULT_VIDEO_DURATION_SECONDS : billableXaiVideoDurationSeconds(normalized.requestedDuration)) : undefined;
      const requestId = isVideo && (typeof parsed?.request_id === 'string' || typeof parsed?.id === 'string') ? String(parsed.request_id || parsed.id) : undefined;
      // Generation submit-time billing is final. Edit/extend submit billing is
      // a floor; successful polls reconcile to authoritative xAI cost ticks.
      const fallbackImageCostUsd = () => estimateXaiMediaCost(model, { imageCount, durationSeconds, isEdit, inputImageCount: isEdit ? (normalized.sourceImageCount ?? xaiInputImageCount(body)) : 0 });
      const estimatedCostUsd = isVideo ? estimateXaiMediaCost(model, { durationSeconds }) : isImage ? (xaiUpstreamCostUsd(parsed) ?? fallbackImageCostUsd()) : fallbackImageCostUsd();
      const submitCostUsd = isVideo && (videoSubmitKind === 'edit' || videoSubmitKind === 'extend') ? estimatedCostUsd : undefined;
      if (requestId) recordXaiVideoJob(requestId, account.id, auth.user.id, auth.token.id, model, submitCostUsd);
      recordXaiSuccess(account.id);
      const usageEventId = recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'xai', endpoint: `/v1/xai${endpoint}`, model, stream: false, statusCode: upstream.status, ...usage, unit: isVideo ? 'videos' : 'images', estimatedCostUsd, latencyMs: Date.now() - started, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
      enforceAfterUsage(auth.user, 'xai', auth.token, model);
      if (shouldLogBody(auth.user)) {
        const metadata = xaiMediaLogMetadata({ endpoint: `/v1/xai${endpoint}`, model, statusCode: upstream.status, imageCount, durationSeconds, requestId });
        logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: metadata, responseText: JSON.stringify(metadata) });
      }
      reply.code(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(text);
      return;
    } catch (err: any) {
      const timedOut = isAbortTimeoutError(err);
      lastError = timedOut ? timeoutMessage(timeoutSeconds(REQUEST_TIMEOUT_MS)) : transientNetworkMessage('xai');
      if (!timedOut) markXaiCooldown(account.id, 60_000, `network error: ${err?.message || err}`);
      const statusCode = timedOut ? 504 : 502;
      recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'xai', endpoint: `/v1/xai${endpoint}`, model, stream: false, statusCode, inputTokens: inputEstimate, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
      if (timedOut) {
        reply.code(504).send(openAiError(lastError, 'timeout', 'gateway_timeout'));
        return;
      }
    }
  }

  reply.header('retry-after', String(retryAfter));
  reply.header('x-gateway-provider', 'xai');
  reply.code(429).send(openAiError(`xAI capacity unavailable: ${lastError}`, 'rate_limit_exceeded', 'rate_limit_exceeded'));
}

function normalizeXaiTtsBody(body: any): { body?: any; error?: string; charCount?: number; voice?: string } {
  const normalized = { ...((body as any) || {}) };
  if (typeof normalized.text !== 'string' || !normalized.text.trim()) return { error: 'text must be a non-empty string' };
  if (normalized.text.length > XAI_MAX_TTS_CHARS) return { error: 'text exceeds 15000 character limit' };
  const voice = String(normalized.voice_id || 'eve').toLowerCase();
  if (!XAI_TTS_ALLOWED_VOICES.has(voice)) return { error: 'invalid voice_id' };
  normalized.voice_id = voice;
  if (normalized.language == null) normalized.language = 'en';
  return { body: normalized, charCount: normalized.text.length, voice };
}

async function forwardXaiTts(req: any, reply: any) {
  const auth = await requireProxyToken(req, reply);
  if (!auth) return;
  const started = Date.now();
  const normalized = normalizeXaiTtsBody(req.body as any);
  if (normalized.error || !normalized.body) {
    reply.code(400).send(openAiError(normalized.error || 'Invalid xAI TTS request body', 'invalid_request_error', 'invalid_request'));
    return;
  }
  const body = normalized.body;
  const model = XAI_TTS_MODEL;

  const allowed = isModelAllowedForUser(auth.user, 'xai', model);
  if (!allowed.ok) {
    reply.code(400).send(modelNotAllowedForUserError(allowed.message));
    return;
  }
  const limit = checkLooseLimit(auth.user, 'xai', auth.token, model);
  if (!limit.ok) {
    reply.code(429).send(openAiError(limit.message, 'insufficient_quota', 'user_limit_exceeded'));
    return;
  }

  const conversationId = String(req.headers['x-conversation-id'] || req.headers['session_id'] || req.headers['x-client-request-id'] || '');
  const stickyKey = `${auth.user.email}:${auth.token.label}:${conversationId || model || 'tts'}`;
  const tried: number[] = [];
  let lastError = 'No xAI account available';
  let retryAfter = 60;

  for (let attempt = 0; attempt < 5; attempt++) {
    const selected = selectXaiAccount(stickyKey, tried);
    if (!selected) break;
    tried.push(selected.id);
    let account = selected;
    try {
      account = await ensureFreshXaiAccount(selected);
      const upstream = await fetch(`${config.xaiUpstreamUrl}/tts`, {
        method: 'POST',
        headers: { authorization: `Bearer ${account.secret}`, 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ...xaiFetchDispatcher(model),
      });
      reply.header('x-gateway-provider', 'xai');
      reply.header('x-gateway-account', account.label);
      reply.header('x-gateway-attempt', String(attempt + 1));

      if (upstream.status === 429) {
        const text = await upstream.text().catch(() => '');
        const ms = retryAfterMs(upstream.headers.get('retry-after'));
        retryAfter = Math.max(1, Math.ceil(ms / 1000));
        markXaiCooldown(account.id, ms, `rate limited (${upstream.status})`);
        lastError = sanitizeXaiMediaError(upstream.status, text) || 'rate limited';
        recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'xai', endpoint: '/v1/xai/tts', model, stream: false, statusCode: upstream.status, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
        continue;
      }

      if (upstream.status >= 400) {
        const text = await upstream.text().catch(() => '');
        lastError = sanitizeXaiMediaError(upstream.status, text);
        if (isXaiOutOfQuotaError(upstream.status, text)) {
          markXaiCooldown(account.id, 6 * 60 * 60 * 1000, 'out_of_quota');
          recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'xai', endpoint: '/v1/xai/tts', model, stream: false, statusCode: upstream.status, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
          retryAfter = Math.max(retryAfter, 60);
          continue;
        }
        recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'xai', endpoint: '/v1/xai/tts', model, stream: false, statusCode: upstream.status, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
        reply.code(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(text || openAiError(lastError));
        return;
      }

      const bytes = Buffer.from(await upstream.arrayBuffer());
      const estimatedCostUsd = estimateXaiTtsCost(normalized.charCount || 0);
      const ttsUnit = 'chars' as const;
      recordXaiSuccess(account.id);
      const usageEventId = recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'xai', endpoint: '/v1/xai/tts', model, stream: false, statusCode: upstream.status, inputTokens: 0, outputTokens: 0, unit: ttsUnit, estimatedCostUsd, latencyMs: Date.now() - started, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
      enforceAfterUsage(auth.user, 'xai', auth.token, model);
      if (shouldLogBody(auth.user)) {
        const metadata = xaiMediaLogMetadata({ endpoint: '/v1/xai/tts', model, statusCode: upstream.status, charCount: normalized.charCount, voice: normalized.voice, bytesOut: bytes.length });
        logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: metadata, responseText: JSON.stringify(metadata) });
      }
      reply.code(upstream.status).type(upstream.headers.get('content-type') || 'audio/mpeg').send(bytes);
      return;
    } catch (err: any) {
      const timedOut = isAbortTimeoutError(err);
      lastError = timedOut ? timeoutMessage(timeoutSeconds(REQUEST_TIMEOUT_MS)) : transientNetworkMessage('xai');
      if (!timedOut) markXaiCooldown(account.id, 60_000, `network error: ${err?.message || err}`);
      const statusCode = timedOut ? 504 : 502;
      recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'xai', endpoint: '/v1/xai/tts', model, stream: false, statusCode, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
      if (timedOut) {
        reply.code(504).send(openAiError(lastError, 'timeout', 'gateway_timeout'));
        return;
      }
    }
  }

  reply.header('retry-after', String(retryAfter));
  reply.header('x-gateway-provider', 'xai');
  reply.code(429).send(openAiError(`xAI capacity unavailable: ${lastError}`, 'rate_limit_exceeded', 'rate_limit_exceeded'));
}

function xaiSttUpstreamBody(req: any): { body: Buffer; contentType: string } {
  const contentType = String(req.headers['content-type'] || 'application/json');
  if (/^multipart\/form-data\b/i.test(contentType)) {
    return { body: Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || ''), contentType };
  }
  return { body: Buffer.from(JSON.stringify(req.body || {})), contentType };
}

async function forwardXaiStt(req: any, reply: any) {
  const auth = await requireProxyToken(req, reply);
  if (!auth) return;
  const started = Date.now();
  const model = XAI_STT_MODEL;

  const allowed = isModelAllowedForUser(auth.user, 'xai', model);
  if (!allowed.ok) {
    reply.code(400).send(modelNotAllowedForUserError(allowed.message));
    return;
  }
  const limit = checkLooseLimit(auth.user, 'xai', auth.token, model);
  if (!limit.ok) {
    reply.code(429).send(openAiError(limit.message, 'insufficient_quota', 'user_limit_exceeded'));
    return;
  }

  const upstreamBody = xaiSttUpstreamBody(req);
  const conversationId = String(req.headers['x-conversation-id'] || req.headers['session_id'] || req.headers['x-client-request-id'] || '');
  const stickyKey = `${auth.user.email}:${auth.token.label}:${conversationId || model || 'stt'}`;
  const tried: number[] = [];
  let lastError = 'No xAI account available';
  let retryAfter = 60;

  for (let attempt = 0; attempt < 5; attempt++) {
    const selected = selectXaiAccount(stickyKey, tried);
    if (!selected) break;
    tried.push(selected.id);
    let account = selected;
    try {
      account = await ensureFreshXaiAccount(selected);
      const upstream = await fetch(`${config.xaiUpstreamUrl}/stt`, {
        method: 'POST',
        headers: { authorization: `Bearer ${account.secret}`, 'content-type': upstreamBody.contentType, accept: 'application/json' },
        body: upstreamBody.body as any,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ...xaiFetchDispatcher(model),
      });
      reply.header('x-gateway-provider', 'xai');
      reply.header('x-gateway-account', account.label);
      reply.header('x-gateway-attempt', String(attempt + 1));

      const text = await upstream.text().catch(() => '');
      if (upstream.status === 429) {
        const ms = retryAfterMs(upstream.headers.get('retry-after'));
        retryAfter = Math.max(1, Math.ceil(ms / 1000));
        markXaiCooldown(account.id, ms, `rate limited (${upstream.status})`);
        lastError = sanitizeXaiMediaError(upstream.status, text) || 'rate limited';
        recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'xai', endpoint: '/v1/xai/stt', model, stream: false, statusCode: upstream.status, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
        continue;
      }

      if (upstream.status >= 400) {
        lastError = sanitizeXaiMediaError(upstream.status, text);
        if (isXaiOutOfQuotaError(upstream.status, text)) {
          markXaiCooldown(account.id, 6 * 60 * 60 * 1000, 'out_of_quota');
          recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'xai', endpoint: '/v1/xai/stt', model, stream: false, statusCode: upstream.status, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
          retryAfter = Math.max(retryAfter, 60);
          continue;
        }
        recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'xai', endpoint: '/v1/xai/stt', model, stream: false, statusCode: upstream.status, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
        reply.code(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(text || openAiError(lastError));
        return;
      }

      let parsed: any = null;
      try { parsed = JSON.parse(text || '{}'); } catch {}
      const duration = typeof parsed?.duration === 'number' && Number.isFinite(parsed.duration) ? parsed.duration : undefined;
      // xAI does not return audio cost fields. Missing duration cannot be billed
      // safely, so cost stays 0 and the warning marks the upstream anomaly.
      if (duration == null) req.log?.warn?.({ provider: 'xai', endpoint: '/v1/xai/stt' }, 'xAI STT response missing duration; usage cost recorded as 0');
      const estimatedCostUsd = duration == null ? 0 : estimateXaiSttCost(duration);
      const sttUnit = 'seconds' as const;
      recordXaiSuccess(account.id);
      const usageEventId = recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'xai', endpoint: '/v1/xai/stt', model, stream: false, statusCode: upstream.status, inputTokens: 0, outputTokens: 0, unit: sttUnit, estimatedCostUsd, latencyMs: Date.now() - started, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
      enforceAfterUsage(auth.user, 'xai', auth.token, model);
      if (shouldLogBody(auth.user)) {
        const metadata = xaiMediaLogMetadata({ endpoint: '/v1/xai/stt', model, statusCode: upstream.status, durationSeconds: duration, language: typeof parsed?.language === 'string' ? parsed.language : undefined, textLength: typeof parsed?.text === 'string' ? parsed.text.length : undefined });
        logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: metadata, responseText: JSON.stringify(metadata) });
      }
      reply.code(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(text);
      return;
    } catch (err: any) {
      const timedOut = isAbortTimeoutError(err);
      lastError = timedOut ? timeoutMessage(timeoutSeconds(REQUEST_TIMEOUT_MS)) : transientNetworkMessage('xai');
      if (!timedOut) markXaiCooldown(account.id, 60_000, `network error: ${err?.message || err}`);
      const statusCode = timedOut ? 504 : 502;
      recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'xai', endpoint: '/v1/xai/stt', model, stream: false, statusCode, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
      if (timedOut) {
        reply.code(504).send(openAiError(lastError, 'timeout', 'gateway_timeout'));
        return;
      }
    }
  }

  reply.header('retry-after', String(retryAfter));
  reply.header('x-gateway-provider', 'xai');
  reply.code(429).send(openAiError(`xAI capacity unavailable: ${lastError}`, 'rate_limit_exceeded', 'rate_limit_exceeded'));
}

function xaiQueryString(query: any): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query || {})) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const item of value) if (item != null) params.append(key, String(item));
    } else {
      params.append(key, String(value));
    }
  }
  const out = params.toString();
  return out ? `?${out}` : '';
}

async function forwardXaiRealtimeClientSecret(req: any, reply: any) {
  const auth = await requireProxyToken(req, reply);
  if (!auth) return;
  const started = Date.now();
  const body = { ...((req.body as any) || {}) };
  const requestedModel = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : XAI_REALTIME_DEFAULT_UPSTREAM_MODEL;
  const model = XAI_REALTIME_MODELS.has(requestedModel) ? requestedModel : XAI_REALTIME_MODEL;
  if (!body.model) body.model = XAI_REALTIME_DEFAULT_UPSTREAM_MODEL;

  const allowed = isModelAllowedForUser(auth.user, 'xai', model);
  if (!allowed.ok) {
    reply.code(400).send(modelNotAllowedForUserError(allowed.message));
    return;
  }
  const limit = checkLooseLimit(auth.user, 'xai', auth.token, model);
  if (!limit.ok) {
    reply.code(429).send(openAiError(limit.message, 'insufficient_quota', 'user_limit_exceeded'));
    return;
  }

  const conversationId = String(req.headers['x-conversation-id'] || req.headers['session_id'] || req.headers['x-client-request-id'] || '');
  const stickyKey = `${auth.user.email}:${auth.token.label}:${conversationId || model || 'realtime-client-secret'}`;
  const tried: number[] = [];
  let lastError = 'No xAI account available';
  let retryAfter = 60;

  for (let attempt = 0; attempt < 5; attempt++) {
    const selected = selectXaiAccount(stickyKey, tried);
    if (!selected) break;
    tried.push(selected.id);
    let account = selected;
    try {
      account = await ensureFreshXaiAccount(selected);
      const upstream = await fetch(`${config.xaiUpstreamUrl}/realtime/client_secrets`, {
        method: 'POST',
        headers: { authorization: `Bearer ${account.secret}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ...xaiFetchDispatcher(model),
      });
      reply.header('x-gateway-provider', 'xai');
      reply.header('x-gateway-account', account.label);
      reply.header('x-gateway-attempt', String(attempt + 1));

      const text = await upstream.text().catch(() => '');
      if (upstream.status === 429) {
        const ms = retryAfterMs(upstream.headers.get('retry-after'));
        retryAfter = Math.max(1, Math.ceil(ms / 1000));
        markXaiCooldown(account.id, ms, `rate limited (${upstream.status})`);
        lastError = sanitizeXaiMediaError(upstream.status, text) || 'rate limited';
        recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'xai', endpoint: '/v1/xai/realtime/client_secrets', model, stream: false, statusCode: upstream.status, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
        continue;
      }

      if (upstream.status >= 400) {
        lastError = sanitizeXaiMediaError(upstream.status, text);
        if (isXaiOutOfQuotaError(upstream.status, text)) {
          markXaiCooldown(account.id, 6 * 60 * 60 * 1000, 'out_of_quota');
          recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'xai', endpoint: '/v1/xai/realtime/client_secrets', model, stream: false, statusCode: upstream.status, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
          retryAfter = Math.max(retryAfter, 60);
          continue;
        }
        recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'xai', endpoint: '/v1/xai/realtime/client_secrets', model, stream: false, statusCode: upstream.status, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
        reply.code(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(text || openAiError(lastError));
        return;
      }

      let parsed: any = null;
      try { parsed = JSON.parse(text || '{}'); } catch {}
      recordXaiSuccess(account.id);
      // This only mints an ephemeral client secret. The realtime voice session
      // happens client<->xAI over WebSocket, is unmetered by this gateway, and
      // is billed directly to the upstream xAI account.
      const usageEventId = recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'xai', endpoint: '/v1/xai/realtime/client_secrets', model, stream: false, statusCode: upstream.status, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
      enforceAfterUsage(auth.user, 'xai', auth.token, model);
      req.log?.info?.({ provider: 'xai', endpoint: '/v1/xai/realtime/client_secrets', model, expires_at: parsed?.expires_at }, 'xAI realtime client secret minted; realtime voice usage is unmetered by gateway');
      if (shouldLogBody(auth.user)) {
        const metadata = { provider: 'xai', endpoint: '/v1/xai/realtime/client_secrets', model, status: upstream.status, requestedModel, voice: typeof body.voice === 'string' ? body.voice : undefined, expires_at: parsed?.expires_at, realtimeUsageMeteredByGateway: false };
        logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: metadata, responseText: JSON.stringify(metadata) });
      }
      reply.code(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(text);
      return;
    } catch (err: any) {
      const timedOut = isAbortTimeoutError(err);
      lastError = timedOut ? timeoutMessage(timeoutSeconds(REQUEST_TIMEOUT_MS)) : transientNetworkMessage('xai');
      if (!timedOut) markXaiCooldown(account.id, 60_000, `network error: ${err?.message || err}`);
      const statusCode = timedOut ? 504 : 502;
      recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'xai', endpoint: '/v1/xai/realtime/client_secrets', model, stream: false, statusCode, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
      if (timedOut) {
        reply.code(504).send(openAiError(lastError, 'timeout', 'gateway_timeout'));
        return;
      }
    }
  }

  reply.header('retry-after', String(retryAfter));
  reply.header('x-gateway-provider', 'xai');
  reply.code(429).send(openAiError(`xAI capacity unavailable: ${lastError}`, 'rate_limit_exceeded', 'rate_limit_exceeded'));
}

async function forwardXaiFiles(req: any, reply: any, method: 'POST' | 'GET' | 'DELETE', id?: string) {
  const auth = await requireProxyToken(req, reply);
  if (!auth) return;
  const started = Date.now();
  const model = XAI_FILES_MODEL;

  const allowed = isModelAllowedForUser(auth.user, 'xai', model);
  if (!allowed.ok) {
    reply.code(400).send(modelNotAllowedForUserError(allowed.message));
    return;
  }
  const limit = checkLooseLimit(auth.user, 'xai', auth.token, model);
  if (!limit.ok) {
    reply.code(429).send(openAiError(limit.message, 'insufficient_quota', 'user_limit_exceeded'));
    return;
  }

  const contentType = String(req.headers['content-type'] || '');
  if (method === 'POST' && !/^multipart\/form-data\b/i.test(contentType)) {
    reply.code(400).send(openAiError('xAI file upload requires multipart/form-data', 'invalid_request_error', 'invalid_request'));
    return;
  }

  const endpoint = id ? '/v1/xai/files/:id' : '/v1/xai/files';
  const upstreamPath = id ? `/files/${encodeURIComponent(id)}` : `/files${method === 'GET' ? xaiQueryString(req.query) : ''}`;
  const stickyKey = `${auth.user.email}:${auth.token.label}:${id || 'files'}`;
  const tried: number[] = [];
  let lastError = 'No xAI account available';
  let retryAfter = 60;

  for (let attempt = 0; attempt < 5; attempt++) {
    const selected = selectXaiAccount(stickyKey, tried);
    if (!selected) break;
    tried.push(selected.id);
    let account = selected;
    try {
      account = await ensureFreshXaiAccount(selected);
      const headers: Record<string, string> = { authorization: `Bearer ${account.secret}`, accept: 'application/json' };
      let body: any;
      if (method === 'POST') {
        headers['content-type'] = contentType;
        body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
      }
      const upstream = await fetch(`${config.xaiUpstreamUrl}${upstreamPath}`, { method, headers, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...xaiFetchDispatcher(model) });
      reply.header('x-gateway-provider', 'xai');
      reply.header('x-gateway-account', account.label);
      reply.header('x-gateway-attempt', String(attempt + 1));

      const text = await upstream.text().catch(() => '');
      if (upstream.status === 429) {
        const ms = retryAfterMs(upstream.headers.get('retry-after'));
        retryAfter = Math.max(1, Math.ceil(ms / 1000));
        markXaiCooldown(account.id, ms, `rate limited (${upstream.status})`);
        lastError = sanitizeXaiMediaError(upstream.status, text) || 'rate limited';
        recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'xai', endpoint, model, stream: false, statusCode: upstream.status, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
        continue;
      }

      if (upstream.status >= 400) {
        lastError = sanitizeXaiMediaError(upstream.status, text);
        if (isXaiOutOfQuotaError(upstream.status, text)) {
          markXaiCooldown(account.id, 6 * 60 * 60 * 1000, 'out_of_quota');
          recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'xai', endpoint, model, stream: false, statusCode: upstream.status, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
          retryAfter = Math.max(retryAfter, 60);
          continue;
        }
        recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'xai', endpoint, model, stream: false, statusCode: upstream.status, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
        reply.code(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(text || openAiError(lastError));
        return;
      }

      let parsed: any = null;
      try { parsed = JSON.parse(text || '{}'); } catch {}
      recordXaiSuccess(account.id);
      // xAI Files operations are storage/account-level operations: no per-op
      // gateway price is known, so the gateway records $0. Upstream xAI may
      // still bill storage to the provider account outside this gateway.
      const usageEventId = recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'xai', endpoint, model, stream: false, statusCode: upstream.status, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
      enforceAfterUsage(auth.user, 'xai', auth.token, model);
      if (shouldLogBody(auth.user)) {
        const metadata = { provider: 'xai', endpoint, model, status: upstream.status, method, fileId: id || parsed?.id, filename: parsed?.filename, bytes: parsed?.bytes, object: parsed?.object, deleted: parsed?.deleted, count: Array.isArray(parsed?.data) ? parsed.data.length : undefined, storageMayBeBilledByXai: true };
        logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: metadata, responseText: JSON.stringify(metadata) });
      }
      reply.code(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(text);
      return;
    } catch (err: any) {
      const timedOut = isAbortTimeoutError(err);
      lastError = timedOut ? timeoutMessage(timeoutSeconds(REQUEST_TIMEOUT_MS)) : transientNetworkMessage('xai');
      if (!timedOut) markXaiCooldown(account.id, 60_000, `network error: ${err?.message || err}`);
      const statusCode = timedOut ? 504 : 502;
      recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'xai', endpoint, model, stream: false, statusCode, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
      if (timedOut) {
        reply.code(504).send(openAiError(lastError, 'timeout', 'gateway_timeout'));
        return;
      }
    }
  }

  reply.header('retry-after', String(retryAfter));
  reply.header('x-gateway-provider', 'xai');
  reply.code(429).send(openAiError(`xAI capacity unavailable: ${lastError}`, 'rate_limit_exceeded', 'rate_limit_exceeded'));
}

function xaiBatchLogMetadata(input: { endpoint: string; method: 'POST' | 'GET'; statusCode: number; id?: string; parsed?: any }) {
  const state = input.parsed?.state || {};
  return {
    provider: 'xai',
    endpoint: input.endpoint,
    model: XAI_BATCH_MODEL,
    status: input.statusCode,
    method: input.method,
    batchId: input.id || input.parsed?.batch_id,
    batchCount: Array.isArray(input.parsed?.batches) ? input.parsed.batches.length : undefined,
    resultCount: Array.isArray(input.parsed?.results) ? input.parsed.results.length : undefined,
    numRequests: state.num_requests,
    numPending: state.num_pending,
    numSuccess: state.num_success,
    numError: state.num_error,
    numCancelled: state.num_cancelled,
    batchInferenceMeteredByGateway: false,
    billedByXaiAccount: true,
  };
}

async function forwardXaiBatch(req: any, reply: any, method: 'POST' | 'GET', endpoint: string, upstreamPath: string, id?: string) {
  const auth = await requireProxyToken(req, reply);
  if (!auth) return;
  const started = Date.now();
  const model = XAI_BATCH_MODEL;

  const allowed = isModelAllowedForUser(auth.user, 'xai', model);
  if (!allowed.ok) {
    reply.code(400).send(modelNotAllowedForUserError(allowed.message));
    return;
  }
  const limit = checkLooseLimit(auth.user, 'xai', auth.token, model);
  if (!limit.ok) {
    reply.code(429).send(openAiError(limit.message, 'insufficient_quota', 'user_limit_exceeded'));
    return;
  }

  let affinityAccount = null as ReturnType<typeof getXaiBatchJobAccount>;
  if (id) {
    // xAI batch IDs are account-scoped. Only operate on batches created by
    // this token's user; never fall back to another upstream account.
    affinityAccount = getXaiBatchJobAccount(id, auth.user.id);
    if (!affinityAccount) {
      reply.code(404).send(openAiError('batch not found for this token', 'invalid_request_error', 'not_found'));
      return;
    }
    if (!(affinityAccount as any).enabled || !affinityAccount.secret || ['dead','disabled','invalid','refresh_failed'].includes((affinityAccount as any).status) || (((affinityAccount as any).cooldown_until || 0) > Date.now())) {
      recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: affinityAccount.id, provider: 'xai', endpoint, model, stream: false, statusCode: 503, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: 'account unavailable for this batch job', ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: affinityAccount.label });
      reply.code(503).send(openAiError('xAI account unavailable for this batch job', 'server_error', 'account_unavailable'));
      return;
    }
  } else if (method === 'GET' && endpoint === '/v1/xai/batches') {
    // Listing is account-scoped upstream; selecting any enabled account is
    // acceptable and returns batches visible to that selected xAI account.
  }

  const stickyKey = `${auth.user.email}:${auth.token.label}:${id || endpoint}`;
  const tried: number[] = [];
  let lastError = 'No xAI account available';
  let retryAfter = 60;

  for (let attempt = 0; attempt < 5; attempt++) {
    const selected = affinityAccount || selectXaiAccount(stickyKey, tried);
    if (!selected) break;
    tried.push(selected.id);
    let account = selected;
    try {
      account = await ensureFreshXaiAccount(selected);
      const headers: Record<string, string> = { authorization: `Bearer ${account.secret}`, accept: 'application/json' };
      const body = method === 'POST' ? JSON.stringify((req.body as any) ?? {}) : undefined;
      if (method === 'POST') headers['content-type'] = 'application/json';
      const upstream = await fetch(`${config.xaiUpstreamUrl}${upstreamPath}`, { method, headers, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...xaiFetchDispatcher(model) });
      reply.header('x-gateway-provider', 'xai');
      reply.header('x-gateway-account', account.label);
      reply.header('x-gateway-attempt', String(attempt + 1));

      const text = await upstream.text().catch(() => '');
      if (upstream.status === 429) {
        const ms = retryAfterMs(upstream.headers.get('retry-after'));
        retryAfter = Math.max(1, Math.ceil(ms / 1000));
        markXaiCooldown(account.id, ms, `rate limited (${upstream.status})`);
        lastError = sanitizeXaiMediaError(upstream.status, text) || 'rate limited';
        recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'xai', endpoint, model, stream: false, statusCode: upstream.status, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
        if (affinityAccount) {
          reply.code(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(text || openAiError(lastError));
          return;
        }
        continue;
      }

      if (upstream.status >= 400) {
        lastError = sanitizeXaiMediaError(upstream.status, text);
        if (isXaiOutOfQuotaError(upstream.status, text)) {
          markXaiCooldown(account.id, 6 * 60 * 60 * 1000, 'out_of_quota');
          recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'xai', endpoint, model, stream: false, statusCode: upstream.status, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
          if (affinityAccount) {
            reply.code(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(text || openAiError(lastError));
            return;
          }
          retryAfter = Math.max(retryAfter, 60);
          continue;
        }
        recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'xai', endpoint, model, stream: false, statusCode: upstream.status, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
        reply.code(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(text || openAiError(lastError));
        return;
      }

      let parsed: any = null;
      if (text) { try { parsed = JSON.parse(text); } catch {} }
      if (!id && method === 'POST' && endpoint === '/v1/xai/batches' && typeof parsed?.batch_id === 'string') {
        recordXaiBatchJob(parsed.batch_id, account.id, auth.user.id, auth.token.id);
      }
      recordXaiSuccess(account.id);
      // xAI Batch is a thin auth-gated passthrough. The gateway records $0 for
      // batch container/request/result operations; actual batched inference is
      // billed by xAI directly to the upstream account and is not attributed per
      // user here without a separate reconcile loop.
      const usageEventId = recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'xai', endpoint, model, stream: false, statusCode: upstream.status, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
      enforceAfterUsage(auth.user, 'xai', auth.token, model);
      const metadata = xaiBatchLogMetadata({ endpoint, method, statusCode: upstream.status, id, parsed });
      req.log?.info?.(metadata, 'xAI batch API proxied; batch inference usage is not metered per-user by gateway and is billed at the xAI account level');
      if (shouldLogBody(auth.user)) {
        logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: metadata, responseText: JSON.stringify(metadata) });
      }
      if (!text) {
        reply.code(upstream.status).send();
        return;
      }
      reply.code(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(text);
      return;
    } catch (err: any) {
      const timedOut = isAbortTimeoutError(err);
      lastError = timedOut ? timeoutMessage(timeoutSeconds(REQUEST_TIMEOUT_MS)) : transientNetworkMessage('xai');
      if (!timedOut) markXaiCooldown(account.id, 60_000, `network error: ${err?.message || err}`);
      const statusCode = timedOut ? 504 : 502;
      recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'xai', endpoint, model, stream: false, statusCode, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
      if (timedOut) {
        reply.code(504).send(openAiError(lastError, 'timeout', 'gateway_timeout'));
        return;
      }
      if (affinityAccount) {
        reply.code(502).send(openAiError(lastError, 'server_error', 'bad_gateway'));
        return;
      }
    }
  }

  reply.header('retry-after', String(retryAfter));
  reply.header('x-gateway-provider', 'xai');
  reply.code(429).send(openAiError(`xAI capacity unavailable: ${lastError}`, 'rate_limit_exceeded', 'rate_limit_exceeded'));
}

async function forwardXaiVideoStatus(req: any, reply: any) {
  const auth = await requireProxyToken(req, reply);
  if (!auth) return;
  const started = Date.now();
  const requestId = String(req.params?.requestId || '').trim();
  if (!requestId || !/^[A-Za-z0-9_:-]+$/.test(requestId)) {
    reply.code(400).send(openAiError('Invalid xAI video request id', 'invalid_request_error', 'invalid_request'));
    return;
  }
  // xAI video request IDs are account-scoped and media URLs are private user data.
  // Only poll jobs submitted by this user; never fall back to another account.
  const selected = getXaiVideoJobAccount(requestId, auth.user.id);
  if (!selected) {
    reply.code(404).send(openAiError('xAI video request not found', 'invalid_request_error', 'not_found'));
    return;
  }
  const model = selected.job_model || XAI_VIDEO_MODEL;
  if (!KNOWN_XAI_VIDEO_MODELS.has(model)) {
    reply.code(400).send(modelNotAllowedForUserError(`Model ${model} is not allowed for xAI video`));
    return;
  }
  const allowed = isModelAllowedForUser(auth.user, 'xai', model);
  if (!allowed.ok) {
    reply.code(400).send(modelNotAllowedForUserError(allowed.message));
    return;
  }
  if (!(selected as any).enabled || !selected.secret || ['dead','disabled','invalid','refresh_failed'].includes((selected as any).status) || (((selected as any).cooldown_until || 0) > Date.now())) {
    recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: selected.id, provider: 'xai', endpoint: '/v1/xai/videos/:requestId', model, stream: false, statusCode: 503, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: 'account unavailable for this video job', ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: selected.label });
    reply.code(503).send(openAiError('xAI account unavailable for this video job', 'server_error', 'account_unavailable'));
    return;
  }
  let account = selected;
  try {
    account = await ensureFreshXaiAccount(selected);
    const upstream = await fetch(`${config.xaiUpstreamUrl}/videos/${encodeURIComponent(requestId)}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${account.secret}`, accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...xaiFetchDispatcher(model),
    });
    const text = await upstream.text().catch(() => '');
    reply.header('x-gateway-provider', 'xai');
    reply.header('x-gateway-account', account.label);
    if (upstream.ok) recordXaiSuccess(account.id);
    if (upstream.status === 429) markXaiCooldown(account.id, retryAfterMs(upstream.headers.get('retry-after')), `rate limited (${upstream.status})`);
    else if (isXaiOutOfQuotaError(upstream.status, text)) markXaiCooldown(account.id, 6 * 60 * 60 * 1000, 'out_of_quota');
    const usageEventId = recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'xai', endpoint: '/v1/xai/videos/:requestId', model, stream: false, statusCode: upstream.status, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: upstream.status >= 400 ? sanitizeXaiMediaError(upstream.status, text) : undefined, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
    if (upstream.ok && selected.job_submit_cost_usd != null && Number.isFinite(Number(selected.job_submit_cost_usd)) && Number(selected.job_submit_cost_usd) >= 0 && !Number(selected.job_trued_up || 0)) {
      let parsed: any = null;
      try { parsed = JSON.parse(text); } catch {}
      const actualCostUsd = parsed?.status === 'done' ? xaiUpstreamCostUsd(parsed) : undefined;
      if (actualCostUsd != null) {
        const submitCostUsd = Number(selected.job_submit_cost_usd);
        const deltaUsd = Math.max(0, actualCostUsd - submitCostUsd);
        if (markXaiVideoJobTruedUp(requestId, auth.user.id) && deltaUsd > 0) {
          recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'xai', endpoint: '/v1/xai/videos/:reconcile', model, stream: false, statusCode: upstream.status, inputTokens: 0, outputTokens: 0, estimatedCostUsd: deltaUsd, latencyMs: Date.now() - started, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
        }
      }
    }
    enforceAfterUsage(auth.user, 'xai', auth.token, model);
    if (shouldLogBody(auth.user)) {
      const metadata = xaiMediaLogMetadata({ endpoint: '/v1/xai/videos/:requestId', model, statusCode: upstream.status, requestId });
      logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: metadata, responseText: JSON.stringify(metadata) });
    }
    reply.code(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(text);
  } catch (err: any) {
    const timedOut = isAbortTimeoutError(err);
    const statusCode = timedOut ? 504 : 502;
    recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'xai', endpoint: '/v1/xai/videos/:requestId', model, stream: false, statusCode, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: timedOut ? timeoutMessage(timeoutSeconds(REQUEST_TIMEOUT_MS)) : transientNetworkMessage('xai'), ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
    reply.code(timedOut ? 504 : 502).send(openAiError(timedOut ? timeoutMessage(timeoutSeconds(REQUEST_TIMEOUT_MS)) : transientNetworkMessage('xai'), timedOut ? 'timeout' : 'server_error', timedOut ? 'gateway_timeout' : 'bad_gateway'));
  }
}

export function registerXaiProxy(app: FastifyInstance) {
  if (!app.hasContentTypeParser('multipart/form-data')) {
    app.addContentTypeParser('multipart/form-data', { parseAs: 'buffer', bodyLimit: XAI_STT_BODY_LIMIT_BYTES }, (_req, body, done) => done(null, body));
  }
  app.post('/v1/xai/responses', (req, reply) => forwardXaiResponses(req, reply));
  app.post('/v1/xai/realtime/client_secrets', (req, reply) => forwardXaiRealtimeClientSecret(req, reply));
  app.post('/v1/xai/tts', { bodyLimit: XAI_MEDIA_BODY_LIMIT_BYTES }, (req, reply) => forwardXaiTts(req, reply));
  app.post('/v1/xai/stt', { bodyLimit: XAI_STT_BODY_LIMIT_BYTES }, (req, reply) => forwardXaiStt(req, reply));
  app.post('/v1/xai/files', { bodyLimit: XAI_FILES_BODY_LIMIT_BYTES }, (req, reply) => forwardXaiFiles(req, reply, 'POST'));
  app.get('/v1/xai/files', (req, reply) => forwardXaiFiles(req, reply, 'GET'));
  app.get('/v1/xai/files/:id', (req, reply) => forwardXaiFiles(req, reply, 'GET', String((req.params as any)?.id || '')));
  app.delete('/v1/xai/files/:id', (req, reply) => forwardXaiFiles(req, reply, 'DELETE', String((req.params as any)?.id || '')));
  app.post('/v1/xai/batches', { bodyLimit: XAI_BATCH_BODY_LIMIT_BYTES }, (req, reply) => forwardXaiBatch(req, reply, 'POST', '/v1/xai/batches', '/batches'));
  app.get('/v1/xai/batches', (req, reply) => forwardXaiBatch(req, reply, 'GET', '/v1/xai/batches', `/batches${xaiQueryString(req.query)}`));
  app.get('/v1/xai/batches/:id', (req, reply) => {
    const id = String((req.params as any)?.id || '');
    return forwardXaiBatch(req, reply, 'GET', '/v1/xai/batches/:id', `/batches/${encodeURIComponent(id)}`, id);
  });
  app.post('/v1/xai/batches/:id', { bodyLimit: XAI_BATCH_BODY_LIMIT_BYTES }, (req, reply) => {
    const id = String((req.params as any)?.id || '');
    return forwardXaiBatch(req, reply, 'POST', '/v1/xai/batches/:id', `/batches/${encodeURIComponent(id)}`, id);
  });
  app.post('/v1/xai/batches/:id/requests', { bodyLimit: XAI_BATCH_BODY_LIMIT_BYTES }, (req, reply) => {
    const id = String((req.params as any)?.id || '');
    return forwardXaiBatch(req, reply, 'POST', '/v1/xai/batches/:id/requests', `/batches/${encodeURIComponent(id)}/requests`, id);
  });
  app.get('/v1/xai/batches/:id/results', (req, reply) => {
    const id = String((req.params as any)?.id || '');
    return forwardXaiBatch(req, reply, 'GET', '/v1/xai/batches/:id/results', `/batches/${encodeURIComponent(id)}/results${xaiQueryString(req.query)}`, id);
  });
  app.post('/v1/xai/images/generations', { bodyLimit: XAI_MEDIA_BODY_LIMIT_BYTES }, (req, reply) => forwardXaiJsonPost(req, reply, '/images/generations', XAI_IMAGE_MODEL, KNOWN_XAI_IMAGE_MODELS, normalizeXaiImageBody));
  app.post('/v1/xai/images/edits', { bodyLimit: XAI_MEDIA_BODY_LIMIT_BYTES }, (req, reply) => forwardXaiJsonPost(req, reply, '/images/edits', XAI_IMAGE_MODEL, KNOWN_XAI_IMAGE_MODELS, normalizeXaiImageEditBody));
  app.post('/v1/xai/videos/generations', { bodyLimit: XAI_MEDIA_BODY_LIMIT_BYTES }, (req, reply) => forwardXaiJsonPost(req, reply, '/videos/generations', XAI_VIDEO_MODEL, KNOWN_XAI_VIDEO_MODELS, normalizeXaiVideoBody, 'generation'));
  app.post('/v1/xai/videos/edits', { bodyLimit: XAI_MEDIA_BODY_LIMIT_BYTES }, (req, reply) => forwardXaiJsonPost(req, reply, '/videos/edits', XAI_VIDEO_ADVANCED_MODEL, KNOWN_XAI_VIDEO_MODELS, normalizeXaiVideoEditBody, 'edit'));
  app.post('/v1/xai/videos/extensions', { bodyLimit: XAI_MEDIA_BODY_LIMIT_BYTES }, (req, reply) => forwardXaiJsonPost(req, reply, '/videos/extensions', XAI_VIDEO_ADVANCED_MODEL, KNOWN_XAI_VIDEO_MODELS, normalizeXaiVideoExtendBody, 'extend'));
  app.get('/v1/xai/videos/:requestId', (req, reply) => forwardXaiVideoStatus(req, reply));
}
