import type { FastifyInstance } from 'fastify';
import { writeRawResponseHead } from '../http/response-headers.js';
import { config } from '../config.js';
import { requireProxyToken } from '../auth/token-auth.js';
import { recordUsage } from './usage.js';
import { compressionFields } from './compress.js';
import { authorizeEffectiveModelForUser, checkLooseLimit, enforceAfterUsage, logRequestResponse, shouldLogBody } from './policy.js';
import { estimateCost } from './cost.js';
import { DEFAULT_CEREBRAS_MODEL, KNOWN_CEREBRAS_MODELS, markCerebrasCooldown, recordCerebrasRequest, selectCerebrasAccountForModel } from '../providers/cerebras-pool.js';
import { isAbortTimeoutError, isModelUnavailableError, modelUnavailableError, surfaceOpenAiCompatError, surfaceOpenAiCompatStreamChunk, timeoutMessage, timeoutSeconds, transientNetworkMessage, type OpenAiCompatStreamState } from './openai-compat-errors.js';

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

async function forwardCerebras(req: any, reply: any, endpoint: '/chat/completions' | '/embeddings') {
  const auth = await requireProxyToken(req, reply);
  if (!auth) return;
  const started = Date.now();

  const body = { ...((req.body as any) || {}) };
  const rawModel = typeof body.model === 'string' && body.model ? body.model : undefined;
  const requestedModel = rawModel || DEFAULT_CEREBRAS_MODEL;
  const resolvedModel = KNOWN_CEREBRAS_MODELS.has(requestedModel) ? requestedModel : DEFAULT_CEREBRAS_MODEL;
  const authorization = authorizeEffectiveModelForUser(auth.user, 'cerebras', requestedModel, resolvedModel);
  const model = authorization.ok ? authorization.effectiveModel : resolvedModel;
  const fallbackFrom = model !== requestedModel ? requestedModel : '';
  if (!authorization.ok) {
    reply.code(400).send(modelNotAllowedForUserError(authorization.message));
    return;
  }
  body.model = model;
  const limit = checkLooseLimit(auth.user, 'cerebras', auth.token, model);
  if (!limit.ok) {
    reply.code(429).send(openAiError(limit.message, 'insufficient_quota', 'user_limit_exceeded'));
    return;
  }
  const stream = !!body.stream && endpoint === '/chat/completions';
  const inputEstimate = estimateInputTokens(body);
  const conversationId = String(req.headers['x-conversation-id'] || req.headers['session_id'] || req.headers['x-client-request-id'] || body?.conversation_id || '');
  const stickyKey = `${auth.user.email}:${auth.token.label}:${conversationId || model || endpoint}`;
  const tried: number[] = [];
  let lastError = 'No Cerebras account available';
  let retryAfter = 60;

  for (let attempt = 0; attempt < 10; attempt++) {
    const account = selectCerebrasAccountForModel(model, stickyKey, inputEstimate, tried);
    if (!account) break;
    tried.push(account.id);
    try {
      const upstream = await fetch(`${config.cerebrasUpstreamUrl}${endpoint}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${account.secret}`, 'content-type': 'application/json', accept: stream ? 'text/event-stream' : 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      reply.header('x-gateway-provider', 'cerebras');
      reply.header('x-gateway-account', account.label);
      reply.header('x-gateway-attempt', String(attempt + 1));
      if (fallbackFrom) reply.header('x-gateway-cerebras-fallback', fallbackFrom);

      if (upstream.status === 429) {
        const text = await upstream.text().catch(() => '');
        const ms = retryAfterMs(upstream.headers.get('retry-after'));
        retryAfter = Math.max(1, Math.ceil(ms / 1000));
        markCerebrasCooldown(account.id, model, ms, `rate limited (${upstream.status})`);
        req.log?.info?.({ provider: 'cerebras', account: account.label, model, attempt: attempt + 1 }, 'Cerebras rate limited; switching to another account');
        recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'cerebras', endpoint: `/v1/cerebras${endpoint}`, model, stream, statusCode: upstream.status, inputTokens: inputEstimate, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: text.slice(0, 500) || 'rate limited', ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
        lastError = text.slice(0, 500) || 'rate limited';
        continue;
      }

      if (upstream.status >= 400) {
        const text = await upstream.text().catch(() => '');
        lastError = text.slice(0, 500) || String(upstream.status);
        if (isModelUnavailableError(upstream.status, text)) {
          const clean = modelUnavailableError('cerebras', model);
          lastError = clean.error.message;
          recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'cerebras', endpoint: `/v1/cerebras${endpoint}`, model, stream, statusCode: upstream.status, inputTokens: inputEstimate, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
          reply.code(400).send(clean);
          return;
        }
        recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'cerebras', endpoint: `/v1/cerebras${endpoint}`, model, stream, statusCode: upstream.status, inputTokens: inputEstimate, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
        reply.code(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(text || openAiError(lastError));
        return;
      }

      if (stream && upstream.body) {
        writeRawResponseHead(reply, upstream.status, { 'content-type': upstream.headers.get('content-type') || 'text/event-stream', 'cache-control': 'no-cache', 'x-gateway-provider': 'cerebras', 'x-gateway-account': account.label, ...(fallbackFrom ? { 'x-gateway-cerebras-fallback': fallbackFrom } : {}) });
        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        let assembled = '';
        const sseState = { pending: '', usage: { inputTokens: inputEstimate, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 } };
        const surfaceState: OpenAiCompatStreamState = { sawCompletion: false, sawContent: false };
        let ttftMs: number | undefined;
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
            const surfaced = surfaceOpenAiCompatStreamChunk('cerebras', chunk, surfaceState);
            if (surfaced.appendSse) { assembled += surfaced.appendSse; reply.raw.write(surfaced.appendSse); }
            if (surfaced.forcedLogReason) forcedLogReason = surfaced.forcedLogReason;
          }
          const tail = decoder.decode();
          if (tail) { assembled += tail; absorbSseUsage(tail, sseState, inputEstimate); reply.raw.write(tail); }
        } catch (err: any) {
          forcedLogReason = isAbortTimeoutError(err) ? 'cerebras_timeout' : 'cerebras_stream_interrupted';
          const interrupted = surfaceOpenAiCompatError('cerebras', null, 'stream_interrupted', isAbortTimeoutError(err) ? timeoutMessage(timeoutSeconds(REQUEST_TIMEOUT_MS)) : undefined).appendSse!;
          assembled += interrupted;
          reply.raw.write(interrupted);
        }
        absorbSseUsage('', sseState, inputEstimate, true);
        if (!surfaceState.sawCompletion && !forcedLogReason) {
          forcedLogReason = 'cerebras_stream_interrupted';
          const interrupted = surfaceOpenAiCompatError('cerebras', null, 'stream_interrupted').appendSse!;
          assembled += interrupted;
          reply.raw.write(interrupted);
        }
        reply.raw.end();
        const tokens = sseState.usage.inputTokens + sseState.usage.outputTokens + sseState.usage.cacheCreationTokens + sseState.usage.cacheReadTokens;
        recordCerebrasRequest(account.id, model, tokens || inputEstimate, true);
        const usageEventId = recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'cerebras', endpoint: `/v1/cerebras${endpoint}`, model, stream, statusCode: upstream.status, ...sseState.usage, ttftMs, retryCount: attempt, retryReason: attempt > 0 ? 'account_rotation' : undefined, estimatedCostUsd: estimateCost(model, sseState.usage, 'cerebras'), latencyMs: Date.now() - started, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
        enforceAfterUsage(auth.user, 'cerebras', auth.token, model);
        if (forcedLogReason) logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: { forcedLogReason, providerAccountLabel: account.label, attempt: attempt + 1, headers: req.headers, body }, responseText: assembled });
        else if (shouldLogBody(auth.user)) logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: body, responseText: assembled });
        return;
      }

      let text = await upstream.text();
      const nonStreamTtftMs = Date.now() - started;
      let forcedLogReason: string | undefined;
      try {
        const parsed = JSON.parse(text);
        const surfaced = surfaceOpenAiCompatError('cerebras', parsed, 'non_stream');
        if (surfaced.changed) text = JSON.stringify(parsed);
        forcedLogReason = surfaced.forcedLogReason;
      } catch {}
      const usage = parseUsage(text, inputEstimate);
      const tokens = usage.inputTokens + usage.outputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;
      recordCerebrasRequest(account.id, model, tokens || inputEstimate, true);
      const usageEventId = recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'cerebras', endpoint: `/v1/cerebras${endpoint}`, model, stream, statusCode: upstream.status, ...usage, ttftMs: nonStreamTtftMs, retryCount: attempt, retryReason: attempt > 0 ? 'account_rotation' : undefined, estimatedCostUsd: estimateCost(model, usage, 'cerebras'), latencyMs: Date.now() - started, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
      enforceAfterUsage(auth.user, 'cerebras', auth.token, model);
      if (forcedLogReason) logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: { forcedLogReason, providerAccountLabel: account.label, attempt: attempt + 1, headers: req.headers, body }, responseText: text });
      else if (shouldLogBody(auth.user)) logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: body, responseText: text });
      reply.code(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(text);
      return;
    } catch (err: any) {
      const timedOut = isAbortTimeoutError(err);
      lastError = timedOut ? timeoutMessage(timeoutSeconds(REQUEST_TIMEOUT_MS)) : transientNetworkMessage('cerebras');
      if (!timedOut) {
        markCerebrasCooldown(account.id, model, 60_000, `network error: ${err?.message || err}`);
        req.log?.info?.({ provider: 'cerebras', account: account.label, model, attempt: attempt + 1, error: String(err?.message || err) }, 'Cerebras network error; switching to another account');
      }
      const statusCode = timedOut ? 504 : 502;
      const usageEventId = recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'cerebras', endpoint: `/v1/cerebras${endpoint}`, model, stream, statusCode, inputTokens: inputEstimate, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
      if (timedOut) {
        logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: { forcedLogReason: 'cerebras_timeout', providerAccountLabel: account.label, attempt: attempt + 1, headers: req.headers, body }, responseText: JSON.stringify(openAiError(lastError, 'timeout', 'gateway_timeout')) });
        reply.code(504).send(openAiError(lastError, 'timeout', 'gateway_timeout'));
        return;
      }
    }
  }

  reply.header('retry-after', String(retryAfter));
  reply.header('x-gateway-provider', 'cerebras');
  if (fallbackFrom) reply.header('x-gateway-cerebras-fallback', fallbackFrom);
  reply.code(429).send(openAiError(`Cerebras capacity unavailable: ${lastError}`, 'rate_limit_exceeded', 'rate_limit_exceeded'));
}

export function registerCerebrasProxy(app: FastifyInstance) {
  app.post('/v1/cerebras/chat/completions', (req, reply) => forwardCerebras(req, reply, '/chat/completions'));
  app.post('/v1/cerebras/embeddings', (req, reply) => forwardCerebras(req, reply, '/embeddings'));
}
