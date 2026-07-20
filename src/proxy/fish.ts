import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { requireProxyToken } from '../auth/token-auth.js';
import { recordUsage } from './usage.js';
import { checkLooseLimit, enforceAfterUsage, isModelAllowedForUser, logRequestResponse, shouldLogBody } from './policy.js';

function openAiError(message: string, type = 'server_error', code?: string) {
  return { type: 'error', error: { type, code, message } };
}

const DEFAULT_FISH_TTS_MODEL = 's2.1-pro-free';
const DEFAULT_FISH_REFERENCE_ID = '519c87e88c8c47b4a500ab134ed938d5'; // Calm Male Narrator
const FISH_TTS_BODY_LIMIT_BYTES = 2 * 1024 * 1024;
const fishInFlight = new Map<number, number>();

function releaseFishAccount(accountId: number) {
  fishInFlight.set(accountId, Math.max(0, (fishInFlight.get(accountId) || 0) - 1));
}

function selectFishAccount() {
  const rows = getDb().prepare(`
    SELECT id,provider,label,secret,enabled,status,cooldown_until,max_in_flight
    FROM provider_accounts
    WHERE provider='fish' AND enabled=1 AND status NOT IN ('dead','disabled','invalid','refresh_failed')
      AND (cooldown_until IS NULL OR cooldown_until <= ?)
    ORDER BY last_used_at ASC, id ASC
  `).all(Date.now()) as any[];
  for (const account of rows) {
    const max = account.max_in_flight || config.fishMaxInFlight || 4;
    const current = fishInFlight.get(account.id) || 0;
    if (current < max) {
      fishInFlight.set(account.id, current + 1);
      return account;
    }
  }
  return null;
}

function normalizeFishTtsBody(input: any) {
  const text = String(input?.text ?? input?.input ?? '').trim();
  const model = typeof input?.model === 'string' && input.model.trim() ? input.model.trim() : DEFAULT_FISH_TTS_MODEL;
  const referenceId = typeof input?.reference_id === 'string' && input.reference_id.trim() ? input.reference_id.trim() : DEFAULT_FISH_REFERENCE_ID;
  const format = typeof input?.format === 'string' && input.format.trim() ? input.format.trim() : 'mp3';
  const body: any = { ...input, text, reference_id: referenceId, format };
  delete body.input;
  delete body.model;
  return { text, model, body, charCount: text.length };
}

async function forwardFishTts(req: any, reply: any) {
  const auth = await requireProxyToken(req, reply);
  if (!auth) return;
  const started = Date.now();
  const normalized = normalizeFishTtsBody(req.body || {});
  if (!normalized.text) {
    reply.code(400).send(openAiError('Fish TTS requires text or input', 'invalid_request_error', 'missing_text'));
    return;
  }
  if (normalized.charCount > 15000) {
    reply.code(400).send(openAiError('Fish TTS text is too long; max 15000 characters', 'invalid_request_error', 'text_too_long'));
    return;
  }
  const allowed = isModelAllowedForUser(auth.user, 'fish', normalized.model);
  if (!allowed.ok) { reply.code(400).send(openAiError(allowed.message, 'invalid_request_error', 'model_not_allowed')); return; }
  const limit = checkLooseLimit(auth.user, 'fish', auth.token, normalized.model);
  if (!limit.ok) { reply.code(429).send(openAiError(limit.message, 'insufficient_quota', 'user_limit_exceeded')); return; }
  const account = selectFishAccount();
  if (!account) {
    reply.code(503).send(openAiError('No Fish Audio account available. Add provider="fish" with a Fish API key.', 'server_error', 'service_unavailable'));
    return;
  }
  let released = false;
  const release = () => { if (!released) { released = true; releaseFishAccount(account.id); } };
  try {
    const upstream = await fetch(`${config.fishUpstreamUrl}/v1/tts`, {
      method: 'POST',
      headers: { authorization: `Bearer ${account.secret}`, 'content-type': 'application/json', model: normalized.model, accept: 'audio/mpeg' },
      body: JSON.stringify(normalized.body),
      signal: AbortSignal.timeout(2 * 60 * 1000),
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    reply.header('x-gateway-provider', 'fish');
    reply.header('x-gateway-account', account.label);
    if (upstream.status >= 400) {
      const text = buf.toString('utf8').slice(0, 500);
      recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'fish', endpoint: '/v1/fish/tts', model: normalized.model, stream: false, statusCode: upstream.status, inputTokens: normalized.charCount, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: text, tokenLabel: auth.token.label, providerAccountLabel: account.label });
      release();
      reply.code(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(buf);
      return;
    }
    // unit='chars': input_tokens holds TTS character count (cap compatibility) —
    // monitoring must exclude these rows from token aggregations.
    const usageEventId = recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'fish', endpoint: '/v1/fish/tts', model: normalized.model, stream: false, statusCode: upstream.status, inputTokens: normalized.charCount, outputTokens: 0, unit: 'chars', ttftMs: Date.now() - started, estimatedCostUsd: 0, latencyMs: Date.now() - started, tokenLabel: auth.token.label, providerAccountLabel: account.label });
    enforceAfterUsage(auth.user, 'fish', auth.token, normalized.model);
    if (shouldLogBody(auth.user)) logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: { ...normalized.body, text: `[${normalized.charCount} chars]` }, responseText: JSON.stringify({ bytes: buf.length }) });
    release();
    reply.code(upstream.status).type(upstream.headers.get('content-type') || 'audio/mpeg').send(buf);
  } catch (err: any) {
    release();
    recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'fish', endpoint: '/v1/fish/tts', model: normalized.model, stream: false, statusCode: 502, inputTokens: normalized.charCount, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: String(err?.message || err), tokenLabel: auth.token.label, providerAccountLabel: account.label });
    reply.code(502).send(openAiError(`Fish Audio TTS failed: ${String(err?.message || err)}`, 'server_error', 'bad_gateway'));
  }
}

export function registerFishProxy(app: any) {
  app.post('/v1/fish/tts', { bodyLimit: FISH_TTS_BODY_LIMIT_BYTES }, (req: any, reply: any) => forwardFishTts(req, reply));
}
