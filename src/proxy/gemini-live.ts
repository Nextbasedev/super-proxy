import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { WebSocket as UpstreamWebSocket } from 'ws';
import { config } from '../config.js';
import { requireProxyToken, authContextFromToken, type AuthContext } from '../auth/token-auth.js';
import { recordUsage } from './usage.js';
import { isModelAllowedForUser, checkLooseLimit } from './policy.js';
import {
  KNOWN_GEMINI_LIVE_MODELS,
  DEFAULT_GEMINI_MAX_IN_FLIGHT,
  selectGeminiAccount,
  getGeminiInFlight,
  acquireGeminiSlot,
  releaseGeminiSlot,
  recordGeminiAttempt,
} from '../providers/gemini-pool.js';
import type { ProviderAccount } from '../providers/governor.js';

const DEFAULT_LIVE_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';
// Relay safety limits. Live sessions hold a scarce pooled Gemini slot, so we cap
// how long one can pin a slot and how much can be buffered before upstream opens.
const LIVE_CONNECT_TIMEOUT_MS = Number(process.env.GEMINI_LIVE_CONNECT_TIMEOUT_MS) || 15000;
const LIVE_IDLE_TIMEOUT_MS = Number(process.env.GEMINI_LIVE_IDLE_TIMEOUT_MS) || 120000;
const LIVE_MAX_SESSION_MS = Number(process.env.GEMINI_LIVE_MAX_SESSION_MS) || 30 * 60 * 1000;
const LIVE_PENDING_MAX_BYTES = Number(process.env.GEMINI_LIVE_PENDING_MAX_BYTES) || 4 * 1024 * 1024;
const LIVE_PENDING_MAX_MSGS = Number(process.env.GEMINI_LIVE_PENDING_MAX_MSGS) || 64;
// Optional browser Origin allowlist (comma-separated). CORS does not protect WS;
// unset => allow all (internal default). Set to restrict browser-token clients.
const LIVE_ALLOWED_ORIGINS = (process.env.GEMINI_LIVE_ALLOWED_ORIGINS || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

function frameByteLen(data: unknown): number {
  if (typeof data === 'string') return Buffer.byteLength(data);
  if (Buffer.isBuffer(data)) return data.length;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (Array.isArray(data)) return data.reduce((n: number, d: any) => n + frameByteLen(d), 0);
  return 0;
}
// Generative Language Live WebSocket. config.geminiUpstreamUrl is the REST base
// (.../v1beta); the Live WS lives on the same host under a different path.
function liveWsUrl(secret: string): string {
  const host = (config.geminiUpstreamUrl || 'https://generativelanguage.googleapis.com/v1beta')
    .replace(/^https?:\/\//, '')
    .replace(/\/v1(beta|alpha)\/?$/, '');
  return `wss://${host}/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(secret)}`;
}

function authTokensUrl(secret: string): string {
  const base = (config.geminiUpstreamUrl || 'https://generativelanguage.googleapis.com/v1beta')
    .replace(/\/v1(beta|alpha)\/?$/, '/v1alpha');
  return `${base}/auth_tokens?key=${encodeURIComponent(secret)}`;
}

function pickQuery(req: FastifyRequest, ...keys: string[]): string | undefined {
  const q = (req.query || {}) as Record<string, unknown>;
  for (const k of keys) {
    const v = q[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

function tokenFromUpgrade(req: FastifyRequest): string | null {
  // Browsers can't set Authorization on a WebSocket; accept token via query.
  const q = pickQuery(req, 'access_token', 'token', 'api_key', 'apikey');
  if (q) return q;
  const hdr = req.headers['authorization'];
  const raw = Array.isArray(hdr) ? hdr[0] : hdr;
  if (raw) {
    const m = raw.match(/^Bearer\s+(.+)$/i);
    return (m?.[1] || raw).trim();
  }
  const xkey = req.headers['x-api-key'];
  const xraw = Array.isArray(xkey) ? xkey[0] : xkey;
  return (xraw && String(xraw).trim()) || null;
}

/**
 * Gemini Live (realtime) WebSocket relay.
 *
 * Client <-> NBMG <-> Google BidiGenerateContent. The gateway holds the Gemini
 * key (never exposed to the client) and pins one pooled account per session.
 * The relay is transport-transparent: it forwards the client's first
 * BidiGenerateContentSetup verbatim, so any setup feature (translationConfig,
 * audio transcription, etc.) works once the upstream key tier is allowlisted.
 *
 * NOTE: Live models are audio-first (require AUDIO response modality). Sessions
 * are internal-only and unmetered for cost; we still record a zero-cost
 * usage_event per session for observability.
 */
function handleLiveSocket(clientWs: import('ws').WebSocket, req: FastifyRequest) {
  const log = (req as any).log;

  // Map reserved/invalid WS close codes (1005/1006/1015 etc) to 1011 — sending
  // them on the wire throws. Always terminate as a fallback if close throws.
  const safeCloseClient = (code: number, reason?: string) => {
    const c = code >= 3000 && code <= 4999 ? code : (code === 1000 || code === 1008 || code === 1009 || code === 1011 || code === 1013) ? code : 1011;
    try { clientWs.close(c, reason ? reason.slice(0, 120) : undefined); }
    catch { try { (clientWs as any).terminate?.(); } catch {} }
  };

  // Optional browser Origin allowlist (CORS doesn't protect WebSockets).
  if (LIVE_ALLOWED_ORIGINS.length) {
    const origin = String(req.headers['origin'] || '').toLowerCase();
    if (origin && !LIVE_ALLOWED_ORIGINS.includes(origin)) {
      safeCloseClient(1008, 'Origin not allowed');
      return;
    }
  }

  const auth: AuthContext | null = authContextFromToken(tokenFromUpgrade(req));
  if (!auth) {
    safeCloseClient(1008, 'Missing, invalid, or disabled API token');
    return;
  }

  const requestedModel = pickQuery(req, 'model') || DEFAULT_LIVE_MODEL;
  const model = KNOWN_GEMINI_LIVE_MODELS.has(requestedModel) ? requestedModel : DEFAULT_LIVE_MODEL;
  const allowed = isModelAllowedForUser(auth.user, 'gemini', model);
  if (!allowed.ok) {
    safeCloseClient(1008, allowed.message);
    return;
  }
  const limit = checkLooseLimit(auth.user, 'gemini', auth.token, model);
  if (!limit.ok) {
    safeCloseClient(1008, limit.message);
    return;
  }

  // Select a pooled Gemini account for the Live family and pin it for the session.
  const tried: number[] = [];
  let account: ProviderAccount | null = null;
  for (let i = 0; i < 3; i++) {
    const candidate = selectGeminiAccount('live', tried);
    if (!candidate) break;
    if (acquireGeminiSlot(candidate)) { account = candidate; break; }
    tried.push(candidate.id);
  }
  if (!account) {
    safeCloseClient(1013, 'No Gemini Live capacity available');
    return;
  }
  const acct = account;
  const started = Date.now();
  let released = false;
  let closeStatus = 1000;
  let connectTimer: NodeJS.Timeout | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let sessionTimer: NodeJS.Timeout | undefined;
  const pending: Array<{ data: any; isBinary: boolean }> = [];
  let pendingBytes = 0;
  let upstreamOpen = false;
  // Cumulative token usage sniffed from relayed server frames. The Live API
  // embeds usageMetadata in JSON server messages; we only JSON.parse frames
  // that contain the marker so audio relay throughput is unaffected.
  const liveUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 };
  let ttftMs: number | undefined;
  const sniffUsage = (data: any, isBinary: boolean) => {
    try {
      const buf: Buffer | string = data;
      const marker = 'usageMetadata';
      const has = typeof buf === 'string' ? buf.includes(marker) : Buffer.isBuffer(buf) && buf.includes(marker);
      if (!has) return;
      const parsed = JSON.parse(typeof buf === 'string' ? buf : buf.toString('utf8'));
      const u = parsed?.usageMetadata || parsed?.serverContent?.usageMetadata;
      if (!u) return;
      // Live usageMetadata is cumulative per session; keep the max seen.
      const cached = u.cachedContentTokenCount ?? 0;
      liveUsage.inputTokens = Math.max(liveUsage.inputTokens, Math.max(0, (u.promptTokenCount ?? 0) - cached));
      liveUsage.outputTokens = Math.max(liveUsage.outputTokens, u.responseTokenCount ?? u.candidatesTokenCount ?? 0);
      liveUsage.cacheReadTokens = Math.max(liveUsage.cacheReadTokens, cached);
      liveUsage.reasoningTokens = Math.max(liveUsage.reasoningTokens, u.thoughtsTokenCount ?? 0);
    } catch { /* sniffing must never break the relay */ }
  };

  const clearTimers = () => {
    if (connectTimer) clearTimeout(connectTimer);
    if (idleTimer) clearTimeout(idleTimer);
    if (sessionTimer) clearTimeout(sessionTimer);
    connectTimer = idleTimer = sessionTimer = undefined;
  };

  // recordGeminiAttempt can throw (DB); guard it so a throw never leaks the slot.
  try { recordGeminiAttempt(acct.id, 'live'); }
  catch (e) { log?.warn?.({ err: String(e) }, 'gemini live: recordGeminiAttempt failed'); }

  let upstream: import('ws').WebSocket | undefined;

  const finish = (statusCode: number) => {
    if (released) return;
    released = true;
    clearTimers();
    pending.length = 0;
    releaseGeminiSlot(acct);
    try { if (upstream && (upstream.readyState === upstream.OPEN || upstream.readyState === upstream.CONNECTING)) upstream.close(1000); } catch {}
    try {
      recordUsage({
        userId: auth.user.id, tokenId: auth.token.id, providerAccountId: acct.id,
        provider: 'gemini', endpoint: '/v1/gemini/realtime', model, stream: true,
        statusCode, inputTokens: liveUsage.inputTokens, outputTokens: liveUsage.outputTokens,
        cacheReadTokens: liveUsage.cacheReadTokens || undefined,
        reasoningTokens: liveUsage.reasoningTokens || undefined,
        ttftMs, estimatedCostUsd: 0,
        latencyMs: Date.now() - started, tokenLabel: auth.token.label, providerAccountLabel: acct.label,
      });
    } catch (e) { log?.warn?.({ err: String(e) }, 'gemini live: usage record failed'); }
    log?.info?.({ provider: 'gemini', endpoint: '/v1/gemini/realtime', model, account: acct.label, durationMs: Date.now() - started }, 'gemini live session ended');
  };

  const bumpIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { safeCloseClient(1011, 'Idle timeout'); finish(504); }, LIVE_IDLE_TIMEOUT_MS);
  };

  try {
    upstream = new UpstreamWebSocket(liveWsUrl(acct.secret as string));
  } catch (e) {
    safeCloseClient(1011, 'Upstream connect failed');
    finish(502);
    return;
  }
  const up = upstream;

  // Absolute session cap + connect handshake timeout + idle timeout.
  sessionTimer = setTimeout(() => { safeCloseClient(1011, 'Max session duration reached'); finish(200); }, LIVE_MAX_SESSION_MS);
  connectTimer = setTimeout(() => {
    if (!upstreamOpen) { try { up.terminate(); } catch {} safeCloseClient(1011, 'Upstream connect timeout'); finish(504); }
  }, LIVE_CONNECT_TIMEOUT_MS);
  bumpIdle();

  up.on('open', () => {
    upstreamOpen = true;
    if (connectTimer) { clearTimeout(connectTimer); connectTimer = undefined; }
    for (const m of pending) { try { up.send(m.data, { binary: m.isBinary }); } catch {} }
    pending.length = 0;
    pendingBytes = 0;
  });
  up.on('message', (data: any, isBinary: boolean) => {
    bumpIdle();
    if (ttftMs === undefined) ttftMs = Date.now() - started;
    sniffUsage(data, isBinary);
    if (clientWs.readyState === clientWs.OPEN) {
      try { clientWs.send(data, { binary: isBinary }); } catch {}
    }
  });
  up.on('close', (code: number) => {
    closeStatus = code === 1000 ? 200 : 502;
    // Never forward upstream reason strings (may leak provider/quota detail).
    safeCloseClient(code, code === 1000 ? undefined : 'Upstream closed');
    finish(closeStatus);
  });
  up.on('error', (err: Error) => {
    log?.warn?.({ err: String(err?.message || err) }, 'gemini live upstream error');
    safeCloseClient(1011, 'Upstream error');
    finish(502);
  });

  clientWs.on('message', (data: any, isBinary: boolean) => {
    bumpIdle();
    if (upstreamOpen && up.readyState === up.OPEN) {
      try { up.send(data, { binary: isBinary }); } catch {}
      return;
    }
    // Buffer pre-open frames, but cap to avoid memory DoS on a stalled upstream.
    pendingBytes += frameByteLen(data);
    pending.push({ data, isBinary });
    if (pending.length > LIVE_PENDING_MAX_MSGS || pendingBytes > LIVE_PENDING_MAX_BYTES) {
      safeCloseClient(1009, 'Pre-open buffer limit exceeded');
      try { up.terminate(); } catch {}
      finish(413);
    }
  });
  clientWs.on('close', () => {
    finish(closeStatus === 1000 ? 200 : closeStatus);
  });
  clientWs.on('error', () => {
    finish(closeStatus);
  });
}

/**
 * Mint a short-lived Gemini ephemeral auth token so a browser/OCPlatform client can
 * connect directly to Google's Live WS without ever seeing our pooled key.
 *
 * NOTE (2026-06-24): the upstream auth_tokens API is gated on our current free
 * key tier and returns "API key not valid" until the keys are allowlisted for
 * ephemeral tokens. The raw WS relay above does NOT depend on this and works
 * today. This endpoint passes the upstream response through unchanged.
 */
async function mintGeminiClientSecret(req: FastifyRequest, reply: FastifyReply) {
  const auth = await requireProxyToken(req, reply);
  if (!auth) return;
  const body = (req.body || {}) as any;
  const requestedModel = typeof body.model === 'string' ? body.model : DEFAULT_LIVE_MODEL;
  const model = KNOWN_GEMINI_LIVE_MODELS.has(requestedModel) ? requestedModel : DEFAULT_LIVE_MODEL;
  const allowed = isModelAllowedForUser(auth.user, 'gemini', model);
  if (!allowed.ok) {
    reply.code(403).send({ type: 'error', error: { type: 'permission_error', message: allowed.message } });
    return;
  }
  const limit = checkLooseLimit(auth.user, 'gemini', auth.token, model);
  if (!limit.ok) {
    reply.code(429).send({ type: 'error', error: { type: 'rate_limit_error', message: limit.message } });
    return;
  }

  const tried: number[] = [];
  let account: ProviderAccount | null = null;
  for (let i = 0; i < 3; i++) {
    const candidate = selectGeminiAccount('live', tried);
    if (!candidate) break;
    if ((getGeminiInFlight(candidate.id) || 0) < (candidate.max_in_flight || DEFAULT_GEMINI_MAX_IN_FLIGHT)) { account = candidate; break; }
    tried.push(candidate.id);
  }
  if (!account) {
    reply.code(503).send({ type: 'error', error: { type: 'overloaded_error', message: 'No Gemini Live capacity available' } });
    return;
  }
  const started = Date.now();
  // Default: single-use token valid for 30 minutes; honor caller overrides.
  const uses = Number.isFinite(body.uses) ? body.uses : 1;
  const expireMinutes = Number.isFinite(body.expire_minutes) ? body.expire_minutes : 30;
  const payload: any = { uses, expireTime: new Date(Date.now() + expireMinutes * 60 * 1000).toISOString() };
  if (body.liveConnectConstraints) payload.liveConnectConstraints = body.liveConnectConstraints;

  try {
    const upstream = await fetch(authTokensUrl(account.secret as string), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(15000),
    });
    const text = await upstream.text();
    try { recordGeminiAttempt(account.id, 'live'); } catch {}
    recordUsage({
      userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id,
      provider: 'gemini', endpoint: '/v1/gemini/realtime/client_secrets', model, stream: false,
      statusCode: upstream.status, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0,
      latencyMs: Date.now() - started, tokenLabel: auth.token.label, providerAccountLabel: account.label,
      error: upstream.ok ? undefined : `gemini_client_secret_${upstream.status}`,
    });
    if (upstream.ok) {
      // Only the success body (which carries the ephemeral token) is passed through.
      reply.code(upstream.status).header('content-type', upstream.headers.get('content-type') || 'application/json').send(text);
    } else {
      // Never forward upstream error bodies (may leak provider/project/key-tier detail).
      (req as any).log?.warn?.({ status: upstream.status, body: text.slice(0, 500) }, 'gemini client-secret upstream error');
      reply.code(upstream.status === 429 ? 429 : 502).send({ type: 'error', error: { type: 'api_error', message: `Gemini client-secret mint failed (upstream ${upstream.status})` } });
    }
  } catch (e: any) {
    reply.code(502).send({ type: 'error', error: { type: 'api_error', message: `Gemini client-secret mint failed: ${String(e?.message || e)}` } });
  }
}

export function registerGeminiLiveRelay(app: FastifyInstance) {
  // WebSocket relay. Requires @fastify/websocket registered on the app.
  app.get('/v1/gemini/realtime', { websocket: true } as any, (connection: any, req: FastifyRequest) => {
    // @fastify/websocket v8 passes { socket }, v10+ passes the socket directly.
    const ws = connection?.socket || connection;
    handleLiveSocket(ws, req);
  });
  app.post('/v1/gemini/realtime/client_secrets', (req, reply) => mintGeminiClientSecret(req, reply));
}
