import crypto from 'node:crypto';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { extractAccountIdFromJwt } from '../utils/jwt.js';
import type { ProviderAccount } from './governor.js';

// Per-account in-memory concurrency counter for Codex. Mirrors the Anthropic
// governor's behavior. Mutated via acquire()/release() at the proxy boundary.
const codexInFlight = new Map<number, number>();
const DEFAULT_CODEX_MAX_IN_FLIGHT = 50;

export function getCodexInFlight(accountId: number): number {
  return codexInFlight.get(accountId) || 0;
}
export function getCodexInFlightSnapshot(): Record<number, number> {
  const out: Record<number, number> = {};
  for (const [id, n] of codexInFlight.entries()) out[id] = n;
  return out;
}
export function acquireCodexSlot(account: ProviderAccount): boolean {
  const max = account.max_in_flight || DEFAULT_CODEX_MAX_IN_FLIGHT;
  const cur = codexInFlight.get(account.id) || 0;
  if (cur >= max) return false;
  codexInFlight.set(account.id, cur + 1);
  return true;
}
export function releaseCodexSlot(account: ProviderAccount): void {
  const cur = codexInFlight.get(account.id) || 0;
  codexInFlight.set(account.id, Math.max(0, cur - 1));
}

const inFlightRefresh = new Map<number, Promise<ProviderAccount | null>>();

export async function ensureFreshCodexAccount(account: ProviderAccount): Promise<ProviderAccount | null> {
  const now = Date.now();
  if (account.secret && account.account_id && account.expires_at && account.expires_at > now + 120_000) return account;
  if (!account.refresh_secret) return account.secret && account.account_id ? account : null;
  const existing = inFlightRefresh.get(account.id);
  if (existing) return existing;
  const promise = refresh(account).finally(() => inFlightRefresh.delete(account.id));
  inFlightRefresh.set(account.id, promise);
  return promise;
}

