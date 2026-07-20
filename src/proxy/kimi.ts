import type { FastifyInstance } from 'fastify';
import { writeRawResponseHead } from '../http/response-headers.js';
import { config } from '../config.js';
import { requireProxyToken } from '../auth/token-auth.js';
import { recordUsage } from './usage.js';
import { compressionFields } from './compress.js';
import { checkLooseLimit, enforceAfterUsage, isModelAllowedForUser, logRequestResponse, shouldLogBody } from './policy.js';
import { estimateCost } from './cost.js';
import { acquireKimiSlot, DEFAULT_KIMI_MODEL, KNOWN_KIMI_MODELS, markKimiCooldown, recordKimiSuccess, releaseKimiSlot, selectKimiAccount } from '../providers/kimi-pool.js';
import { isAbortTimeoutError, isModelUnavailableError, modelUnavailableError, surfaceOpenAiCompatError, surfaceOpenAiCompatStreamChunk, timeoutMessage, timeoutSeconds, transientNetworkMessage, type OpenAiCompatStreamState } from './openai-compat-errors.js';
import { emptyNormalizedUsage } from '../normalize/events.js';
import {
  classifyKimiTerminal,
  collectKimiEvents,
  lastUsageFromEvents,
} from '../normalize/kimi.js';

const REQUEST_TIMEOUT_MS = 20 * 60 * 1000;


