import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { requireProxyToken } from '../auth/token-auth.js';
import { recordUsage } from './usage.js';
import { checkLooseLimit, enforceAfterUsage, isModelAllowedForUser, logRequestResponse, shouldLogBody } from './policy.js';
import { acquireDeepgramSlot, DEFAULT_DEEPGRAM_MODEL, KNOWN_DEEPGRAM_MODELS, markDeepgramCooldown, recordDeepgramSuccess, releaseDeepgramSlot, selectDeepgramAccount } from '../providers/deepgram-pool.js';

function apiError(message: string, type = 'server_error', code?: string) {
  return { error: { message, type, code: code || null } };
}

function modelNotAllowedForUserError(message: string) {
  return { type: 'error', error: { type: 'invalid_request_error', code: 'model_not_allowed_for_user', message } };
}

function retryAfterMs(value: string | null): number {
  if (!value) return 60_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 60_000;
}

function normalizeModel(model: unknown): string {
  return typeof model === 'string' && model.trim() ? model.trim() : DEFAULT_DEEPGRAM_MODEL;
}

function appendDeepgramParams(url: URL, body: any) {
  // OpenAI-style transcription forms commonly send language/prompt/response_format.
  // Deepgram ignores OpenAI fields it doesn't know, so map only useful values.
  if (body?.language && !url.searchParams.has('language')) url.searchParams.set('language', String(body.language));
  if (body?.detect_language != null && !url.searchParams.has('detect_language')) url.searchParams.set('detect_language', String(!!body.detect_language));
  if (body?.diarize != null && !url.searchParams.has('diarize')) url.searchParams.set('diarize', String(!!body.diarize));
  if (body?.smart_format != null && !url.searchParams.has('smart_format')) url.searchParams.set('smart_format', String(!!body.smart_format));
  if (!url.searchParams.has('smart_format')) url.searchParams.set('smart_format', 'true');
}

