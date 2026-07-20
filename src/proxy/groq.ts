import type { FastifyInstance } from 'fastify';
import { writeRawResponseHead } from '../http/response-headers.js';
import { config } from '../config.js';
import { requireProxyToken } from '../auth/token-auth.js';
import { recordUsage } from './usage.js';
import { compressionFields } from './compress.js';
import { checkLooseLimit, enforceAfterUsage, isModelAllowedForUser, logRequestResponse, shouldLogBody } from './policy.js';
import { estimateCost } from './cost.js';
import { DEFAULT_GROQ_MODEL, KNOWN_GROQ_MODELS, markGroqAccountCooldown, markGroqCooldown, recordGroqRequest, selectGroqAccountForModel } from '../providers/groq-pool.js';
import { catalogModelIdsWithCapability } from '../providers/model-catalog.js';
import { isAbortTimeoutError, isModelUnavailableError, modelUnavailableError, surfaceOpenAiCompatError, surfaceOpenAiCompatStreamChunk, timeoutMessage, timeoutSeconds, transientNetworkMessage, type OpenAiCompatStreamState } from './openai-compat-errors.js';

const REQUEST_TIMEOUT_MS = 20 * 60 * 1000;
const KNOWN_GROQ_AUDIO_MODELS = new Set(catalogModelIdsWithCapability('groq', 'speech-to-text'));
const DEFAULT_GROQ_AUDIO_MODEL = 'whisper-large-v3';


// Groq returns HTTP 400 with body `blocked_api_access` when the account hits
// its monthly spend limit (resets 1st of month). This is account-wide and
// retryable on a different pool account, NOT a generic 400.
export function isGroqBlockedApiAccess(status: number, body: string): boolean {
  return status === 400 && /blocked_api_access/i.test(body || '');
}

function openAiError(message: string, type = 'server_error', code?: string) {
  return { error: { message, type, code: code || null } };
}