// Kimi (Moonshot) returns HTTP 429 for BOTH normal rate-limits AND account
// suspension due to insufficient balance. Body distinguishes them.
export function isKimiInsufficientBalance(status: number, body: string): boolean {
  if (status !== 429) return false;
  const lower = (body || '').toLowerCase();
  return /exceeded_current_quota_error/.test(lower)
    || /insufficient.?balance/.test(lower)
    || /account is suspended/.test(lower)
    || /recharge/.test(lower);
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

// Kimi For Coding enforces a coding-agent client check (User-Agent and a
// handful of Anthropic SDK fingerprints). Without these, the OpenAI-style
// `/coding/v1/chat/completions` endpoint returns 403 access_terminated_error.
// The Anthropic-style `/coding/v1/messages` endpoint passes naturally because
// it shares the Claude Code fingerprint surface. We apply the same fingerprint
// to both routes so OpenAI clients also get through.
const KIMI_CC_VERSION = '2.1.97';
function applyKimiCodingHeaders(headers: Headers, stream: boolean) {
  // Always identify as Claude Code-class CLI client (matches Kimi's allowlist).
  headers.set('user-agent', `claude-cli/${KIMI_CC_VERSION} (third-party, cli)`);
  headers.set('x-app', 'cli');
  headers.set('x-stainless-arch', process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : process.arch);
  headers.set('x-stainless-lang', 'js');
  headers.set('x-stainless-os', process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux');
  headers.set('x-stainless-package-version', '0.81.0');
  headers.set('x-stainless-runtime', 'node');
  headers.set('x-stainless-runtime-version', process.version);
  headers.set('x-stainless-retry-count', '0');
  headers.set('x-stainless-timeout', '600');
  if (stream) headers.set('x-stainless-helper-method', 'stream');
}

function cleanHeaders(reqHeaders: Record<string, any>, stream: boolean, anthropic = false): Headers {
  const headers = new Headers();
  for (const [k, v] of Object.entries(reqHeaders)) {
    if (v == null) continue;
    const lk = k.toLowerCase();
    // Strip client auth headers AND any client identification headers — we
    // overwrite all of them with Claude-Code-style fingerprints below.
    if (['authorization', 'x-api-key', 'host', 'content-length', 'user-agent', 'x-app',
         'x-stainless-arch', 'x-stainless-lang', 'x-stainless-os', 'x-stainless-package-version',
         'x-stainless-runtime', 'x-stainless-runtime-version', 'x-stainless-retry-count',
         'x-stainless-timeout', 'x-stainless-helper-method'].includes(lk)) continue;
    headers.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  headers.set('content-type', 'application/json');
  headers.set('accept', stream ? 'text/event-stream' : 'application/json');
  if (anthropic && !headers.has('anthropic-version')) headers.set('anthropic-version', '2023-06-01');
  applyKimiCodingHeaders(headers, stream);
  return headers;
}

function parseUsageFromObject(parsed: any, fallbackInput: number) {
  const u = parsed?.usage || parsed?.response?.usage || parsed?.message?.usage;
  return {
    inputTokens: u?.input_tokens ?? u?.prompt_tokens ?? fallbackInput,
    outputTokens: u?.output_tokens ?? u?.completion_tokens ?? 0,
    cacheCreationTokens: u?.cache_creation_input_tokens ?? 0,
    // Kimi/Moonshot non-stream usage puts cache reads at the TOP LEVEL of
    // `usage` (usage.cached_tokens), not only under input/prompt_tokens_details.
    // Missing this key under-reported cache reads even once caching engaged.
    cacheReadTokens: u?.cache_read_input_tokens ?? u?.input_tokens_details?.cached_tokens ?? u?.prompt_tokens_details?.cached_tokens ?? u?.cached_tokens ?? 0,
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
        cacheReadTokens: u.cache_read_input_tokens ?? u.input_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? u.cached_tokens ?? state.usage.cacheReadTokens ?? 0,
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

function normalizeK3ReasoningEffort(body: Record<string, any>): string | null {
  // Kimi Code currently documents max/none for K3. Normalize documented aliases
  // locally so users get deterministic gateway errors instead of opaque upstream
  // 400s; Hermes emits high/low, so normalize those compatibility aliases to
  // K3's maximum effort rather than rejecting an otherwise valid client.
  const raw = body.reasoning_effort;
  if (raw == null || (typeof raw === 'string' && raw.trim() === '')) {
    body.reasoning_effort = 'max';
    return null;
  }
  if (typeof raw !== 'string') return 'K3 reasoning_effort must be a string.';
  const effort = raw.trim().toLowerCase();
  if (effort === 'max' || effort === 'ultra' || effort === 'xhigh' || effort === 'high' || effort === 'low') {
    body.reasoning_effort = 'max';
    return null;
  }
  if (effort === 'none') {
    body.reasoning_effort = 'none';
    return null;
  }
  return 'K3 supports reasoning_effort "max" (also ultra/xhigh) or "none".';
}

async function forwardKimi(req: any, reply: any, endpoint: '/chat/completions' | '/messages', anthropic: boolean) {
  const auth = await requireProxyToken(req, reply);
  if (!auth) return;
  const started = Date.now();

  const body = { ...((req.body as any) || {}) };
  const rawModel = typeof body.model === 'string' && body.model ? body.model : undefined;
  const requestedModel = rawModel || DEFAULT_KIMI_MODEL;
  const model = KNOWN_KIMI_MODELS.has(requestedModel) ? requestedModel : DEFAULT_KIMI_MODEL;
  const fallbackFrom = model !== requestedModel ? requestedModel : '';
  const allowed = isModelAllowedForUser(auth.user, 'kimi', model);
  if (!allowed.ok) {
    reply.code(400).send(modelNotAllowedForUserError(allowed.message));
    return;
  }
  body.model = model;
  if (model === 'k3' && !anthropic) {
    const k3ReasoningError = normalizeK3ReasoningEffort(body);
    if (k3ReasoningError) {
      reply.code(400).send(openAiError(k3ReasoningError, 'invalid_request_error', 'invalid_reasoning_effort'));
      return;
    }
  }
  const limit = checkLooseLimit(auth.user, 'kimi', auth.token, model);
  if (!limit.ok) {
    reply.code(429).send(openAiError(limit.message, 'insufficient_quota', 'user_limit_exceeded'));
    return;
  }
  const stream = !!body.stream;
  const inputEstimate = estimateInputTokens(body);
  const conversationId = String(req.headers['x-conversation-id'] || req.headers['session_id'] || req.headers['x-client-request-id'] || body?.conversation_id || '');
  const stickyKey = `${auth.user.email}:${auth.token.label}:${conversationId || model || endpoint}`;

  // Kimi context caching: the Kimi Code Plan REQUIRES a `prompt_cache_key` to
  // engage prefix caching (Kimi docs, api/chat). We already derive a stable
  // conversation id from client headers but historically dropped it before the
  // upstream call, so cache hits sat at ~1%. Forward it as prompt_cache_key so
  // successive requests in the same coding session share a cached prefix.
  //
  // - Never override a client-supplied prompt_cache_key.
  // - Prefer the conversation id; fall back to the sticky routing key so even
  //   header-less clients on the same token/model get a stable per-session key
  //   (better than nothing; upstream only caches when the prefix actually
  //   matches, so a coarse key cannot produce wrong answers, only fewer hits).
  // - Only applies to the OpenAI-style /chat/completions route; the Anthropic
  //   /messages route has no documented prompt_cache_key field and Kimi caches
  //   it via the Anthropic cache_control surface instead.
  if (config.kimiForwardCacheKey && !anthropic && body.prompt_cache_key == null) {
    const cacheKey = conversationId || stickyKey;
    if (cacheKey) body.prompt_cache_key = cacheKey;
  }
  const tried: number[] = [];
  let lastError = 'No Kimi account available';
  let retryAfter = 60;

  for (let attempt = 0; attempt < 10; attempt++) {
    const account = selectKimiAccount(stickyKey, tried);
    if (!account) break;
    tried.push(account.id);
    if (!acquireKimiSlot(account)) {
      lastError = 'Kimi account at concurrency cap';
      continue;
    }
    let released = false;
    const release = () => { if (!released) { released = true; releaseKimiSlot(account); } };
    try {
      const headers = cleanHeaders(req.headers, stream, anthropic);
      headers.set('authorization', `Bearer ${account.secret}`);
      const upstream = await fetch(`${config.kimiUpstreamUrl}${endpoint}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      reply.header('x-gateway-provider', 'kimi');
      reply.header('x-gateway-account', account.label);
      reply.header('x-gateway-attempt', String(attempt + 1));
      if (fallbackFrom) reply.header('x-gateway-kimi-fallback', fallbackFrom);

      if (upstream.status === 429) {
        const text = await upstream.text().catch(() => '');
        release();
        let ms = retryAfterMs(upstream.headers.get('retry-after'));
        // Distinguish insufficient-balance (needs human recharge) from normal
        // rate-limit. Suspended Kimi accounts return 429 too, but a 60s retry
        // against them is futile until someone tops the balance up.
        let cooldownReason = `rate limited (${upstream.status})`;
        if (isKimiInsufficientBalance(upstream.status, text)) {
          ms = Math.max(ms, 24 * 60 * 60 * 1000);
          cooldownReason = 'insufficient_balance';
          req.log?.info?.({ provider: 'kimi', account: account.label, model, attempt: attempt + 1 }, 'Kimi account out of balance; switching to another account (long cooldown)');
        } else {
          req.log?.info?.({ provider: 'kimi', account: account.label, model, attempt: attempt + 1 }, 'Kimi rate limited; switching to another account');
        }
        retryAfter = Math.max(1, Math.ceil(ms / 1000));
        markKimiCooldown(account.id, ms, cooldownReason);
        recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'kimi', endpoint: `/v1/kimi${endpoint}`, model, stream, statusCode: upstream.status, inputTokens: inputEstimate, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: text.slice(0, 500) || 'rate limited', ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
        lastError = text.slice(0, 500) || 'rate limited';
        continue;
      }

      if (upstream.status >= 400) {
        const text = await upstream.text().catch(() => '');
        release();
        lastError = text.slice(0, 500) || String(upstream.status);
        if (isModelUnavailableError(upstream.status, text)) {
          const clean = modelUnavailableError('kimi', model);
          lastError = clean.error.message;
          recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'kimi', endpoint: `/v1/kimi${endpoint}`, model, stream, statusCode: upstream.status, inputTokens: inputEstimate, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
          reply.code(400).send(clean);
          return;
        }
        recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'kimi', endpoint: `/v1/kimi${endpoint}`, model, stream, statusCode: upstream.status, inputTokens: inputEstimate, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
        reply.code(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(text || openAiError(lastError));
        return;
      }

      if (stream && upstream.body) {
        writeRawResponseHead(reply, upstream.status, { 'content-type': upstream.headers.get('content-type') || 'text/event-stream', 'cache-control': 'no-cache', 'x-gateway-provider': 'kimi', 'x-gateway-account': account.label, ...(fallbackFrom ? { 'x-gateway-kimi-fallback': fallbackFrom } : {}) });

        // Phase 3 dual-path: NORMALIZE_KIMI=true uses the normalized adapter for
        // usage + terminal classification while passthrough-writing upstream SSE
        // to the client. When false, the legacy path is byte-identical to pre-Phase-3.
        if (config.normalizeKimi) {
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
            const forcedLogReason = timedOut ? 'kimi_timeout' : 'kimi_stream_interrupted';
            const interrupted = surfaceOpenAiCompatError('kimi', null, 'stream_interrupted', timedOut ? timeoutMessage(timeoutSeconds(REQUEST_TIMEOUT_MS)) : undefined).appendSse!;
            assembled += interrupted;
            reply.raw.write(interrupted);
            reply.raw.end();
            release();
            recordKimiSuccess(account.id);
            const usageEventId = recordUsage({
              userId: auth.user.id,
              tokenId: auth.token.id,
              providerAccountId: account.id,
              provider: 'kimi',
              endpoint: `/v1/kimi${endpoint}`,
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

          const events = await collectKimiEvents(chunks, {
            fallbackInputTokens: inputEstimate,
            startedAtMs: started,
          });
          const usage = lastUsageFromEvents(
            events,
            emptyNormalizedUsage({ inputTokens: inputEstimate }),
          );
          const terminal = classifyKimiTerminal(events);

          // Only invent kimi_stream_interrupted when there was no genuine
          // completion ([DONE] / message_stop / response.completed -> stop).
          // Incomplete streams map to kimi_stream_incomplete and get the same
          // client-visible interrupt SSE as the legacy path.
          let forcedLogReason: string | undefined;
          if (terminal.kind === 'incomplete') {
            forcedLogReason = 'kimi_stream_interrupted';
            const interrupted = surfaceOpenAiCompatError('kimi', null, 'stream_interrupted').appendSse!;
            assembled += interrupted;
            reply.raw.write(interrupted);
          }
          reply.raw.end();
          release();
          recordKimiSuccess(account.id);
          // CRITICAL BILLING PARITY: pass the same token fields legacy records,
          // especially cacheReadTokens (billable input = input - cacheRead).
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
            provider: 'kimi',
            endpoint: `/v1/kimi${endpoint}`,
            model,
            stream,
            statusCode: upstream.status,
            ...billingUsage,
            retryCount: attempt,
            retryReason: attempt > 0 ? 'account_rotation' : undefined,
            estimatedCostUsd: estimateCost(model, billingUsage, 'kimi'),
            latencyMs: Date.now() - started,
            ...compressionFields(req),
            tokenLabel: auth.token.label,
            providerAccountLabel: account.label,
          });
          enforceAfterUsage(auth.user, 'kimi', auth.token, model);
          if (forcedLogReason) logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: { forcedLogReason, providerAccountLabel: account.label, attempt: attempt + 1, headers: req.headers, body }, responseText: assembled });
          else if (shouldLogBody(auth.user)) logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: body, responseText: assembled });
          return;
        }

        // --- legacy path (NORMALIZE_KIMI off / default): unchanged from pre-Phase-3 ---
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
            const surfaced = surfaceOpenAiCompatStreamChunk('kimi', chunk, surfaceState);
            if (surfaced.appendSse) { assembled += surfaced.appendSse; reply.raw.write(surfaced.appendSse); }
            if (surfaced.forcedLogReason) forcedLogReason = surfaced.forcedLogReason;
          }
          const tail = decoder.decode();
          if (tail) { assembled += tail; absorbSseUsage(tail, sseState, inputEstimate); reply.raw.write(tail); }
        } catch (err: any) {
          forcedLogReason = isAbortTimeoutError(err) ? 'kimi_timeout' : 'kimi_stream_interrupted';
          const interrupted = surfaceOpenAiCompatError('kimi', null, 'stream_interrupted', isAbortTimeoutError(err) ? timeoutMessage(timeoutSeconds(REQUEST_TIMEOUT_MS)) : undefined).appendSse!;
          assembled += interrupted;
          reply.raw.write(interrupted);
        }
        absorbSseUsage('', sseState, inputEstimate, true);
        if (!surfaceState.sawCompletion && !forcedLogReason) {
          forcedLogReason = 'kimi_stream_interrupted';
          const interrupted = surfaceOpenAiCompatError('kimi', null, 'stream_interrupted').appendSse!;
          assembled += interrupted;
          reply.raw.write(interrupted);
        }
        reply.raw.end();
        release();
        recordKimiSuccess(account.id);
        const usageEventId = recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'kimi', endpoint: `/v1/kimi${endpoint}`, model, stream, statusCode: upstream.status, ...sseState.usage, ttftMs, retryCount: attempt, retryReason: attempt > 0 ? 'account_rotation' : undefined, estimatedCostUsd: estimateCost(model, sseState.usage, 'kimi'), latencyMs: Date.now() - started, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
        enforceAfterUsage(auth.user, 'kimi', auth.token, model);
        if (forcedLogReason) logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: { forcedLogReason, providerAccountLabel: account.label, attempt: attempt + 1, headers: req.headers, body }, responseText: assembled });
        else if (shouldLogBody(auth.user)) logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: body, responseText: assembled });
        return;
      }

      let text = await upstream.text();
      const nonStreamTtftMs = Date.now() - started;
      release();
      recordKimiSuccess(account.id);
      let forcedLogReason: string | undefined;
      try {
        const parsed = JSON.parse(text);
        const surfaced = surfaceOpenAiCompatError('kimi', parsed, 'non_stream');
        if (surfaced.changed) text = JSON.stringify(parsed);
        forcedLogReason = surfaced.forcedLogReason;
      } catch {}
      const usage = parseUsage(text, inputEstimate);
      const usageEventId = recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'kimi', endpoint: `/v1/kimi${endpoint}`, model, stream, statusCode: upstream.status, ...usage, ttftMs: nonStreamTtftMs, retryCount: attempt, retryReason: attempt > 0 ? 'account_rotation' : undefined, estimatedCostUsd: estimateCost(model, usage, 'kimi'), latencyMs: Date.now() - started, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
      enforceAfterUsage(auth.user, 'kimi', auth.token, model);
      if (forcedLogReason) logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: { forcedLogReason, providerAccountLabel: account.label, attempt: attempt + 1, headers: req.headers, body }, responseText: text });
      else if (shouldLogBody(auth.user)) logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: body, responseText: text });
      reply.code(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(text);
      return;
    } catch (err: any) {
      release();
      const timedOut = isAbortTimeoutError(err);
      lastError = timedOut ? timeoutMessage(timeoutSeconds(REQUEST_TIMEOUT_MS)) : transientNetworkMessage('kimi');
      if (!timedOut) {
        markKimiCooldown(account.id, 60_000, `network error: ${err?.message || err}`);
        req.log?.info?.({ provider: 'kimi', account: account.label, model, attempt: attempt + 1, error: String(err?.message || err) }, 'Kimi network error; switching to another account');
      }
      const statusCode = timedOut ? 504 : 502;
      const usageEventId = recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'kimi', endpoint: `/v1/kimi${endpoint}`, model, stream, statusCode, inputTokens: inputEstimate, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
      if (timedOut) {
        logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: { forcedLogReason: 'kimi_timeout', providerAccountLabel: account.label, attempt: attempt + 1, headers: req.headers, body }, responseText: JSON.stringify(openAiError(lastError, 'timeout', 'gateway_timeout')) });
        reply.code(504).send(openAiError(lastError, 'timeout', 'gateway_timeout'));
        return;
      }
    }
  }

  reply.header('retry-after', String(retryAfter));
  reply.header('x-gateway-provider', 'kimi');
  if (fallbackFrom) reply.header('x-gateway-kimi-fallback', fallbackFrom);
  reply.code(429).send(openAiError(`Kimi capacity unavailable: ${lastError}`, 'rate_limit_exceeded', 'rate_limit_exceeded'));
}

export function registerKimiProxy(app: FastifyInstance) {
  app.post('/v1/kimi/chat/completions', (req, reply) => forwardKimi(req, reply, '/chat/completions', false));
  app.post('/v1/kimi/messages', (req, reply) => forwardKimi(req, reply, '/messages', true));
}