async function refresh(account: ProviderAccount): Promise<ProviderAccount | null> {
  const now = Date.now();
  const res = await fetch('https://auth.openai.com/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: account.refresh_secret || '', client_id: config.openaiCodexClientId }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    getDb().prepare('UPDATE provider_accounts SET status = ?, consecutive_failures = consecutive_failures + 1, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run('refresh_failed', `refresh failed (${res.status}): ${text.slice(0, 200)}`, account.id);
    getDb().prepare('INSERT INTO provider_health_events (provider_account_id,status,reason,detail) VALUES (?,?,?,?)')
      .run(account.id, 'refresh_failed', String(res.status), text.slice(0, 500));
    return null;
  }
  const data = await res.json() as { access_token: string; refresh_token?: string; expires_in?: number };
  const accessToken = data.access_token;
  const refreshToken = data.refresh_token || account.refresh_secret || '';
  const accountId = extractAccountIdFromJwt(accessToken) || account.account_id || '';
  const expiresAt = now + (data.expires_in || 3600) * 1000;
  if (!accountId) {
    getDb().prepare('UPDATE provider_accounts SET status = ?, consecutive_failures = consecutive_failures + 1, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run('invalid', 'refresh succeeded but account id missing', account.id);
    return null;
  }
  getDb().prepare(`
    UPDATE provider_accounts
    SET secret = ?, refresh_secret = ?, account_id = ?, expires_at = ?, status = 'active', cooldown_until = 0, last_refresh_at = ?, consecutive_failures = 0, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(accessToken, refreshToken, accountId, expiresAt, now, account.id);
  return { ...account, secret: accessToken, refresh_secret: refreshToken, account_id: accountId, expires_at: expiresAt, status: 'active', cooldown_until: 0 };
}

export function markCodexSuccess(account: ProviderAccount) {
  getDb().prepare('UPDATE provider_accounts SET last_used_at = ?, status = CASE WHEN status = ? THEN ? ELSE status END, cooldown_until = CASE WHEN status = ? THEN 0 ELSE cooldown_until END WHERE id = ?')
    .run(Date.now(), 'cooldown', 'active', 'cooldown', account.id);
}



export type CodexBucket = 'spark' | 'main';

const CODEX_BURST_RATE_LIMIT_COOLDOWN_MS = 45_000;
const CODEX_QUOTA_RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1000;
const MIN_CODEX_RATE_LIMIT_COOLDOWN_MS = 1_000;
const MAX_CODEX_RATE_LIMIT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

const CODEX_QUOTA_EXHAUSTION_SIGNALS = [
  'usage_limit_reached',
  'usage limit',
  'quota',
  'exceeded your current',
  'insufficient_quota',
  'plan limit',
  'weekly limit',
];

export function codexBucket(model: string | undefined): CodexBucket {
  return String(model || '').toLowerCase().includes('spark') ? 'spark' : 'main';
}

function clampCodexCooldownMs(ms: number): number {
  if (!Number.isFinite(ms)) return MIN_CODEX_RATE_LIMIT_COOLDOWN_MS;
  return Math.max(MIN_CODEX_RATE_LIMIT_COOLDOWN_MS, Math.min(MAX_CODEX_RATE_LIMIT_COOLDOWN_MS, Math.ceil(ms)));
}

function codexQuotaExhausted(body: string): boolean {
  const lower = body.toLowerCase();
  return CODEX_QUOTA_EXHAUSTION_SIGNALS.some((signal) => lower.includes(signal));
}

function parseCodexRetryAfter(retryAfterHeader: string | null | undefined, now = Date.now()): { cooldownMs?: number; resetsAt?: number } {
  if (retryAfterHeader == null) return {};
  const raw = retryAfterHeader.trim();
  const seconds = Number(raw);
  if (raw && Number.isFinite(seconds)) {
    const cooldownMs = clampCodexCooldownMs(seconds * 1000);
    return { cooldownMs, resetsAt: Math.floor((now + cooldownMs) / 1000) };
  }
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) {
    const cooldownMs = clampCodexCooldownMs(dateMs - now);
    return { cooldownMs, resetsAt: Math.floor((now + cooldownMs) / 1000) };
  }
  return { cooldownMs: MIN_CODEX_RATE_LIMIT_COOLDOWN_MS };
}

function parseCodexReset(body: string, now = Date.now()): { cooldownMs?: number; resetsAt?: number } {
  try {
    const parsed = JSON.parse(body || '{}');
    const error = parsed?.error && typeof parsed.error === 'object' ? parsed.error : parsed;
    const resetsAtRaw = Number(error?.resets_at ?? parsed?.resets_at);
    if (Number.isFinite(resetsAtRaw) && resetsAtRaw > 0) {
      const cooldownMs = clampCodexCooldownMs((resetsAtRaw * 1000) - now);
      return { cooldownMs, resetsAt: Math.floor(resetsAtRaw) };
    }
    const resetsInRaw = Number(error?.resets_in_seconds ?? parsed?.resets_in_seconds);
    if (Number.isFinite(resetsInRaw) && resetsInRaw > 0) {
      const cooldownMs = clampCodexCooldownMs(resetsInRaw * 1000);
      return { cooldownMs, resetsAt: Math.floor((now + cooldownMs) / 1000) };
    }
  } catch {}
  return {};
}

function codexCooldownDetails(retryAfterHeader: string | null | undefined, body: string, now = Date.now(), quotaExhausted = codexQuotaExhausted(body)): { cooldownMs: number; resetsAt?: number } {
  const retryAfter = parseCodexRetryAfter(retryAfterHeader, now);
  if (retryAfter.cooldownMs != null) return { cooldownMs: retryAfter.cooldownMs, resetsAt: retryAfter.resetsAt };

  const reset = parseCodexReset(body, now);
  if (reset.cooldownMs != null) return { cooldownMs: reset.cooldownMs, resetsAt: reset.resetsAt };

  return {
    cooldownMs: clampCodexCooldownMs(quotaExhausted ? CODEX_QUOTA_RATE_LIMIT_COOLDOWN_MS : CODEX_BURST_RATE_LIMIT_COOLDOWN_MS),
  };
}

export function computeCodexCooldownMs(retryAfterHeader: string | null, body: string, now?: number): number;
export function computeCodexCooldownMs(body: string, now?: number): number;
export function computeCodexCooldownMs(arg1: string | null, arg2?: string | number, arg3 = Date.now()): number {
  if (typeof arg2 === 'number' || arg2 === undefined) {
    return codexCooldownDetails(null, arg1 || '', arg2 ?? Date.now()).cooldownMs;
  }
  return codexCooldownDetails(arg1, arg2, arg3).cooldownMs;
}

export interface CodexClassification {
  kind: 'rate_limit' | 'auth_invalid' | 'temporary' | 'fatal' | 'unknown';
  retryable: boolean;
  quotaExhausted?: boolean;
  cooldownMs?: number;
  resetsAt?: number;
}

export function classifyCodexUpstreamError(status: number, body: string, now?: number): CodexClassification;
export function classifyCodexUpstreamError(status: number, body: string, retryAfterHeader?: string | null, now?: number): CodexClassification;
export function classifyCodexUpstreamError(status: number, body: string, arg3?: string | null | number, arg4 = Date.now()): CodexClassification {
  const lower = body.toLowerCase();
  const retryAfterHeader = typeof arg3 === 'number' ? null : arg3 ?? null;
  const now = typeof arg3 === 'number' ? arg3 : arg4;
  const quotaExhausted = codexQuotaExhausted(body);
  if (status === 429 || lower.includes('rate limit') || lower.includes('too many requests') || quotaExhausted) {
    const cooldown = codexCooldownDetails(retryAfterHeader, body, now, quotaExhausted);
    return {
      kind: 'rate_limit',
      retryable: true,
      quotaExhausted,
      cooldownMs: cooldown.cooldownMs,
      resetsAt: cooldown.resetsAt,
    };
  }
  if (status === 401 || lower.includes('invalid token') || lower.includes('expired') || lower.includes('unauthorized')) return { kind: 'auth_invalid', retryable: true };
  if (status >= 500) return { kind: 'temporary', retryable: true };
  if (status >= 400) return { kind: 'fatal', retryable: false };
  return { kind: 'unknown', retryable: false };
}

// Returns the set of account ids that have at least one reservation row, and
// the set of account ids reserved specifically for `email`. Reserved accounts
// are exclusive: only their reserved emails may use them; everyone else is
// excluded from them.
function codexReservation(email?: string): { reservedAny: Set<number>; reservedForEmail: Set<number> } {
  const reservedAny = new Set<number>();
  const reservedForEmail = new Set<number>();
  const rows = getDb().prepare('SELECT account_id, email FROM codex_account_reservations').all() as { account_id: number; email: string }[];
  const norm = (email || '').trim().toLowerCase();
  for (const r of rows) {
    // Guard: ignore blank/whitespace-only reservation rows. A blank email must
    // never reserve (and therefore exclude-for-everyone) an account. Such a row
    // contributes nothing to reservedAny, so the account keeps its normal shared
    // behavior instead of becoming dead weight.
    const rowEmail = String(r.email || '').trim().toLowerCase();
    if (!rowEmail) continue;
    reservedAny.add(r.account_id);
    if (norm && rowEmail === norm) reservedForEmail.add(r.account_id);
  }
  return { reservedAny, reservedForEmail };
}

export function selectCodexAccounts(excludeIds: number[] = [], email?: string, model?: string): ProviderAccount[] {
  const exclude = new Set(excludeIds);
  const now = Date.now();
  const { reservedAny, reservedForEmail } = codexReservation(email);
  const bucket = codexBucket(model);
  const cooledRows = getDb().prepare('SELECT account_id FROM codex_bucket_cooldowns WHERE bucket = ? AND cooldown_until > ?').all(bucket, now) as { account_id: number }[];
  const cooledForBucket = new Set(cooledRows.map((r) => r.account_id));
  return getDb().prepare(`
    SELECT id,provider,label,secret,refresh_secret,account_id,expires_at,max_in_flight,status,cooldown_until,last_used_at
    FROM provider_accounts
    WHERE provider = 'openai_codex' AND enabled = 1
    ORDER BY last_used_at ASC, id ASC
  `).all().filter((a: any) => {
    if (exclude.has(a.id)) return false;
    if (['disabled','invalid','refresh_failed','dead'].includes(a.status)) return false;
    if (a.status === 'cooldown' && (a.cooldown_until || 0) > now) return false;
    if (cooledForBucket.has(a.id)) return false;
    if (!(a.secret || a.refresh_secret)) return false;
    // Reservation scoping: a reserved account is eligible only for its reserved
    // emails; everyone else can never use it.
    if (reservedAny.has(a.id) && !reservedForEmail.has(a.id)) return false;
    // Concurrency cap: filter accounts already at max_in_flight.
    const max = a.max_in_flight || DEFAULT_CODEX_MAX_IN_FLIGHT;
    if ((codexInFlight.get(a.id) || 0) >= max) return false;
    return true;
  }) as ProviderAccount[];
}

function hashIndex(key: string, length: number): number {
  if (length <= 1) return 0;
  const digest = crypto.createHash('sha256').update(key).digest();
  return digest.readUInt32BE(0) % length;
}

export function selectStickyCodexAccounts(stickyKey: string, excludeIds: number[] = [], email?: string, model?: string): ProviderAccount[] {
  const candidates = selectCodexAccounts(excludeIds, email, model);
  if (candidates.length <= 1) return candidates;

  // Soft reservation priority: if this email has any reserved account available
  // right now, prefer it first, then fall back to the rest of the pool (in LRU
  // order). This gives the reserved users a low-contention primary while still
  // allowing fallback to the shared pool when the reserved account is capped or
  // cooled. Non-reserved users never see reserved accounts at all (filtered in
  // selectCodexAccounts), so their behavior is unchanged.
  const { reservedForEmail } = codexReservation(email);
  if (reservedForEmail.size) {
    const reserved = candidates.filter((a) => reservedForEmail.has(a.id));
    if (reserved.length) {
      // Stable sticky pick among reserved accounts (usually just one).
      const stableReserved = [...reserved].sort((a, b) => a.id - b.id);
      const primary = stableReserved[hashIndex(stickyKey, stableReserved.length)];
      return [primary, ...candidates.filter((a) => a.id !== primary.id)];
    }
  }

  // Pick the sticky account from a stable id-sorted list so last_used_at changes
  // don't move an active session between Codex accounts. Keep the remaining
  // accounts in LRU order for fallback/retry behavior.
  const stable = [...candidates].sort((a, b) => a.id - b.id);
  const primary = stable[hashIndex(stickyKey, stable.length)];
  return [primary, ...candidates.filter((a) => a.id !== primary.id)];
}

export function markCodexRateLimited(account: ProviderAccount, cooldownMs: number, note = 'rate limited', model?: string, resetsAt?: number) {
  markCodexBucketRateLimited(account, model, cooldownMs, note, resetsAt);
}

export function markCodexBucketRateLimited(account: ProviderAccount, model: string | undefined, cooldownMs: number, note = 'rate limited', resetsAt?: number) {
  const bucket = codexBucket(model);
  const until = Date.now() + clampCodexCooldownMs(cooldownMs);
  getDb().prepare(`
    INSERT INTO codex_bucket_cooldowns (account_id,bucket,cooldown_until,reason,resets_at)
    VALUES (?,?,?,?,?)
    ON CONFLICT(account_id,bucket) DO UPDATE SET
      cooldown_until=excluded.cooldown_until,
      reason=excluded.reason,
      resets_at=excluded.resets_at
  `).run(account.id, bucket, until, note, resetsAt ?? null);
  getDb().prepare(`UPDATE provider_accounts SET consecutive_failures=consecutive_failures+1, notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(note, account.id);
  getDb().prepare('INSERT INTO provider_health_events (provider_account_id,status,reason,detail) VALUES (?,?,?,?)')
    .run(account.id, 'rate_limited', note, JSON.stringify({ bucket, cooldownMs: clampCodexCooldownMs(cooldownMs), resetsAt: resetsAt ?? null }));
}

// Returns active (cooldown_until > now) Codex bucket cooldowns grouped by
// account id. Used by the admin dashboard to surface real Codex cooldown state,
// which lives in `codex_bucket_cooldowns` rather than `provider_accounts.status`.
export function getCodexBucketCooldownSnapshot(now = Date.now()): Record<number, { bucket: string; cooldown_until: number; resets_at: number | null; reason: string | null }[]> {
  const rows = getDb().prepare(
    'SELECT account_id, bucket, cooldown_until, resets_at, reason FROM codex_bucket_cooldowns WHERE cooldown_until > ? ORDER BY cooldown_until DESC'
  ).all(now) as { account_id: number; bucket: string; cooldown_until: number; resets_at: number | null; reason: string | null }[];
  const out: Record<number, { bucket: string; cooldown_until: number; resets_at: number | null; reason: string | null }[]> = {};
  for (const r of rows) {
    (out[r.account_id] ||= []).push({ bucket: r.bucket, cooldown_until: r.cooldown_until, resets_at: r.resets_at, reason: r.reason });
  }
  return out;
}

// Clears Codex bucket cooldowns for an account. NOTE: this only clears our
// local cooldown bookkeeping; it does NOT reset the upstream OpenAI/ChatGPT
// quota. If upstream quota is still exhausted, the next request will 429 and
// re-cooldown. Returns the number of cooldown rows removed.
export function clearCodexCooldowns(accountId: number): number {
  const info = getDb().prepare('DELETE FROM codex_bucket_cooldowns WHERE account_id = ?').run(accountId);
  getDb().prepare("UPDATE provider_accounts SET status = CASE WHEN status = 'cooldown' THEN 'active' ELSE status END, cooldown_until = 0, consecutive_failures = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(accountId);
  return info.changes;
}

export function markCodexInvalid(account: ProviderAccount, note = 'auth invalid') {
  getDb().prepare(`UPDATE provider_accounts SET status='invalid', consecutive_failures=consecutive_failures+1, notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(note, account.id);
  getDb().prepare('INSERT INTO provider_health_events (provider_account_id,status,reason) VALUES (?,?,?)').run(account.id, 'invalid', note);
}

export function markCodexTemporaryFailure(account: ProviderAccount, note = 'temporary failure') {
  getDb().prepare(`UPDATE provider_accounts SET consecutive_failures=consecutive_failures+1, notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(note, account.id);
  getDb().prepare('INSERT INTO provider_health_events (provider_account_id,status,reason) VALUES (?,?,?)').run(account.id, 'temporary', note);
}