function modelNotAllowedForUserError(message: string) {
  return { type: 'error', error: { type: 'invalid_request_error', code: 'model_not_allowed_for_user', message } };
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
      cacheReadTokens: u.input_tokens_details?.cached_tokens ?? 0,
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
        cacheReadTokens: u.input_tokens_details?.cached_tokens ?? state.usage.cacheReadTokens ?? 0,
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

async function forwardGroq(req: any, reply: any, endpoint: '/chat/completions' | '/embeddings') {
  const auth = await requireProxyToken(req, reply);
  if (!auth) return;
  const started = Date.now();

  const body = { ...((req.body as any) || {}) };
  const rawModel = typeof body.model === 'string' && body.model ? body.model : undefined;
  const requestedModel = rawModel || DEFAULT_GROQ_MODEL;
  const model = KNOWN_GROQ_MODELS.has(requestedModel) ? requestedModel : DEFAULT_GROQ_MODEL;
  const fallbackFrom = model !== requestedModel ? requestedModel : '';
  const allowed = isModelAllowedForUser(auth.user, 'groq', model);
  if (!allowed.ok) {
    reply.code(400).send(modelNotAllowedForUserError(allowed.message));
    return;
  }
  body.model = model;
  const limit = checkLooseLimit(auth.user, 'groq', auth.token, model);
  if (!limit.ok) {
    reply.code(429).send(openAiError(limit.message, 'insufficient_quota', 'user_limit_exceeded'));
    return;
  }
  const stream = !!body.stream && endpoint === '/chat/completions';
  const inputEstimate = estimateInputTokens(body);
  const conversationId = String(req.headers['x-conversation-id'] || req.headers['session_id'] || req.headers['x-client-request-id'] || body?.conversation_id || '');
  const stickyKey = `${auth.user.email}:${auth.token.label}:${conversationId || model || endpoint}`;
  const tried: number[] = [];
  let lastError = 'No Groq account available';
  let retryAfter = 60;

  for (let attempt = 0; attempt < 10; attempt++) {
    const account = selectGroqAccountForModel(model, stickyKey, inputEstimate, tried);
    if (!account) break;
    tried.push(account.id);
    try {
      const upstream = await fetch(`${config.groqUpstreamUrl}${endpoint}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${account.secret}`, 'content-type': 'application/json', accept: stream ? 'text/event-stream' : 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      reply.header('x-gateway-provider', 'groq');
      reply.header('x-gateway-account', account.label);
      reply.header('x-gateway-attempt', String(attempt + 1));
      if (fallbackFrom) reply.header('x-gateway-groq-fallback', fallbackFrom);

      if (upstream.status === 429) {
        const text = await upstream.text().catch(() => '');
        const ms = retryAfterMs(upstream.headers.get('retry-after'));
        retryAfter = Math.max(1, Math.ceil(ms / 1000));
        markGroqCooldown(account.id, model, ms, `rate limited (${upstream.status})`);
        req.log?.info?.({ provider: 'groq', account: account.label, model, attempt: attempt + 1 }, 'Groq rate limited; switching to another account');
        recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'groq', endpoint: `/v1/groq${endpoint}`, model, stream, statusCode: upstream.status, inputTokens: inputEstimate, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: text.slice(0, 500) || 'rate limited', ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
        lastError = text.slice(0, 500) || 'rate limited';
        continue;
      }

      if (upstream.status >= 400) {
        const text = await upstream.text().catch(() => '');
        lastError = text.slice(0, 500) || String(upstream.status);
        if (isModelUnavailableError(upstream.status, text)) {
          const clean = modelUnavailableError('groq', model);
          lastError = clean.error.message;
          recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'groq', endpoint: `/v1/groq${endpoint}`, model, stream, statusCode: upstream.status, inputTokens: inputEstimate, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
          reply.code(400).send(clean);
          return;
        }
        // Groq spend-limit / blocked_api_access — account-wide, retryable.
        if (isGroqBlockedApiAccess(upstream.status, text)) {
          const cooldownMs = 24 * 60 * 60 * 1000; // 24h — Groq monthly spend resets on 1st of month, this is conservative
          markGroqAccountCooldown(account.id, cooldownMs, 'blocked_api_access');
          req.log?.info?.({ provider: 'groq', account: account.label, model, attempt: attempt + 1 }, 'Groq account hit blocked_api_access (spend limit); switching to another account');
          recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'groq', endpoint: `/v1/groq${endpoint}`, model, stream, statusCode: upstream.status, inputTokens: inputEstimate, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
          retryAfter = Math.max(retryAfter, 60);
          continue;
        }
        recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'groq', endpoint: `/v1/groq${endpoint}`, model, stream, statusCode: upstream.status, inputTokens: inputEstimate, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
        reply.code(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(text || openAiError(lastError));
        return;
      }

      if (stream && upstream.body) {
        writeRawResponseHead(reply, upstream.status, { 'content-type': upstream.headers.get('content-type') || 'text/event-stream', 'cache-control': 'no-cache', 'x-gateway-provider': 'groq', 'x-gateway-account': account.label, ...(fallbackFrom ? { 'x-gateway-groq-fallback': fallbackFrom } : {}) });
        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        let assembled = '';
        let ttftMs: number | undefined;
        const sseState = { pending: '', usage: { inputTokens: inputEstimate, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 } };
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
            const surfaced = surfaceOpenAiCompatStreamChunk('groq', chunk, surfaceState);
            if (surfaced.appendSse) { assembled += surfaced.appendSse; reply.raw.write(surfaced.appendSse); }
            if (surfaced.forcedLogReason) forcedLogReason = surfaced.forcedLogReason;
          }
          const tail = decoder.decode();
          if (tail) {
            assembled += tail;
            absorbSseUsage(tail, sseState, inputEstimate);
            reply.raw.write(tail);
          }
        } catch (err: any) {
          forcedLogReason = isAbortTimeoutError(err) ? 'groq_timeout' : 'groq_stream_interrupted';
          const interrupted = surfaceOpenAiCompatError('groq', null, 'stream_interrupted', isAbortTimeoutError(err) ? timeoutMessage(timeoutSeconds(REQUEST_TIMEOUT_MS)) : undefined).appendSse!;
          assembled += interrupted;
          reply.raw.write(interrupted);
        }
        absorbSseUsage('', sseState, inputEstimate, true);
        if (!surfaceState.sawCompletion && !forcedLogReason) {
          forcedLogReason = 'groq_stream_interrupted';
          const interrupted = surfaceOpenAiCompatError('groq', null, 'stream_interrupted').appendSse!;
          assembled += interrupted;
          reply.raw.write(interrupted);
        }
        reply.raw.end();
        const tokens = sseState.usage.inputTokens + sseState.usage.outputTokens + sseState.usage.cacheCreationTokens + sseState.usage.cacheReadTokens;
        recordGroqRequest(account.id, model, tokens || inputEstimate, true);
        const usageEventId = recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'groq', endpoint: `/v1/groq${endpoint}`, model, stream, statusCode: upstream.status, ...sseState.usage, ttftMs, retryCount: attempt, retryReason: attempt > 0 ? 'account_rotation' : undefined, estimatedCostUsd: estimateCost(model, sseState.usage, 'groq'), latencyMs: Date.now() - started, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
        enforceAfterUsage(auth.user, 'groq', auth.token, model);
        if (forcedLogReason) logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: { forcedLogReason, providerAccountLabel: account.label, attempt: attempt + 1, headers: req.headers, body }, responseText: assembled });
        else if (shouldLogBody(auth.user)) logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: body, responseText: assembled });
        return;
      }

      let text = await upstream.text();
      const nonStreamTtftMs = Date.now() - started;
      let forcedLogReason: string | undefined;
      try {
        const parsed = JSON.parse(text);
        const surfaced = surfaceOpenAiCompatError('groq', parsed, 'non_stream');
        if (surfaced.changed) text = JSON.stringify(parsed);
        forcedLogReason = surfaced.forcedLogReason;
      } catch {}
      const usage = parseUsage(text, inputEstimate);
      const tokens = usage.inputTokens + usage.outputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;
      recordGroqRequest(account.id, model, tokens || inputEstimate, true);
      const usageEventId = recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'groq', endpoint: `/v1/groq${endpoint}`, model, stream, statusCode: upstream.status, ...usage, ttftMs: nonStreamTtftMs, retryCount: attempt, retryReason: attempt > 0 ? 'account_rotation' : undefined, estimatedCostUsd: estimateCost(model, usage, 'groq'), latencyMs: Date.now() - started, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
      enforceAfterUsage(auth.user, 'groq', auth.token, model);
      if (forcedLogReason) logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: { forcedLogReason, providerAccountLabel: account.label, attempt: attempt + 1, headers: req.headers, body }, responseText: text });
      else if (shouldLogBody(auth.user)) logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: body, responseText: text });
      reply.code(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(text);
      return;
    } catch (err: any) {
      const timedOut = isAbortTimeoutError(err);
      lastError = timedOut ? timeoutMessage(timeoutSeconds(REQUEST_TIMEOUT_MS)) : transientNetworkMessage('groq');
      if (!timedOut) {
        markGroqCooldown(account.id, model, 60_000, `network error: ${err?.message || err}`);
        req.log?.info?.({ provider: 'groq', account: account.label, model, attempt: attempt + 1, error: String(err?.message || err) }, 'Groq network error; switching to another account');
      }
      const statusCode = timedOut ? 504 : 502;
      const usageEventId = recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'groq', endpoint: `/v1/groq${endpoint}`, model, stream, statusCode, inputTokens: inputEstimate, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
      if (timedOut) {
        logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: { forcedLogReason: 'groq_timeout', providerAccountLabel: account.label, attempt: attempt + 1, headers: req.headers, body }, responseText: JSON.stringify(openAiError(lastError, 'timeout', 'gateway_timeout')) });
        reply.code(504).send(openAiError(lastError, 'timeout', 'gateway_timeout'));
        return;
      }
    }
  }

  reply.header('retry-after', String(retryAfter));
  reply.header('x-gateway-provider', 'groq');
  if (fallbackFrom) reply.header('x-gateway-groq-fallback', fallbackFrom);
  reply.code(429).send(openAiError(`Groq capacity unavailable: ${lastError}`, 'rate_limit_exceeded', 'rate_limit_exceeded'));
}

