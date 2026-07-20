import type { FastifyInstance } from 'fastify';
import { writeRawResponseHead } from '../http/response-headers.js';
import { requireProxyToken } from '../auth/token-auth.js';
import { recordUsage } from './usage.js';
import { compressionFields } from './compress.js';
import { authorizeEffectiveModelForUser, checkLooseLimit, enforceAfterUsage, logRequestResponse, shouldLogBody } from './policy.js';
import { estimateCost } from './cost.js';
import {
  acquireRunpodSlot,
  DEFAULT_RUNPOD_MODEL,
  KNOWN_RUNPOD_MODELS,
  markRunpodCooldown,
  recordRunpodSuccess,
  releaseRunpodSlot,
  runpodEndpointUrl,
  selectRunpodAccount,
  RUNPOD_UPSTREAM_MODEL,
} from '../providers/runpod-pool.js';
import {
  isAbortTimeoutError,
  isModelUnavailableError,
  modelUnavailableError,
  surfaceOpenAiCompatError,
  surfaceOpenAiCompatStreamChunk,
  timeoutMessage,
  timeoutSeconds,
  transientNetworkMessage,
  type OpenAiCompatStreamState,
} from './openai-compat-errors.js';

const REQUEST_TIMEOUT_MS = 20 * 60 * 1000;

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

function cleanHeaders(_reqHeaders: Record<string, any>, stream: boolean): Headers {
  const headers = new Headers();
  headers.set('content-type', 'application/json');
  headers.set('accept', stream ? 'text/event-stream' : 'application/json');
  return headers;
}

function parseUsageFromObject(parsed: any, fallbackInput: number) {
  const u = parsed?.usage;
  return {
    inputTokens: u?.input_tokens ?? u?.prompt_tokens ?? fallbackInput,
    outputTokens: u?.output_tokens ?? u?.completion_tokens ?? 0,
    cacheCreationTokens: u?.cache_creation_input_tokens ?? 0,
    cacheReadTokens: u?.cache_read_input_tokens ?? u?.input_tokens_details?.cached_tokens ?? 0,
    reasoningTokens: u?.output_tokens_details?.reasoning_tokens ?? u?.completion_tokens_details?.reasoning_tokens ?? 0,
  };
}

