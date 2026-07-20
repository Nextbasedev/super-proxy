import type { FastifyInstance } from 'fastify';
import { writeRawResponseHead } from '../http/response-headers.js';
import { config } from '../config.js';
import { requireProxyToken } from '../auth/token-auth.js';
import { recordUsage } from './usage.js';
import { compressionFields } from './compress.js';
import { checkLooseLimit, enforceAfterUsage, isModelAllowedForUser, logRequestResponse, shouldLogBody } from './policy.js';
import { estimateCost } from './cost.js';
import { acquireGlmSlot, DEFAULT_GLM_MODEL, KNOWN_GLM_MODELS, markGlmCooldown, recordGlmSuccess, releaseGlmSlot, selectGlmAccount } from '../providers/glm-pool.js';
import { isAbortTimeoutError, isModelUnavailableError, modelUnavailableError, surfaceOpenAiCompatError, surfaceOpenAiCompatStreamChunk, timeoutMessage, timeoutSeconds, transientNetworkMessage, type OpenAiCompatStreamState } from './openai-compat-errors.js';
import { emptyNormalizedUsage } from '../normalize/events.js';
import {
  classifyGlmTerminal,
  collectGlmEvents,
  lastUsageFromEvents,
} from '../normalize/glm.js';

const REQUEST_TIMEOUT_MS = 20 * 60 * 1000;

// Default reasoning effort applied to GLM requests when the caller omits one.
// z.ai GLM-5.x effort scale: none|minimal|low|medium|high|xhigh|max.
const DEFAULT_GLM_REASONING_EFFORT = process.env.GLM_DEFAULT_REASONING_EFFORT || 'max';

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