// ─── Audio (Whisper) passthrough ─────────────────────────────────────────
// Audio endpoints (`/audio/transcriptions`, `/audio/translations`) use
// multipart/form-data, not JSON. We buffer the raw request body and forward
// it to Groq unchanged. Usage events log requests but not tokens (Groq audio
// is metered in audio-seconds, not tokens).
async function forwardGroqAudio(req: any, reply: any, endpoint: '/audio/transcriptions' | '/audio/translations') {
  const auth = await requireProxyToken(req, reply);
  if (!auth) return;
  const started = Date.now();

  const bodyBuf: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? '');
  const contentType = String(req.headers['content-type'] || 'application/octet-stream');
  const requestedModel = DEFAULT_GROQ_AUDIO_MODEL;
  const allowed = isModelAllowedForUser(auth.user, 'groq', requestedModel);
  if (!allowed.ok) {
    reply.code(400).send(modelNotAllowedForUserError(allowed.message));
    return;
  }
  const limit = checkLooseLimit(auth.user, 'groq', auth.token, requestedModel);
  if (!limit.ok) {
    reply.code(429).send(openAiError(limit.message, 'insufficient_quota', 'user_limit_exceeded'));
    return;
  }
  const stickyKey = `${auth.user.email}:${auth.token.label}:whisper`;
  const tried: number[] = [];
  let lastError = 'No Groq account available';
  let retryAfter = 60;

  for (let attempt = 0; attempt < 5; attempt++) {
    const account = selectGroqAccountForModel(requestedModel, stickyKey, 0, tried);
    if (!account) break;
    tried.push(account.id);
    try {
      const upstream = await fetch(`${config.groqUpstreamUrl}${endpoint}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${account.secret}`, 'content-type': contentType },
        body: new Uint8Array(bodyBuf),
        signal: AbortSignal.timeout(10 * 60 * 1000),
      });
      reply.header('x-gateway-provider', 'groq');
      reply.header('x-gateway-account', account.label);
      reply.header('x-gateway-attempt', String(attempt + 1));

      if (upstream.status === 429) {
        const text = await upstream.text().catch(() => '');
        const ms = retryAfterMs(upstream.headers.get('retry-after'));
        retryAfter = Math.max(1, Math.ceil(ms / 1000));
        markGroqCooldown(account.id, requestedModel, ms, `rate limited (${upstream.status})`);
        recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'groq', endpoint: `/v1/groq${endpoint}`, model: requestedModel, stream: false, statusCode: upstream.status, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: text.slice(0, 500) || 'rate limited', ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
        lastError = text.slice(0, 500) || 'rate limited';
        continue;
      }

      const respText = await upstream.text();
      const status = upstream.status;
      if (status >= 400) {
        lastError = respText.slice(0, 500) || String(status);
        if (isGroqBlockedApiAccess(status, respText)) {
          const cooldownMs = 24 * 60 * 60 * 1000;
          markGroqAccountCooldown(account.id, cooldownMs, 'blocked_api_access');
          recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'groq', endpoint: `/v1/groq${endpoint}`, model: requestedModel, stream: false, statusCode: status, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
          retryAfter = Math.max(retryAfter, 60);
          continue;
        }
        recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'groq', endpoint: `/v1/groq${endpoint}`, model: requestedModel, stream: false, statusCode: status, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
        reply.code(status).type(upstream.headers.get('content-type') || 'application/json').send(respText || openAiError(lastError));
        return;
      }

      recordGroqRequest(account.id, requestedModel, 0, true);
      recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'groq', endpoint: `/v1/groq${endpoint}`, model: requestedModel, stream: false, statusCode: status, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
      enforceAfterUsage(auth.user, 'groq', auth.token, requestedModel);
      reply.code(status).type(upstream.headers.get('content-type') || 'application/json').send(respText);
      return;
    } catch (err: any) {
      lastError = err?.message || String(err);
      recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'groq', endpoint: `/v1/groq${endpoint}`, model: requestedModel, stream: false, statusCode: 502, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
    }
  }

  reply.header('retry-after', String(retryAfter));
  reply.header('x-gateway-provider', 'groq');
  reply.code(429).send(openAiError(`Groq audio capacity unavailable: ${lastError}`, 'rate_limit_exceeded', 'rate_limit_exceeded'));
}

export function registerGroqProxy(app: FastifyInstance) {
  // Buffer raw multipart bodies for audio endpoints (Groq Whisper).
  try {
    app.addContentTypeParser('multipart/form-data', { parseAs: 'buffer', bodyLimit: 50 * 1024 * 1024 }, (_req, body, done) => {
      done(null, body);
    });
  } catch (err: any) {
    if (!/already present|already exists|content type parser/i.test(String(err?.message || err))) throw err;
  }
  app.post('/v1/groq/chat/completions', (req, reply) => forwardGroq(req, reply, '/chat/completions'));
  app.post('/v1/groq/embeddings', (req, reply) => forwardGroq(req, reply, '/embeddings'));
  app.post('/v1/groq/audio/transcriptions', (req, reply) => forwardGroqAudio(req, reply, '/audio/transcriptions'));
  app.post('/v1/groq/audio/translations', (req, reply) => forwardGroqAudio(req, reply, '/audio/translations'));
}