function parseUsage(text: string, fallbackInput: number) {
  try { return parseUsageFromObject(JSON.parse(text), fallbackInput); } catch { return { inputTokens: fallbackInput, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 }; }
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
      const u = parsed?.usage;
      if (u) state.usage = {
        inputTokens: u.input_tokens ?? u.prompt_tokens ?? state.usage.inputTokens ?? fallbackInput,
        outputTokens: u.output_tokens ?? u.completion_tokens ?? state.usage.outputTokens ?? 0,
        cacheCreationTokens: u.cache_creation_input_tokens ?? state.usage.cacheCreationTokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? u.input_tokens_details?.cached_tokens ?? state.usage.cacheReadTokens ?? 0,
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

// Rewrite virtual model ids to the single upstream Qwen3.6-27B model. The
// `-fast` variant disables vLLM's thinking parser via chat_template_kwargs so
// the model emits answers directly (no <think>...</think> preamble).
function applyVirtualModelMapping(body: any): { upstreamModel: string; virtualModel: string } {
  const virtualModel = typeof body.model === 'string' ? body.model : DEFAULT_RUNPOD_MODEL;
  if (virtualModel === 'qwen36-27b-fast') {
    body.model = RUNPOD_UPSTREAM_MODEL;
    body.chat_template_kwargs = body.chat_template_kwargs || {};
    if (body.chat_template_kwargs.enable_thinking === undefined) {
      body.chat_template_kwargs.enable_thinking = false;
    }
  } else {
    body.model = RUNPOD_UPSTREAM_MODEL;
  }
  return { upstreamModel: RUNPOD_UPSTREAM_MODEL, virtualModel };
}

async function forwardRunpod(req: any, reply: any) {
  const auth = await requireProxyToken(req, reply);
  if (!auth) return;
  const started = Date.now();

  const body = { ...((req.body as any) || {}) };
  const rawModel = typeof body.model === 'string' && body.model ? body.model : undefined;
  const requestedModel = rawModel || DEFAULT_RUNPOD_MODEL;
  // The model the user sees / is limited against. Upstream model is rewritten.
  const virtualModel = KNOWN_RUNPOD_MODELS.has(requestedModel) ? requestedModel : DEFAULT_RUNPOD_MODEL;
  const authorization = authorizeEffectiveModelForUser(auth.user, 'runpod', requestedModel, virtualModel);
  if (!authorization.ok) {
    reply.code(400).send(modelNotAllowedForUserError(authorization.message));
    return;
  }
  const fallbackFrom = virtualModel !== requestedModel ? requestedModel : '';
  body.model = virtualModel;
  applyVirtualModelMapping(body);

  const limit = checkLooseLimit(auth.user, 'runpod', auth.token, virtualModel);
  if (!limit.ok) {
    reply.code(429).send(openAiError(limit.message, 'insufficient_quota', 'user_limit_exceeded'));
    return;
  }
  const stream = !!body.stream;
  const inputEstimate = estimateInputTokens(body);
  const conversationId = String(req.headers['x-conversation-id'] || req.headers['session_id'] || req.headers['x-client-request-id'] || body?.conversation_id || '');
  const stickyKey = `${auth.user.email}:${auth.token.label}:${conversationId || virtualModel}`;
  const tried: number[] = [];
  let lastError = 'No Runpod account available';
  let retryAfter = 60;

  for (let attempt = 0; attempt < 5; attempt++) {
    const account = selectRunpodAccount(stickyKey, tried);
    if (!account) break;
    tried.push(account.id);
    if (!acquireRunpodSlot(account)) {
      lastError = 'Runpod account at concurrency cap';
      continue;
    }
    let released = false;
    const release = () => { if (!released) { released = true; releaseRunpodSlot(account); } };
    try {
      const headers = cleanHeaders(req.headers, stream);
      headers.set('authorization', `Bearer ${account.secret}`);
      const upstream = await fetch(`${runpodEndpointUrl(account)}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      reply.header('x-gateway-provider', 'runpod');
      reply.header('x-gateway-account', account.label);
      reply.header('x-gateway-attempt', String(attempt + 1));
      reply.header('x-gateway-runpod-virtual-model', virtualModel);
      if (fallbackFrom) reply.header('x-gateway-runpod-fallback', fallbackFrom);

      if (upstream.status === 429) {
        const text = await upstream.text().catch(() => '');
        release();
        const ms = retryAfterMs(upstream.headers.get('retry-after'));
        retryAfter = Math.max(1, Math.ceil(ms / 1000));
        markRunpodCooldown(account.id, ms, `rate limited (${upstream.status})`);
        req.log?.info?.({ provider: 'runpod', account: account.label, model: virtualModel, attempt: attempt + 1 }, 'Runpod rate limited; switching to another account');
        recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'runpod', endpoint: '/v1/runpod/chat/completions', model: virtualModel, stream, statusCode: upstream.status, inputTokens: inputEstimate, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: text.slice(0, 500) || 'rate limited', ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
        lastError = text.slice(0, 500) || 'rate limited';
        continue;
      }

      if (upstream.status >= 400) {
        const text = await upstream.text().catch(() => '');
        release();
        lastError = text.slice(0, 500) || String(upstream.status);
        if (isModelUnavailableError(upstream.status, text)) {
          const clean = modelUnavailableError('runpod', virtualModel);
          lastError = clean.error.message;
          recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'runpod', endpoint: '/v1/runpod/chat/completions', model: virtualModel, stream, statusCode: upstream.status, inputTokens: inputEstimate, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
          reply.code(400).send(clean);
          return;
        }
        recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'runpod', endpoint: '/v1/runpod/chat/completions', model: virtualModel, stream, statusCode: upstream.status, inputTokens: inputEstimate, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
        reply.code(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(text || openAiError(lastError));
        return;
      }

      if (stream && upstream.body) {
        writeRawResponseHead(reply, upstream.status, {
          'content-type': upstream.headers.get('content-type') || 'text/event-stream',
          'cache-control': 'no-cache',
          'x-gateway-provider': 'runpod',
          'x-gateway-account': account.label,
          'x-gateway-runpod-virtual-model': virtualModel,
          ...(fallbackFrom ? { 'x-gateway-runpod-fallback': fallbackFrom } : {}),
        });
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
            const surfaced = surfaceOpenAiCompatStreamChunk('runpod', chunk, surfaceState);
            if (surfaced.appendSse) { assembled += surfaced.appendSse; reply.raw.write(surfaced.appendSse); }
            if (surfaced.forcedLogReason) forcedLogReason = surfaced.forcedLogReason;
          }
          const tail = decoder.decode();
          if (tail) { assembled += tail; absorbSseUsage(tail, sseState, inputEstimate); reply.raw.write(tail); }
        } catch (err: any) {
          forcedLogReason = isAbortTimeoutError(err) ? 'runpod_timeout' : 'runpod_stream_interrupted';
          const interrupted = surfaceOpenAiCompatError('runpod', null, 'stream_interrupted', isAbortTimeoutError(err) ? timeoutMessage(timeoutSeconds(REQUEST_TIMEOUT_MS)) : undefined).appendSse!;
          assembled += interrupted;
          reply.raw.write(interrupted);
        }
        absorbSseUsage('', sseState, inputEstimate, true);
        if (!surfaceState.sawCompletion && !forcedLogReason) {
          forcedLogReason = 'runpod_stream_interrupted';
          const interrupted = surfaceOpenAiCompatError('runpod', null, 'stream_interrupted').appendSse!;
          assembled += interrupted;
          reply.raw.write(interrupted);
        }
        reply.raw.end();
        release();
        recordRunpodSuccess(account.id);
        const usageEventId = recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'runpod', endpoint: '/v1/runpod/chat/completions', model: virtualModel, stream, statusCode: upstream.status, ...sseState.usage, ttftMs, retryCount: attempt, retryReason: attempt > 0 ? 'account_rotation' : undefined, estimatedCostUsd: estimateCost(virtualModel, sseState.usage, 'runpod'), latencyMs: Date.now() - started, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
        enforceAfterUsage(auth.user, 'runpod', auth.token, virtualModel);
        if (forcedLogReason) logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: { forcedLogReason, providerAccountLabel: account.label, attempt: attempt + 1, headers: req.headers, body }, responseText: assembled });
        else if (shouldLogBody(auth.user)) logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: body, responseText: assembled });
        return;
      }

      let text = await upstream.text();
      const nonStreamTtftMs = Date.now() - started;
      release();
      recordRunpodSuccess(account.id);
      let forcedLogReason: string | undefined;
      try {
        const parsed = JSON.parse(text);
        const surfaced = surfaceOpenAiCompatError('runpod', parsed, 'non_stream');
        if (surfaced.changed) text = JSON.stringify(parsed);
        forcedLogReason = surfaced.forcedLogReason;
      } catch {}
      const usage = parseUsage(text, inputEstimate);
      const usageEventId = recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'runpod', endpoint: '/v1/runpod/chat/completions', model: virtualModel, stream, statusCode: upstream.status, ...usage, ttftMs: nonStreamTtftMs, retryCount: attempt, retryReason: attempt > 0 ? 'account_rotation' : undefined, estimatedCostUsd: estimateCost(virtualModel, usage, 'runpod'), latencyMs: Date.now() - started, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
      enforceAfterUsage(auth.user, 'runpod', auth.token, virtualModel);
      if (forcedLogReason) logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: { forcedLogReason, providerAccountLabel: account.label, attempt: attempt + 1, headers: req.headers, body }, responseText: text });
      else if (shouldLogBody(auth.user)) logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: body, responseText: text });
      reply.code(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(text);
      return;
    } catch (err: any) {
      release();
      const timedOut = isAbortTimeoutError(err);
      lastError = timedOut ? timeoutMessage(timeoutSeconds(REQUEST_TIMEOUT_MS)) : transientNetworkMessage('runpod');
      if (!timedOut) {
        markRunpodCooldown(account.id, 60_000, `network error: ${err?.message || err}`);
        req.log?.info?.({ provider: 'runpod', account: account.label, model: virtualModel, attempt: attempt + 1, error: String(err?.message || err) }, 'Runpod network error; switching to another account');
      }
      const statusCode = timedOut ? 504 : 502;
      const usageEventId = recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'runpod', endpoint: '/v1/runpod/chat/completions', model: virtualModel, stream, statusCode, inputTokens: inputEstimate, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
      if (timedOut) {
        logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: { forcedLogReason: 'runpod_timeout', providerAccountLabel: account.label, attempt: attempt + 1, headers: req.headers, body }, responseText: JSON.stringify(openAiError(lastError, 'timeout', 'gateway_timeout')) });
        reply.code(504).send(openAiError(lastError, 'timeout', 'gateway_timeout'));
        return;
      }
    }
  }

  reply.header('retry-after', String(retryAfter));
  reply.header('x-gateway-provider', 'runpod');
  if (fallbackFrom) reply.header('x-gateway-runpod-fallback', fallbackFrom);
  reply.code(429).send(openAiError(`Runpod capacity unavailable: ${lastError}`, 'rate_limit_exceeded', 'rate_limit_exceeded'));
}

export function registerRunpodProxy(app: FastifyInstance) {
  app.post('/v1/runpod/chat/completions', (req, reply) => forwardRunpod(req, reply));
  // GET /v1/runpod/models is served by src/api/provider-models.ts, derived
  // from MODEL_CATALOG (both virtual ids are registry entries) and policy-
  // filtered per user. Do not re-register it here: a duplicate route throws
  // FST_ERR_DUPLICATED_ROUTE at startup and the server never boots.
}