function parseDeepgramUsage(text: string, fallbackInput = 0) {
  try {
    const parsed = JSON.parse(text);
    const duration = Number(parsed?.metadata?.duration || 0);
    // Usage table is token-shaped; use audio seconds as input_tokens for caps/visibility.
    return { inputTokens: Number.isFinite(duration) ? Math.ceil(duration) : fallbackInput, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  } catch {
    return { inputTokens: fallbackInput, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  }
}

async function forwardDeepgramListen(req: any, reply: any) {
  const auth = await requireProxyToken(req, reply);
  if (!auth) return;
  const started = Date.now();

  const body = req.body as any;
  const isJson = String(req.headers['content-type'] || '').includes('application/json');
  const model = normalizeModel(req.query?.model || body?.model);

  // Deepgram is strict: only curated Deepgram models are allowed. Unknown model
  // names are blocked before upstream so free credits don't disappear silently.
  if (!KNOWN_DEEPGRAM_MODELS.has(model)) {
    reply.code(400).send(modelNotAllowedForUserError(`Model ${model} is not allowed for Deepgram`));
    return;
  }
  const allowed = isModelAllowedForUser(auth.user, 'deepgram', model);
  if (!allowed.ok) {
    reply.code(400).send(modelNotAllowedForUserError(allowed.message));
    return;
  }
  const limit = checkLooseLimit(auth.user, 'deepgram', auth.token, model);
  if (!limit.ok) {
    reply.code(429).send(apiError(limit.message, 'insufficient_quota', 'user_limit_exceeded'));
    return;
  }

  const url = new URL(`${config.deepgramUpstreamUrl}/listen`);
  for (const [k, v] of Object.entries(req.query || {})) {
    if (v != null && k !== 'model') url.searchParams.set(k, String(v));
  }
  url.searchParams.set('model', model);
  appendDeepgramParams(url, body);

  let upstreamBody: any;
  let contentType = String(req.headers['content-type'] || 'application/octet-stream');
  if (isJson) {
    upstreamBody = JSON.stringify(body || {});
    contentType = 'application/json';
  } else {
    const bodyBuf: Buffer = Buffer.isBuffer(body) ? body : Buffer.from(body ?? '');
    upstreamBody = new Uint8Array(bodyBuf);
  }

  const stickyKey = `${auth.user.email}:${auth.token.label}:${model}:listen`;
  const tried: number[] = [];
  let lastError = 'No Deepgram account available';
  let retryAfter = 60;

  for (let attempt = 0; attempt < 5; attempt++) {
    const account = selectDeepgramAccount(stickyKey, tried);
    if (!account) break;
    tried.push(account.id);
    if (!acquireDeepgramSlot(account)) { lastError = 'Deepgram account at concurrency cap'; continue; }
    let released = false;
    const release = () => { if (!released) { released = true; releaseDeepgramSlot(account); } };
    try {
      const upstream = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Token ${account.secret}`, 'content-type': contentType, accept: 'application/json' },
        body: upstreamBody,
        signal: AbortSignal.timeout(20 * 60 * 1000),
      });
      release();
      reply.header('x-gateway-provider', 'deepgram');
      reply.header('x-gateway-account', account.label);
      reply.header('x-gateway-attempt', String(attempt + 1));

      if (upstream.status === 429) {
        const text = await upstream.text().catch(() => '');
        const ms = retryAfterMs(upstream.headers.get('retry-after'));
        retryAfter = Math.max(1, Math.ceil(ms / 1000));
        markDeepgramCooldown(account.id, ms, `rate limited (${upstream.status})`);
        recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'deepgram', endpoint: '/v1/deepgram/listen', model, stream: false, statusCode: upstream.status, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: text.slice(0, 500) || 'rate limited', tokenLabel: auth.token.label, providerAccountLabel: account.label });
        lastError = text.slice(0, 500) || 'rate limited';
        continue;
      }

      const text = await upstream.text();
      const usage = parseDeepgramUsage(text, 0);
      const status = upstream.status;
      if (status >= 400) {
        lastError = text.slice(0, 500) || String(status);
        recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'deepgram', endpoint: '/v1/deepgram/listen', model, stream: false, statusCode: status, ...usage, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, tokenLabel: auth.token.label, providerAccountLabel: account.label });
        reply.code(status).type(upstream.headers.get('content-type') || 'application/json').send(text || apiError(lastError));
        return;
      }

      recordDeepgramSuccess(account.id);
      // unit='seconds': input_tokens holds audio seconds (cap compatibility) —
      // monitoring must exclude these rows from token aggregations.
      const usageEventId = recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'deepgram', endpoint: '/v1/deepgram/listen', model, stream: false, statusCode: status, ...usage, unit: 'seconds', ttftMs: Date.now() - started, estimatedCostUsd: 0, latencyMs: Date.now() - started, tokenLabel: auth.token.label, providerAccountLabel: account.label });
      enforceAfterUsage(auth.user, 'deepgram', auth.token, model);
      if (shouldLogBody(auth.user)) logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: isJson ? body : { contentType, bytes: Buffer.byteLength(upstreamBody) }, responseText: text });
      reply.code(status).type(upstream.headers.get('content-type') || 'application/json').send(text);
      return;
    } catch (err: any) {
      release();
      lastError = err?.message || String(err);
      recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'deepgram', endpoint: '/v1/deepgram/listen', model, stream: false, statusCode: 502, inputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, tokenLabel: auth.token.label, providerAccountLabel: account.label });
    }
  }

  reply.header('retry-after', String(retryAfter));
  reply.header('x-gateway-provider', 'deepgram');
  reply.code(429).send(apiError(`Deepgram capacity unavailable: ${lastError}`, 'rate_limit_exceeded', 'rate_limit_exceeded'));
}

export function registerDeepgramProxy(app: FastifyInstance) {
  // Raw pre-recorded audio passthrough. JSON URL payloads continue through Fastify's default parser.
  app.addContentTypeParser(/^audio\//, { parseAs: 'buffer', bodyLimit: 100 * 1024 * 1024 }, (_req, body, done) => done(null, body));
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 100 * 1024 * 1024 }, (_req, body, done) => done(null, body));
  app.post('/v1/deepgram/listen', (req, reply) => forwardDeepgramListen(req, reply));
}