// Transparent Anthropic passthrough. z.ai's GLM Coding Plan exposes an
// Anthropic-compatible Messages endpoint, so a Claude-Code / OpenClaw Anthropic
// client request body is forwarded verbatim — only auth/host/length headers are
// rewritten. We DO forward the client's own user-agent / anthropic-beta /
// stainless headers untouched so the upstream request looks exactly like the
// Claude-Code-class request the client already produced. Auth is swapped to the
// pooled subscription key via `x-api-key`.
function cleanHeaders(reqHeaders: Record<string, any>, stream: boolean): Headers {
  const headers = new Headers();
  for (const [k, v] of Object.entries(reqHeaders)) {
    if (v == null) continue;
    const lk = k.toLowerCase();
    // Strip only the client auth + hop-by-hop headers. Everything else
    // (user-agent, anthropic-beta, x-stainless-*, etc.) passes through so the
    // request keeps its Claude-Code fingerprint.
    if (['authorization', 'x-api-key', 'api-key', 'apikey', 'host', 'content-length',
         'connection', 'keep-alive', 'proxy-authorization', 'proxy-authenticate',
         'te', 'trailer', 'transfer-encoding', 'upgrade'].includes(lk)) continue;
    headers.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  headers.set('content-type', 'application/json');
  headers.set('accept', stream ? 'text/event-stream' : 'application/json');
  if (!headers.has('anthropic-version')) headers.set('anthropic-version', '2023-06-01');
  return headers;
}

function parseUsageFromObject(parsed: any, fallbackInput: number) {
  const u = parsed?.usage || parsed?.response?.usage || parsed?.message?.usage;
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
      const u = parsed?.usage || parsed?.response?.usage || parsed?.message?.usage || (parsed?.type === 'message_start' ? parsed?.message?.usage : null);
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

async function forwardGlm(req: any, reply: any) {
  const endpoint = '/messages';
  const auth = await requireProxyToken(req, reply);
  if (!auth) return;
  const started = Date.now();

  const body = { ...((req.body as any) || {}) };
  const rawModel = typeof body.model === 'string' && body.model ? body.model : undefined;
  const requestedModel = rawModel || DEFAULT_GLM_MODEL;
  const model = KNOWN_GLM_MODELS.has(requestedModel) ? requestedModel : DEFAULT_GLM_MODEL;
  const fallbackFrom = model !== requestedModel ? requestedModel : '';
  // Authorize the EFFECTIVE model (after default + unknown-fallback resolution).
  // Omitting `model` or sending an unknown one must NOT bypass provider deny_all
  // or a specific deny of the resolved model: isModelAllowedForUser short-circuits
  // to allow on a missing/blank model, so we always pass the concrete resolved id.
  const allowed = isModelAllowedForUser(auth.user, 'glm', model);
  if (!allowed.ok) {
    reply.code(400).send(modelNotAllowedForUserError(allowed.message));
    return;
  }
  // Transparent passthrough: only normalize the model field for routing/limits.
  body.model = model;
  // Default GLM to deep reasoning at max effort. z.ai's GLM-5.x does NOT think
  // by default on the Anthropic-compat endpoint (baseline returns no thinking
  // block), so we enable it explicitly and pin reasoning_effort to "max".
  // Callers can override either field (including thinking:{type:"disabled"}).
  if (body.thinking === undefined) {
    body.thinking = { type: 'enabled' };
  }
  if (body.reasoning_effort === undefined) {
    body.reasoning_effort = DEFAULT_GLM_REASONING_EFFORT;
  }
  const limit = checkLooseLimit(auth.user, 'glm', auth.token, model);
  if (!limit.ok) {
    reply.code(429).send(openAiError(limit.message, 'insufficient_quota', 'user_limit_exceeded'));
    return;
  }
  const stream = !!body.stream;
  const inputEstimate = estimateInputTokens(body);
  const conversationId = String(req.headers['x-conversation-id'] || req.headers['session_id'] || req.headers['x-client-request-id'] || body?.conversation_id || '');
  const stickyKey = `${auth.user.email}:${auth.token.label}:${conversationId || model || endpoint}`;
  const tried: number[] = [];
  let lastError = 'No GLM account available';
  let retryAfter = 60;

  for (let attempt = 0; attempt < 10; attempt++) {
    const account = selectGlmAccount(stickyKey, model, tried);
    if (!account) break;
    tried.push(account.id);
    if (!acquireGlmSlot(account, model)) {
      lastError = 'GLM account at per-model concurrency cap';
      continue;
    }
    let released = false;
    const release = () => { if (!released) { released = true; releaseGlmSlot(account, model); } };
    try {
      const headers = cleanHeaders(req.headers, stream);
      // z.ai GLM Coding Plan auth: Anthropic-style x-api-key with the pooled
      // subscription key. (Bearer is not used here, unlike Kimi.)
      headers.set('x-api-key', account.secret);
      const upstream = await fetch(`${config.glmUpstreamUrl}/v1${endpoint}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      reply.header('x-gateway-provider', 'glm');
      reply.header('x-gateway-account', account.label);
      reply.header('x-gateway-attempt', String(attempt + 1));
      if (fallbackFrom) reply.header('x-gateway-glm-fallback', fallbackFrom);

      if (upstream.status === 429) {
        const text = await upstream.text().catch(() => '');
        release();
        const ms = retryAfterMs(upstream.headers.get('retry-after'));
        retryAfter = Math.max(1, Math.ceil(ms / 1000));
        markGlmCooldown(account.id, ms, `rate limited (${upstream.status})`);
        req.log?.info?.({ provider: 'glm', account: account.label, model, attempt: attempt + 1 }, 'GLM rate limited; switching to another account');
        recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'glm', endpoint: `/v1/glm${endpoint}`, model, stream, statusCode: upstream.status, inputTokens: inputEstimate, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: text.slice(0, 500) || 'rate limited', ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
        lastError = text.slice(0, 500) || 'rate limited';
        continue;
      }

      if (upstream.status >= 500) {
        const text = await upstream.text().catch(() => '');
        release();
        markGlmCooldown(account.id, 60_000, `upstream ${upstream.status}`);
        req.log?.info?.({ provider: 'glm', account: account.label, model, attempt: attempt + 1, status: upstream.status }, 'GLM upstream 5xx; switching to another account');
        recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'glm', endpoint: `/v1/glm${endpoint}`, model, stream, statusCode: upstream.status, inputTokens: inputEstimate, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: text.slice(0, 500) || String(upstream.status), ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
        lastError = text.slice(0, 500) || String(upstream.status);
        continue;
      }

      if (upstream.status >= 400) {
        const text = await upstream.text().catch(() => '');
        release();
        lastError = text.slice(0, 500) || String(upstream.status);
        if (isModelUnavailableError(upstream.status, text)) {
          const clean = modelUnavailableError('glm', model);
          lastError = clean.error.message;
          recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'glm', endpoint: `/v1/glm${endpoint}`, model, stream, statusCode: upstream.status, inputTokens: inputEstimate, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
          reply.code(400).send(clean);
          return;
        }
        recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'glm', endpoint: `/v1/glm${endpoint}`, model, stream, statusCode: upstream.status, inputTokens: inputEstimate, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
        reply.code(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(text || openAiError(lastError));
        return;
      }

      if (stream && upstream.body) {
        writeRawResponseHead(reply, upstream.status, { 'content-type': upstream.headers.get('content-type') || 'text/event-stream', 'cache-control': 'no-cache', 'x-gateway-provider': 'glm', 'x-gateway-account': account.label, ...(fallbackFrom ? { 'x-gateway-glm-fallback': fallbackFrom } : {}) });

        // Phase 2 dual-path: NORMALIZE_GLM=true uses the normalized adapter for
        // usage + terminal classification while passthrough-writing upstream SSE
        // to the client. When false, the legacy path is byte-identical to pre-Phase-2.
        if (config.normalizeGlm) {
          const reader = upstream.body.getReader();
          const decoder = new TextDecoder();
          let assembled = '';
          let ttftMs: number | undefined;
          const chunks: string[] = [];
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (ttftMs === undefined) ttftMs = Date.now() - started;
              const chunk = decoder.decode(value, { stream: true });
              assembled += chunk;
              chunks.push(chunk);
              reply.raw.write(chunk);
            }
            const tail = decoder.decode();
            if (tail) {
              assembled += tail;
              chunks.push(tail);
              reply.raw.write(tail);
            }
          } catch (err: any) {
            // Mirror legacy catch: surface interrupt SSE on read errors/timeouts.
            const timedOut = isAbortTimeoutError(err);
            const forcedLogReason = timedOut ? 'glm_timeout' : 'glm_stream_interrupted';
            const interrupted = surfaceOpenAiCompatError('glm', null, 'stream_interrupted', timedOut ? timeoutMessage(timeoutSeconds(REQUEST_TIMEOUT_MS)) : undefined).appendSse!;
            assembled += interrupted;
            reply.raw.write(interrupted);
            reply.raw.end();
            release();
            recordGlmSuccess(account.id);
            const usageEventId = recordUsage({
              userId: auth.user.id,
              tokenId: auth.token.id,
              providerAccountId: account.id,
              provider: 'glm',
              endpoint: `/v1/glm${endpoint}`,
              model,
              stream,
              statusCode: upstream.status,
              inputTokens: inputEstimate,
              outputTokens: 0,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
              ttftMs,
              retryCount: attempt,
              retryReason: attempt > 0 ? 'account_rotation' : undefined,
              estimatedCostUsd: 0,
              latencyMs: Date.now() - started,
              error: forcedLogReason,
              ...compressionFields(req),
              tokenLabel: auth.token.label,
              providerAccountLabel: account.label,
            });
            logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: { forcedLogReason, providerAccountLabel: account.label, attempt: attempt + 1, headers: req.headers, body }, responseText: assembled });
            return;
          }

          const events = await collectGlmEvents(chunks, {
            fallbackInputTokens: inputEstimate,
            startedAtMs: started,
          });
          const usage = lastUsageFromEvents(
            events,
            emptyNormalizedUsage({ inputTokens: inputEstimate }),
          );
          const terminal = classifyGlmTerminal(events);

          // PR #120: only invent glm_stream_interrupted when there was no genuine
          // completion (message_stop / [DONE] -> stop). Incomplete streams map to
          // glm_stream_incomplete and get the same client-visible interrupt SSE.
          let forcedLogReason: string | undefined;
          if (terminal.kind === 'incomplete') {
            forcedLogReason = 'glm_stream_interrupted';
            const interrupted = surfaceOpenAiCompatError('glm', null, 'stream_interrupted').appendSse!;
            assembled += interrupted;
            reply.raw.write(interrupted);
          }
          reply.raw.end();
          release();
          recordGlmSuccess(account.id);
          const billingUsage = {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheCreationTokens: usage.cacheCreationTokens,
            cacheReadTokens: usage.cacheReadTokens,
            reasoningTokens: usage.reasoningTokens,
            // Prefer adapter TTFT; fall back to first-byte measurement.
            ttftMs: usage.ttftMs ?? ttftMs,
          };
          const usageEventId = recordUsage({
            userId: auth.user.id,
            tokenId: auth.token.id,
            providerAccountId: account.id,
            provider: 'glm',
            endpoint: `/v1/glm${endpoint}`,
            model,
            stream,
            statusCode: upstream.status,
            ...billingUsage,
            retryCount: attempt,
            retryReason: attempt > 0 ? 'account_rotation' : undefined,
            estimatedCostUsd: estimateCost(model, billingUsage, 'glm'),
            latencyMs: Date.now() - started,
            ...compressionFields(req),
            tokenLabel: auth.token.label,
            providerAccountLabel: account.label,
          });
          enforceAfterUsage(auth.user, 'glm', auth.token, model);
          if (forcedLogReason) logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: { forcedLogReason, providerAccountLabel: account.label, attempt: attempt + 1, headers: req.headers, body }, responseText: assembled });
          else if (shouldLogBody(auth.user)) logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: body, responseText: assembled });
          return;
        }

        // --- legacy path (NORMALIZE_GLM off / default): unchanged from pre-Phase-2 ---
        // (headers already written above)
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
            const surfaced = surfaceOpenAiCompatStreamChunk('glm', chunk, surfaceState);
            if (surfaced.appendSse) { assembled += surfaced.appendSse; reply.raw.write(surfaced.appendSse); }
            if (surfaced.forcedLogReason) forcedLogReason = surfaced.forcedLogReason;
          }
          const tail = decoder.decode();
          if (tail) { assembled += tail; absorbSseUsage(tail, sseState, inputEstimate); reply.raw.write(tail); }
        } catch (err: any) {
          forcedLogReason = isAbortTimeoutError(err) ? 'glm_timeout' : 'glm_stream_interrupted';
          const interrupted = surfaceOpenAiCompatError('glm', null, 'stream_interrupted', isAbortTimeoutError(err) ? timeoutMessage(timeoutSeconds(REQUEST_TIMEOUT_MS)) : undefined).appendSse!;
          assembled += interrupted;
          reply.raw.write(interrupted);
        }
        absorbSseUsage('', sseState, inputEstimate, true);
        if (!surfaceState.sawCompletion && !forcedLogReason) {
          forcedLogReason = 'glm_stream_interrupted';
          const interrupted = surfaceOpenAiCompatError('glm', null, 'stream_interrupted').appendSse!;
          assembled += interrupted;
          reply.raw.write(interrupted);
        }
        reply.raw.end();
        release();
        recordGlmSuccess(account.id);
        const usageEventId = recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'glm', endpoint: `/v1/glm${endpoint}`, model, stream, statusCode: upstream.status, ...sseState.usage, ttftMs, retryCount: attempt, retryReason: attempt > 0 ? 'account_rotation' : undefined, estimatedCostUsd: estimateCost(model, sseState.usage, 'glm'), latencyMs: Date.now() - started, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
        enforceAfterUsage(auth.user, 'glm', auth.token, model);
        if (forcedLogReason) logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: { forcedLogReason, providerAccountLabel: account.label, attempt: attempt + 1, headers: req.headers, body }, responseText: assembled });
        else if (shouldLogBody(auth.user)) logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: body, responseText: assembled });
        return;
      }

      let text = await upstream.text();
      const nonStreamTtftMs = Date.now() - started;
      release();
      recordGlmSuccess(account.id);
      let forcedLogReason: string | undefined;
      try {
        const parsed = JSON.parse(text);
        const surfaced = surfaceOpenAiCompatError('glm', parsed, 'non_stream');
        if (surfaced.changed) text = JSON.stringify(parsed);
        forcedLogReason = surfaced.forcedLogReason;
      } catch {}
      const usage = parseUsage(text, inputEstimate);
      const usageEventId = recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'glm', endpoint: `/v1/glm${endpoint}`, model, stream, statusCode: upstream.status, ...usage, ttftMs: nonStreamTtftMs, retryCount: attempt, retryReason: attempt > 0 ? 'account_rotation' : undefined, estimatedCostUsd: estimateCost(model, usage, 'glm'), latencyMs: Date.now() - started, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
      enforceAfterUsage(auth.user, 'glm', auth.token, model);
      if (forcedLogReason) logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: { forcedLogReason, providerAccountLabel: account.label, attempt: attempt + 1, headers: req.headers, body }, responseText: text });
      else if (shouldLogBody(auth.user)) logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: body, responseText: text });
      reply.code(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(text);
      return;
    } catch (err: any) {
      release();
      const timedOut = isAbortTimeoutError(err);
      lastError = timedOut ? timeoutMessage(timeoutSeconds(REQUEST_TIMEOUT_MS)) : transientNetworkMessage('glm');
      if (!timedOut) {
        markGlmCooldown(account.id, 60_000, `network error: ${err?.message || err}`);
        req.log?.info?.({ provider: 'glm', account: account.label, model, attempt: attempt + 1, error: String(err?.message || err) }, 'GLM network error; switching to another account');
      }
      const statusCode = timedOut ? 504 : 502;
      const usageEventId = recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'glm', endpoint: `/v1/glm${endpoint}`, model, stream, statusCode, inputTokens: inputEstimate, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
      if (timedOut) {
        logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: { forcedLogReason: 'glm_timeout', providerAccountLabel: account.label, attempt: attempt + 1, headers: req.headers, body }, responseText: JSON.stringify(openAiError(lastError, 'timeout', 'gateway_timeout')) });
        reply.code(504).send(openAiError(lastError, 'timeout', 'gateway_timeout'));
        return;
      }
    }
  }

  reply.header('retry-after', String(retryAfter));
  reply.header('x-gateway-provider', 'glm');
  if (fallbackFrom) reply.header('x-gateway-glm-fallback', fallbackFrom);
  reply.code(429).send(openAiError(`GLM capacity unavailable: ${lastError}`, 'rate_limit_exceeded', 'rate_limit_exceeded'));
}

export function registerGlmProxy(app: FastifyInstance) {
  // Standard Anthropic clients (Claude Code, OpenClaw anthropic provider) post to
  // `${ANTHROPIC_BASE_URL}/v1/messages`. With base `.../v1/glm` that resolves to
  // `/v1/glm/v1/messages`, so register that as the canonical path. Keep the short
  // `/v1/glm/messages` form as an alias for direct callers.
  app.post('/v1/glm/v1/messages', (req, reply) => forwardGlm(req, reply));
  app.post('/v1/glm/messages', (req, reply) => forwardGlm(req, reply));
}
