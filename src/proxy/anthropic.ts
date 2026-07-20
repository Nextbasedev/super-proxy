import type { FastifyInstance } from 'fastify';
import { writeRawResponseHead } from '../http/response-headers.js';
import { config } from '../config.js';
import { requireProxyToken } from '../auth/token-auth.js';
import { classifyProviderError, markCooldown, markDead, selectAccount } from '../providers/governor.js';
import { recordUsage } from './usage.js';
import { compressionFields } from './compress.js';
import { checkLooseLimit, enforceAfterUsage, isModelAllowedForUser, logRequestResponse, shouldLogBody } from './policy.js';
import { estimateCost } from './cost.js';
import { fallbackAnthropicToGlm } from './fallback.js';
import {
  applyClaudeCodeOAuthHeaders,
  processBody as ccProcessBody,
  reverseMap as ccReverseMap,
  reverseMapJsonResponse as ccReverseMapJsonResponse,
  SseReverseMapper,
} from '../anthropic/claude-code-transform.js';
import {
  applyHermesOAuthHeaders,
  isHermesBody,
  processHermesBody,
  reverseMapHermes,
  reverseMapHermesJsonResponse,
  HermesSseReverseMapper,
} from '../anthropic/hermes-transform.js';

const REQUEST_HEADER_BLOCKLIST = new Set([
  'authorization', 'x-api-key', 'api-key', 'apikey', 'cookie', 'host', 'content-length',
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te',
  'proxy-connection', 'trailer', 'transfer-encoding', 'upgrade',
]);

const RESPONSE_HEADER_BLOCKLIST = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te',
  'proxy-connection', 'trailer', 'transfer-encoding', 'upgrade', 'content-length', 'content-encoding',
  'set-cookie',
]);

const RESPONSE_HEADER_ALLOWLIST = new Set([
  'content-type', 'cache-control', 'retry-after', 'request-id', 'x-request-id',
  'anthropic-request-id', 'x-should-retry',
]);

const RESPONSE_HEADER_PREFIX_ALLOWLIST = ['anthropic-ratelimit-', 'x-ratelimit-', 'ratelimit-'];

function safeUpstreamResponseHeaders(headers: Headers): Record<string, string> {
  const connectionHeaders = new Set(
    [headers.get('connection'), headers.get('proxy-connection')]
      .flatMap((value) => (value || '').split(','))
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
  const safe: Record<string, string> = {};
  for (const [name, value] of headers.entries()) {
    const lower = name.toLowerCase();
    const operational = RESPONSE_HEADER_ALLOWLIST.has(lower) || RESPONSE_HEADER_PREFIX_ALLOWLIST.some((prefix) => lower.startsWith(prefix));
    if (operational
      && !RESPONSE_HEADER_BLOCKLIST.has(lower)
      && !connectionHeaders.has(lower)
      && !lower.startsWith('x-gateway-')) safe[lower] = value;
  }
  return safe;
}

function applySafeUpstreamResponseHeaders(reply: any, headers: Headers): void {
  for (const [name, value] of Object.entries(safeUpstreamResponseHeaders(headers))) reply.header(name, value);
}

function modelNotAllowedForUserError(message: string) {
  return { type: 'error', error: { type: 'invalid_request_error', code: 'model_not_allowed_for_user', message } };
}

function retryAfterMs(headers: Headers): number {
  const retry = headers.get('retry-after');
  if (!retry) return 15 * 60 * 1000;
  const n = Number(retry);
  if (Number.isFinite(n)) return Math.max(1, n) * 1000;
  const d = Date.parse(retry);
  return Number.isFinite(d) ? Math.max(1000, d - Date.now()) : 15 * 60 * 1000;
}

function extractUsage(bodyText: string): { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number } {
  try {
    const parsed = JSON.parse(bodyText);
    const u = parsed.usage || {};
    return {
      inputTokens: u.input_tokens || 0,
      outputTokens: u.output_tokens || 0,
      cacheCreationTokens: u.cache_creation_input_tokens || 0,
      cacheReadTokens: u.cache_read_input_tokens || 0,
    };
  } catch {
    return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  }
}

function anthropicError(status: number, message: string, type = 'api_error') {
  return { type: 'error', error: { type, message } };
}

function isAnthropicQuotaExhaustedError(text: string): boolean {
  return /third-party apps now draw from your usage quota/i.test(text)
    || /you're out of usage quota/i.test(text)
    || /you are out of usage quota/i.test(text);
}

function isAnthropicAccountSuspendedError(status: number, text: string): boolean {
  return status === 403 && /suspended|disabled|claude code subscription/i.test(text);
}

function isAnthropicPromptTooLongError(status: number, text: string): boolean {
  return status === 400 && /prompt is too long/i.test(text);
}

function isAnthropicThinkingDisabledUnsupportedError(status: number, text: string): boolean {
  return status === 400
    && /thinking\.type\.disabled/i.test(text)
    && /not supported for this model/i.test(text)
    && /thinking defaults to adaptive mode when not specified/i.test(text);
}

const ANTHROPIC_PROMPT_TOO_LONG_MESSAGE = 'Prompt too long for Anthropic context window. If using prompt caching, the cache may have evicted — retry without `cache_control` markers.';

function formatMidStreamErrorMessage(errorType: string, message: string): string {
  return `⚠️ Anthropic error mid-stream (type: ${errorType}): ${message}`;
}

function pauseTurnMessage(): string {
  return 'ℹ️ Claude paused this turn (pause_turn). Send another message to continue.';
}

function maxTokensMessage(outputTokens: number): string {
  return `\n\n[truncated: max_tokens reached at ${outputTokens} output tokens]`;
}

// Anthropic rolled out `stop_reason: "refusal"` with `stop_details` for safety-
// triggered blocks (e.g. cyber, weapons). Upstream is 200 OK with an empty
// content array, so downstream clients render a blank assistant turn. We
// detect refusals and synthesize a visible text block so users see what
// happened, plus force-log the request for diagnostics.
export function formatRefusalMessage(stopDetails: any): string {
  const category = typeof stopDetails?.category === 'string' && stopDetails.category ? stopDetails.category : 'safety';
  const explanation = typeof stopDetails?.explanation === 'string' && stopDetails.explanation
    ? stopDetails.explanation
    : 'Anthropic blocked this request as part of their safety safeguards.';
  return `\u26d4 Claude refused this request (category: ${category}).\n\n${explanation}`;
}

export function surfaceAnthropicErrorBlock(message: string, index: number): string {
  const start = `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })}\n\n`;
  const delta = `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: message } })}\n\n`;
  const stop = `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index })}\n\n`;
  return start + delta + stop;
}

export function buildRefusalSseEvents(message: string, index = 0): string {
  return surfaceAnthropicErrorBlock(message, index);
}

function buildContentBlockStopEvent(index: number): string {
  return `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index })}\n\n`;
}

function buildMessageDeltaStopEvent(stopReason: string): string {
  return `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: stopReason } })}\n\n`;
}

function buildMessageStopEvent(): string {
  return `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`;
}

export function registerAnthropicProxy(app: FastifyInstance) {
  const handleMessages = async (req: any, reply: any) => {
    const rawMode = req.url.startsWith('/v1/anthropic-raw/');
    const endpoint = rawMode ? '/v1/anthropic-raw/v1/messages' : '/v1/messages';
    const auth = await requireProxyToken(req, reply);
    if (!auth) return;
    const started = Date.now();
    const body = req.body as any;
    const model = typeof body?.model === 'string' ? body.model : undefined;
    const stream = !!body?.stream;
    const allowed = isModelAllowedForUser(auth.user, 'anthropic', model);
    if (!allowed.ok) {
      reply.code(400).send(modelNotAllowedForUserError(allowed.message));
      return;
    }
    const limit = checkLooseLimit(auth.user, 'anthropic', auth.token, model);
    if (!limit.ok) {
      reply.code(429).send(anthropicError(429, limit.message, 'rate_limit_error'));
      return;
    }
    const conversationId = String(req.headers['x-conversation-id'] || req.headers['anthropic-session-id'] || '');
    const stickyKey = `${auth.user.email}:${auth.token.label}:${conversationId || model || 'default'}`;

    const attempts = 10;
    let lastError = 'No Anthropic key available';
    // Why the previous attempt failed — recorded as retry_reason on the attempt
    // that eventually succeeds (attempt > 0 means we rotated at least once).
    let lastRetryReason: 'rate_limited' | 'account_rotation' | 'upstream_error' | undefined;
    // A bare pool exhaustion is capacity-related. Once an upstream response is
    // seen, retain whether that terminal class is eligible for cross-provider
    // fallback so auth/policy/client errors cannot turn into a fallback 503.
    let lastFailureEligibleForFallback = true;
    const tryCrossProviderFallback = async (status: number): Promise<boolean> => {
      if (rawMode) return false;
      const fallback = await fallbackAnthropicToGlm(app, req, body, status);
      if (!fallback) return false;
      // Anthropic writes attribution before an eligible failure. GLM can reject
      // the injected request before selecting an account, so clear that stale
      // attribution and let any GLM replacements below win.
      reply.removeHeader('x-gateway-account');
      reply.removeHeader('x-gateway-attempt');
      for (const [name, value] of Object.entries(fallback.gatewayHeaders)) reply.header(name, value);
      reply.header('x-gateway-provider', 'glm');
      reply.header('x-gateway-fallback-from', 'anthropic');
      reply.code(fallback.statusCode).type(fallback.contentType || 'application/json').send(fallback.body);
      return true;
    };
    for (let attempt = 0; attempt < attempts; attempt++) {
      const selection = selectAccount('anthropic', stickyKey + ':' + attempt);
      if (!selection) break;
      const { account, release } = selection;
      let usage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
      try {
        const clientHeaders = req.headers;
        const headers = new Headers();
        const connectionHeaders = new Set(
          [clientHeaders.connection, clientHeaders['proxy-connection']]
            .flatMap((value) => Array.isArray(value) ? value : [value])
            .flatMap((value) => String(value || '').split(','))
            .map((name) => name.trim().toLowerCase())
            .filter(Boolean),
        );
        for (const [key, value] of Object.entries(req.headers)) {
          const lowerKey = key.toLowerCase();
          // Never forward gateway credentials, cookies, hop-by-hop headers, or
          // headers nominated by Connection. Only the pooled upstream secret is
          // allowed to leave the gateway as authentication.
          if (!value || REQUEST_HEADER_BLOCKLIST.has(lowerKey) || connectionHeaders.has(lowerKey)) continue;
          headers.set(key, Array.isArray(value) ? value.join(',') : String(value));
        }
        headers.set('authorization', `Bearer ${account.secret}`);
        headers.set('content-type', 'application/json');
        const isOAuth = account.secret.startsWith('sk-ant-oat');
        // Client-type detection: Hermes namespaces its MCP tools as `mcp_<tool>`;
        // OCPlatform uses bare tool names. We branch the transform layer so the
        // OCPlatform path stays byte-for-byte unchanged while Hermes gets its own
        // (sdk-cli entrypoint, mcp__hermes__ namespacing, system relocation).
        // Only relevant for OAuth accounts (API-key accounts forward unchanged).
        const rawBodyStr = JSON.stringify(body);
        const isHermes = !rawMode && isOAuth && isHermesBody(rawBodyStr);
        if (!rawMode && isOAuth) {
          if (isHermes) applyHermesOAuthHeaders(headers);
          else applyClaudeCodeOAuthHeaders(headers);
        }
        // OAuth accounts: run the appropriate transform on the raw JSON string.
        // OCPlatform -> ccProcessBody (vendored proxy transform). Hermes ->
        // processHermesBody (sandbox-verified). Raw API keys: body unchanged.
        const upstreamBodyStr = !rawMode && isOAuth
          ? (isHermes ? processHermesBody(rawBodyStr) : ccProcessBody(rawBodyStr))
          : rawBodyStr;

        const upstream = await fetch(`${config.anthropicUpstreamUrl}/v1/messages`, {
          method: 'POST',
          headers,
          body: upstreamBodyStr,
          signal: AbortSignal.timeout(20 * 60 * 1000),
        });

        reply.header('x-gateway-provider', 'anthropic');
        reply.header('x-gateway-account', account.label);
        reply.header('x-gateway-attempt', String(attempt + 1));

        if (upstream.status >= 400) {
          let text = await upstream.text();
          if (!rawMode && isOAuth) text = isHermes ? reverseMapHermes(text) : ccReverseMap(text);
          let kind = upstream.status === 529 ? 'rate_limit' : classifyProviderError(upstream.status, text);
          const promptTooLong = isAnthropicPromptTooLongError(upstream.status, text);
          const thinkingDisabledUnsupported = isAnthropicThinkingDisabledUnsupportedError(upstream.status, text);
          const oauthSuspended = isAnthropicAccountSuspendedError(upstream.status, text);
          lastFailureEligibleForFallback = upstream.status === 429 || upstream.status === 529 || upstream.status >= 500;
          if (promptTooLong || thinkingDisabledUnsupported) kind = 'fatal';
          if (oauthSuspended) kind = 'dead';
          lastError = upstream.status === 529 ? 'Anthropic overloaded across pool; retrying' : (text.slice(0, 500) || kind);
          if (promptTooLong) lastError = ANTHROPIC_PROMPT_TOO_LONG_MESSAGE;

          if (oauthSuspended) markDead(account.id, 'oauth_suspended');
          else if (kind === 'rate_limit') markCooldown(account.id, retryAfterMs(upstream.headers), 'rate_limit');
          else if (kind === 'dead') markDead(account.id, 'auth_invalid');
          else if (kind === 'permission') markCooldown(account.id, 60 * 60 * 1000, 'permission');
          else if (kind === 'temporary') markCooldown(account.id, 60_000, 'temporary');
          lastRetryReason = kind === 'rate_limit' ? 'rate_limited' : 'account_rotation';

          if (rawMode) {
            release();
            const usageEventId = recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'anthropic', endpoint, model, stream, statusCode: upstream.status, latencyMs: Date.now() - started, error: text.slice(0, 500), retryCount: attempt, retryReason: lastRetryReason, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
            if (shouldLogBody(auth.user)) logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: body, responseText: text });
            applySafeUpstreamResponseHeaders(reply, upstream.headers);
            reply.code(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(text);
            return;
          }

          release();
          const usageEventId = recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'anthropic', endpoint, model, stream, statusCode: upstream.status, latencyMs: Date.now() - started, error: lastError, retryCount: attempt, retryReason: attempt > 0 ? lastRetryReason : undefined, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
          if (isAnthropicQuotaExhaustedError(text)) {
            logRequestResponse({
              usageEventId,
              userId: auth.user.id,
              requestBody: {
                forcedLogReason: 'anthropic_quota_exhausted',
                providerAccountLabel: account.label,
                attempt: attempt + 1,
                headers: req.headers,
                body,
              },
              responseText: text,
            });
          } else if (shouldLogBody(auth.user)) {
            logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: body, responseText: text });
          }
          if (!promptTooLong && ['rate_limit', 'temporary', 'dead', 'permission'].includes(kind) && attempt < attempts - 1) continue;
          if (promptTooLong) {
            reply.code(400).type('application/json').send(anthropicError(400, ANTHROPIC_PROMPT_TOO_LONG_MESSAGE, 'invalid_request_error'));
          } else if (upstream.status === 529) {
            if (await tryCrossProviderFallback(upstream.status)) return;
            reply.code(529).type('application/json').send(anthropicError(529, 'Anthropic overloaded across pool; retrying', 'rate_limit_error'));
          } else {
            if (await tryCrossProviderFallback(upstream.status)) return;
            reply.code(upstream.status).type('application/json').send(text || anthropicError(upstream.status, kind));
          }
          return;
        }

        if (stream && upstream.body) {
          const streamHeaders = rawMode ? safeUpstreamResponseHeaders(upstream.headers) : {};
          streamHeaders['content-type'] ||= upstream.headers.get('content-type') || 'text/event-stream';
          streamHeaders['cache-control'] ||= 'no-cache';
          streamHeaders['x-gateway-provider'] = 'anthropic';
          streamHeaders['x-gateway-account'] = account.label;
          const reader = upstream.body.getReader();
          const decoder = new TextDecoder();
          let ttftMs: number | undefined;
          let assembled = '';
          let lastUsage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };

          if (rawMode) {
            let awaitingRead = false;
            let streamFailure: string | undefined;
            let streamFailureSource: 'upstream_read' | 'downstream_write' | undefined;
            let rawStreamErrorDetails: { type: string; message: string } | null = null;
            try {
              writeRawResponseHead(reply, upstream.status, streamHeaders);
              while (true) {
                awaitingRead = true;
                const { done, value } = await reader.read();
                awaitingRead = false;
                if (done) break;
                if (ttftMs === undefined) ttftMs = Date.now() - started;
                assembled += decoder.decode(value, { stream: true });
                reply.raw.write(value);
              }
              assembled += decoder.decode();
            } catch (err: any) {
              streamFailure = err?.message || String(err);
              streamFailureSource = awaitingRead ? 'upstream_read' : 'downstream_write';
              awaitingRead = false;
              try {
                if (streamFailureSource === 'upstream_read') markCooldown(account.id, 60_000, 'anthropic_stream_read_error');
                else await reader.cancel().catch(() => {});
              } catch (cleanupError: any) {
                req.log?.error?.({ err: cleanupError?.message || String(cleanupError) }, 'failed to clean up raw Anthropic stream failure');
              }
            } finally {
              for (const match of assembled.matchAll(/data:\s*(\{[^\r\n]*\})/g)) {
                try {
                  const evt = JSON.parse(match[1]);
                  const u = evt.usage || evt.message?.usage || evt.delta?.usage;
                  if (u) lastUsage = {
                    inputTokens: u.input_tokens ?? lastUsage.inputTokens,
                    outputTokens: u.output_tokens ?? lastUsage.outputTokens,
                    cacheCreationTokens: u.cache_creation_input_tokens ?? lastUsage.cacheCreationTokens,
                    cacheReadTokens: u.cache_read_input_tokens ?? lastUsage.cacheReadTokens,
                  };
                  if (!rawStreamErrorDetails && evt.type === 'error') {
                    const errorType = typeof evt.error?.type === 'string' ? evt.error.type : 'api_error';
                    const message = typeof evt.error?.message === 'string' ? evt.error.message : 'Anthropic returned an error after the stream started.';
                    rawStreamErrorDetails = { type: errorType, message };
                    if (errorType === 'overloaded_error') markCooldown(account.id, 60_000, 'anthropic_mid_stream_error');
                    else if (errorType === 'api_error' || errorType === 'internal_server_error') markCooldown(account.id, 30_000, 'anthropic_mid_stream_error');
                  }
                } catch {}
              }
              try {
                if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.end();
              } catch {}
              const cost = estimateCost(model, lastUsage, 'anthropic');
              try {
                release({ inputTokens: lastUsage.inputTokens + lastUsage.cacheCreationTokens + lastUsage.cacheReadTokens, outputTokens: lastUsage.outputTokens, costUsd: cost });
              } catch (releaseError: any) {
                req.log?.error?.({ err: releaseError?.message || String(releaseError) }, 'failed to release raw Anthropic stream account');
              }
              try {
                const usageEventId = recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'anthropic', endpoint, model, stream, statusCode: streamFailureSource === 'upstream_read' ? 502 : upstream.status, inputTokens: lastUsage.inputTokens, outputTokens: lastUsage.outputTokens, cacheCreationTokens: lastUsage.cacheCreationTokens, cacheReadTokens: lastUsage.cacheReadTokens, estimatedCostUsd: cost, latencyMs: Date.now() - started, ttftMs, error: streamFailure || rawStreamErrorDetails?.message, retryCount: attempt, retryReason: streamFailureSource, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
                enforceAfterUsage(auth.user, 'anthropic', auth.token, model);
                if (shouldLogBody(auth.user)) logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: body, responseText: assembled });
              } catch (accountingError: any) {
                req.log?.error?.({ err: accountingError?.message || String(accountingError) }, 'failed to account raw Anthropic stream');
              }
            }
            return;
          }

          writeRawResponseHead(reply, upstream.status, streamHeaders);
          let pending = '';
          const sseMapper = isOAuth ? (isHermes ? new HermesSseReverseMapper() : new SseReverseMapper()) : null;
          let refusalDetails: any = null;
          let midStreamErrorDetails: any = null;
          let streamInterrupted = false;
          let pauseTurnInjected = false;
          let maxTokensInjected = false;
          let messageStopSeen = false;
          // Track the next available content block index for synthetic blocks.
          // Use max(index)+1 rather than a plain count so non-contiguous or
          // future upstream indices do not collide.
          let seenContentBlocks = 0;
          const openContentBlockIndexes = new Set<number>();
          const allocateSyntheticIndex = () => seenContentBlocks++;
          const handleEvent = (event: string) => {
            let syntheticInjection = '';
            const matches = event.matchAll(/data:\s*(\{.*\})/g);
            for (const m of matches) {
              try {
                const evt = JSON.parse(m[1]);
                const u = evt.usage || evt.message?.usage || evt.delta?.usage;
                if (u) lastUsage = { inputTokens: u.input_tokens || lastUsage.inputTokens, outputTokens: u.output_tokens || lastUsage.outputTokens, cacheCreationTokens: u.cache_creation_input_tokens || lastUsage.cacheCreationTokens, cacheReadTokens: u.cache_read_input_tokens || lastUsage.cacheReadTokens };
                if (evt.type === 'content_block_start') {
                  const idx = Number(evt.index);
                  if (Number.isFinite(idx)) {
                    seenContentBlocks = Math.max(seenContentBlocks, idx + 1);
                    openContentBlockIndexes.add(idx);
                  } else {
                    openContentBlockIndexes.add(allocateSyntheticIndex());
                  }
                }
                if (evt.type === 'content_block_stop') {
                  const idx = Number(evt.index);
                  if (Number.isFinite(idx)) openContentBlockIndexes.delete(idx);
                }
                if (evt.type === 'message_stop') messageStopSeen = true;
                if (!rawMode && !midStreamErrorDetails && evt.type === 'error') {
                  const errorType = typeof evt.error?.type === 'string' ? evt.error.type : 'api_error';
                  const message = typeof evt.error?.message === 'string' ? evt.error.message : 'Anthropic returned an error after the stream started.';
                  midStreamErrorDetails = { type: errorType, message, raw: evt };
                  syntheticInjection += surfaceAnthropicErrorBlock(formatMidStreamErrorMessage(errorType, message), allocateSyntheticIndex());
                  if (errorType === 'overloaded_error') markCooldown(account.id, 60_000, 'anthropic_mid_stream_error');
                  else if (errorType === 'api_error' || errorType === 'internal_server_error') markCooldown(account.id, 30_000, 'anthropic_mid_stream_error');
                }
                if (!rawMode && !refusalDetails && evt.type === 'message_delta' && evt.delta?.stop_reason === 'refusal') {
                  refusalDetails = evt.delta?.stop_details || { category: 'safety' };
                  syntheticInjection += buildRefusalSseEvents(formatRefusalMessage(refusalDetails), allocateSyntheticIndex());
                }
                if (!rawMode && !pauseTurnInjected && evt.type === 'message_delta' && evt.delta?.stop_reason === 'pause_turn') {
                  pauseTurnInjected = true;
                  syntheticInjection += surfaceAnthropicErrorBlock(pauseTurnMessage(), allocateSyntheticIndex());
                }
                if (!rawMode && !maxTokensInjected && evt.type === 'message_delta' && evt.delta?.stop_reason === 'max_tokens') {
                  maxTokensInjected = true;
                  syntheticInjection += surfaceAnthropicErrorBlock(maxTokensMessage(lastUsage.outputTokens), allocateSyntheticIndex());
                }
              } catch {}
            }
            if (syntheticInjection) {
              assembled += syntheticInjection;
              reply.raw.write(syntheticInjection);
            }
            const out = sseMapper ? sseMapper.transform(event) : event;
            assembled += out;
            reply.raw.write(out);
          };
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (ttftMs === undefined) ttftMs = Date.now() - started;
            pending += decoder.decode(value, { stream: true });
            let sepIdx;
            while ((sepIdx = pending.indexOf('\n\n')) !== -1) {
              const event = pending.slice(0, sepIdx + 2);
              pending = pending.slice(sepIdx + 2);
              handleEvent(event);
            }
          }
          pending += decoder.decode();
          if (pending.length > 0) handleEvent(pending);
          if (!rawMode && !messageStopSeen) {
            streamInterrupted = true;
            let interruption = '';
            for (const idx of [...openContentBlockIndexes].sort((a, b) => a - b)) {
              interruption += buildContentBlockStopEvent(idx);
            }
            openContentBlockIndexes.clear();
            interruption += buildMessageDeltaStopEvent('interrupted');
            interruption += buildMessageStopEvent();
            assembled += interruption;
            reply.raw.write(interruption);
          }
          reply.raw.end();
          const cost = estimateCost(model, lastUsage, 'anthropic');
          const usageEventId = recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'anthropic', endpoint, model, stream, statusCode: upstream.status, inputTokens: lastUsage.inputTokens, outputTokens: lastUsage.outputTokens, cacheCreationTokens: lastUsage.cacheCreationTokens, cacheReadTokens: lastUsage.cacheReadTokens, estimatedCostUsd: cost, latencyMs: Date.now() - started, ttftMs, retryCount: attempt, retryReason: attempt > 0 ? lastRetryReason : undefined, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
          enforceAfterUsage(auth.user, 'anthropic', auth.token, model);
          release({ inputTokens: lastUsage.inputTokens + lastUsage.cacheCreationTokens + lastUsage.cacheReadTokens, outputTokens: lastUsage.outputTokens, costUsd: cost });
          let forcedRequestBody: any = null;
          if (midStreamErrorDetails) forcedRequestBody = { forcedLogReason: 'anthropic_mid_stream_error', providerAccountLabel: account.label, attempt: attempt + 1, midStreamError: midStreamErrorDetails, streamInterrupted, headers: req.headers, body };
          else if (streamInterrupted) forcedRequestBody = { forcedLogReason: 'anthropic_stream_interrupted', providerAccountLabel: account.label, attempt: attempt + 1, headers: req.headers, body };
          else if (refusalDetails) forcedRequestBody = { forcedLogReason: 'anthropic_refusal', providerAccountLabel: account.label, attempt: attempt + 1, refusal: refusalDetails, headers: req.headers, body };
          if (forcedRequestBody) {
            logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: forcedRequestBody, responseText: assembled });
          } else if (shouldLogBody(auth.user)) {
            logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: body, responseText: assembled });
          }
          return;
        }

        let text = await upstream.text();
        const nonStreamTtftMs = Date.now() - started; // full-body receipt (≈ latency for non-stream)
        if (!rawMode && isOAuth) text = isHermes ? reverseMapHermesJsonResponse(text) : ccReverseMapJsonResponse(text);
        usage = extractUsage(text);
        let refusalDetailsNonStream: any = null;
        if (!rawMode) try {
          const parsed = JSON.parse(text);
          const ensureContent = () => {
            if (!Array.isArray(parsed.content)) parsed.content = [];
            return parsed.content as any[];
          };
          if (parsed?.stop_reason === 'refusal' && Array.isArray(parsed.content) && parsed.content.length === 0) {
            refusalDetailsNonStream = parsed.stop_details || { category: 'safety' };
            parsed.content = [{ type: 'text', text: formatRefusalMessage(refusalDetailsNonStream) }];
            text = JSON.stringify(parsed);
          } else if (parsed?.stop_reason === 'pause_turn') {
            ensureContent().push({ type: 'text', text: pauseTurnMessage() });
            text = JSON.stringify(parsed);
          } else if (parsed?.stop_reason === 'max_tokens') {
            ensureContent().push({ type: 'text', text: maxTokensMessage(usage.outputTokens) });
            text = JSON.stringify(parsed);
          }
        } catch {}
        const cost = estimateCost(model, usage, 'anthropic');
        const usageEventId = recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'anthropic', endpoint, model, stream, statusCode: upstream.status, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheCreationTokens: usage.cacheCreationTokens, cacheReadTokens: usage.cacheReadTokens, estimatedCostUsd: cost, latencyMs: Date.now() - started, ttftMs: nonStreamTtftMs, retryCount: attempt, retryReason: attempt > 0 ? lastRetryReason : undefined, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
        enforceAfterUsage(auth.user, 'anthropic', auth.token, model);
        release({ inputTokens: usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens, outputTokens: usage.outputTokens, costUsd: cost });
        if (shouldLogBody(auth.user)) {
          logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: body, responseText: text });
        } else if (refusalDetailsNonStream) {
          logRequestResponse({
            usageEventId,
            userId: auth.user.id,
            requestBody: { forcedLogReason: 'anthropic_refusal', providerAccountLabel: account.label, attempt: attempt + 1, refusal: refusalDetailsNonStream, headers: req.headers, body },
            responseText: text,
          });
        }
        if (rawMode) applySafeUpstreamResponseHeaders(reply, upstream.headers);
        reply.code(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(text);
        return;
      } catch (err: any) {
        lastError = err?.message || String(err);
        lastFailureEligibleForFallback = true;
        markCooldown(account.id, 60_000, 'network_error');
        lastRetryReason = 'upstream_error';
        release();
        recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'anthropic', endpoint, model, stream, statusCode: 502, latencyMs: Date.now() - started, error: lastError, retryCount: attempt, retryReason: attempt > 0 ? lastRetryReason : undefined, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
      }
    }

    if (lastFailureEligibleForFallback && await tryCrossProviderFallback(503)) return;
    reply.header('retry-after', '60');
    reply.header('x-gateway-provider', 'anthropic');
    reply.code(503).send(anthropicError(503, `Anthropic capacity unavailable: ${lastError}`, 'service_unavailable'));
  };
  app.post('/v1/messages', handleMessages);
  app.post('/v1/anthropic-raw/v1/messages', { config: { disableCompression: true } }, handleMessages);
}
