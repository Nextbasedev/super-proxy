import crypto from 'node:crypto';
import { getDb } from '../db/index.js';
import type { ProviderAccount } from './governor.js';
import { KNOWN_MODELS_BY_PROVIDER } from './known-models.js';
import { catalogModelIdsWithCapability } from './model-catalog.js';

export const DEFAULT_XAI_MODEL = 'grok-4.3';
export const KNOWN_XAI_MODELS = new Set<string>([...KNOWN_MODELS_BY_PROVIDER.xai]);
export const KNOWN_XAI_IMAGE_MODELS = new Set<string>(catalogModelIdsWithCapability('xai', 'image-generation'));
export const KNOWN_XAI_VIDEO_MODELS = new Set<string>(catalogModelIdsWithCapability('xai', 'video-generation'));

const XAI_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const XAI_OAUTH_ISSUER = 'https://auth.x.ai';
const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`;
const XAI_OAUTH_FETCH_TIMEOUT_MS = 30_000;
const XAI_REFRESH_MARGIN_MS = 60_000;

function hashIndex(key: string, length: number): number {
  if (length <= 1) return 0;
  const digest = crypto.createHash('sha256').update(key).digest();
  return digest.readUInt32BE(0) % length;
}

function isTrustedXaiOAuthEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' && (url.hostname === 'x.ai' || url.hostname.endsWith('.x.ai'));
  } catch {
    return false;
  }
}

function requireTrustedXaiOAuthEndpoint(endpoint: string, label: string): string {
  if (!isTrustedXaiOAuthEndpoint(endpoint)) throw new Error(`xAI OAuth discovery returned untrusted ${label}`);
  return endpoint;
}

function toFormUrlEncoded(body: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) params.set(key, value);
  return params.toString();
}

function decodeJwtPayload(token: string | null | undefined): Record<string, any> {
  if (!token) return {};
  const part = token.split('.')[1];
  if (!part) return {};
  try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')); } catch { return {}; }
}

function deriveExpiresFromJwt(token: string | null | undefined): number | undefined {
  const exp = decodeJwtPayload(token).exp;
  return typeof exp === 'number' && Number.isFinite(exp) && exp > 0 ? exp * 1000 : undefined;
}

function parseStoredXaiCredential(account: ProviderAccount): { accessToken: string; refreshToken?: string; expiresAt: number; tokenEndpoint?: string } {
  const rawSecret = String(account.secret || '').trim();
  let parsed: any = null;
  if (rawSecret.startsWith('{')) {
    try { parsed = JSON.parse(rawSecret); } catch { parsed = null; }
  }
  const accessToken = typeof parsed?.access === 'string' ? parsed.access
    : typeof parsed?.accessToken === 'string' ? parsed.accessToken
      : rawSecret;
  const refreshToken = typeof parsed?.refresh === 'string' ? parsed.refresh
    : typeof parsed?.refreshToken === 'string' ? parsed.refreshToken
      : (account.refresh_secret || undefined);
  const expiresAt = Number(parsed?.expires || parsed?.expiresAt || account.expires_at || deriveExpiresFromJwt(accessToken) || 0);
  const tokenEndpoint = typeof parsed?.tokenEndpoint === 'string' ? parsed.tokenEndpoint : undefined;
  return { accessToken, refreshToken, expiresAt, tokenEndpoint };
}

async function fetchXaiOAuthTokenEndpoint(): Promise<string> {
  const res = await fetch(XAI_OAUTH_DISCOVERY_URL, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(XAI_OAUTH_FETCH_TIMEOUT_MS),
  });
  const json = await res.json().catch(() => null) as any;
  if (!res.ok) throw new Error(`xAI OAuth discovery failed (${res.status})`);
  if (typeof json?.token_endpoint !== 'string') throw new Error('xAI OAuth discovery response is missing token_endpoint');
  return requireTrustedXaiOAuthEndpoint(json.token_endpoint, 'token endpoint');
}

async function refreshXaiAccount(account: ProviderAccount): Promise<ProviderAccount> {
  const credential = parseStoredXaiCredential(account);
  if (!credential.refreshToken) return account;
  const tokenEndpoint = requireTrustedXaiOAuthEndpoint(credential.tokenEndpoint || await fetchXaiOAuthTokenEndpoint(), 'token endpoint');
  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: toFormUrlEncoded({ grant_type: 'refresh_token', client_id: XAI_OAUTH_CLIENT_ID, refresh_token: credential.refreshToken }),
    signal: AbortSignal.timeout(XAI_OAUTH_FETCH_TIMEOUT_MS),
  });
  const json = await res.json().catch(() => null) as any;
  if (!res.ok || typeof json?.access_token !== 'string') {
    getDb().prepare("UPDATE provider_accounts SET status='refresh_failed', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(account.id);
    throw new Error(`xAI OAuth refresh failed (${res.status})`);
  }
  const accessToken = json.access_token;
  const refreshToken = typeof json.refresh_token === 'string' && json.refresh_token ? json.refresh_token : credential.refreshToken;
  const expiresAt = Number.isFinite(Number(json.expires_in)) && Number(json.expires_in) > 0
    ? Date.now() + Number(json.expires_in) * 1000
    : (deriveExpiresFromJwt(accessToken) || 0);
  getDb().prepare("UPDATE provider_accounts SET secret=?, refresh_secret=?, expires_at=?, last_refresh_at=?, status='active', cooldown_until=0, updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .run(accessToken, refreshToken, expiresAt, Date.now(), account.id);
  return { ...account, secret: accessToken, refresh_secret: refreshToken, expires_at: expiresAt, status: 'active', cooldown_until: 0, last_refresh_at: Date.now() } as ProviderAccount;
}

export async function ensureFreshXaiAccount(account: ProviderAccount): Promise<ProviderAccount> {
  const credential = parseStoredXaiCredential(account);
  if (!credential.refreshToken) return account;
  if (!credential.expiresAt || credential.expiresAt - Date.now() > XAI_REFRESH_MARGIN_MS) return account;
  return refreshXaiAccount(account);
}

export function selectXaiAccount(stickyKey: string, excludeIds: number[] = []): ProviderAccount | null {
  const now = Date.now();
  const exclude = new Set(excludeIds);
  const rows = getDb().prepare(`
    SELECT id,provider,label,secret,refresh_secret,account_id,expires_at,max_in_flight,status,cooldown_until,last_used_at,last_refresh_at
    FROM provider_accounts
    WHERE provider = 'xai' AND enabled = 1
    ORDER BY last_used_at ASC, id ASC
  `).all() as ProviderAccount[];
  const eligible = rows.filter((a: any) => {
    if (exclude.has(a.id)) return false;
    if (!a.secret) return false;
    if (['dead','disabled','invalid','refresh_failed'].includes(a.status)) return false;
    if ((a.cooldown_until || 0) > now) return false;
    return true;
  });
  if (!eligible.length) return null;
  const stable = [...eligible].sort((a, b) => a.id - b.id);
  return stable[hashIndex(stickyKey, stable.length)] || eligible[0];
}

export type XaiVideoJobAccount = ProviderAccount & { job_model?: string; job_submit_cost_usd?: number | null; job_trued_up?: number | null };

export function getXaiVideoJobAccount(requestId: string, userId: number): XaiVideoJobAccount | null {
  const row = getDb().prepare(`
    SELECT pa.id,pa.provider,pa.label,pa.secret,pa.refresh_secret,pa.account_id,pa.enabled,pa.expires_at,pa.max_in_flight,pa.status,pa.cooldown_until,pa.last_used_at,pa.last_refresh_at,
           j.model AS job_model, j.submit_cost_usd AS job_submit_cost_usd, j.trued_up AS job_trued_up
    FROM xai_video_jobs j
    JOIN provider_accounts pa ON pa.id = j.provider_account_id
    WHERE j.request_id = ? AND j.user_id = ? AND pa.provider = 'xai'
  `).get(requestId, userId) as XaiVideoJobAccount | undefined;
  if (!row) return null;
  return row;
}

export function recordXaiVideoJob(requestId: string, accountId: number, userId: number, tokenId: number, model: string, submitCostUsd?: number): void {
  const id = String(requestId || '').trim();
  if (!id) return;
  getDb().prepare('DELETE FROM xai_video_jobs WHERE created_at < ?').run(Date.now() - 30 * 24 * 60 * 60 * 1000);
  getDb().prepare(`
    INSERT INTO xai_video_jobs (request_id,provider_account_id,user_id,token_id,model,submit_cost_usd,trued_up,created_at)
    VALUES (?,?,?,?,?,?,0,?)
    ON CONFLICT(request_id) DO UPDATE SET provider_account_id=excluded.provider_account_id, user_id=excluded.user_id, token_id=excluded.token_id, model=excluded.model, submit_cost_usd=excluded.submit_cost_usd, trued_up=0, created_at=excluded.created_at
  `).run(id, accountId, userId, tokenId, model, submitCostUsd ?? null, Date.now());
}

export type XaiBatchJobAccount = ProviderAccount;

export function getXaiBatchJobAccount(batchId: string, userId: number): XaiBatchJobAccount | null {
  const row = getDb().prepare(`
    SELECT pa.id,pa.provider,pa.label,pa.secret,pa.refresh_secret,pa.account_id,pa.enabled,pa.expires_at,pa.max_in_flight,pa.status,pa.cooldown_until,pa.last_used_at,pa.last_refresh_at
    FROM xai_batch_jobs j
    JOIN provider_accounts pa ON pa.id = j.provider_account_id
    WHERE j.batch_id = ? AND j.user_id = ? AND pa.provider = 'xai'
  `).get(batchId, userId) as XaiBatchJobAccount | undefined;
  if (!row) return null;
  return row;
}

export function recordXaiBatchJob(batchId: string, accountId: number, userId: number, tokenId: number): void {
  const id = String(batchId || '').trim();
  if (!id) return;
  getDb().prepare('DELETE FROM xai_batch_jobs WHERE created_at < ?').run(Date.now() - 30 * 24 * 60 * 60 * 1000);
  getDb().prepare(`
    INSERT INTO xai_batch_jobs (batch_id,provider_account_id,user_id,token_id,created_at)
    VALUES (?,?,?,?,?)
    ON CONFLICT(batch_id) DO UPDATE SET provider_account_id=excluded.provider_account_id, user_id=excluded.user_id, token_id=excluded.token_id, created_at=excluded.created_at
  `).run(id, accountId, userId, tokenId, Date.now());
}

export function markXaiVideoJobTruedUp(requestId: string, userId: number): boolean {
  const changes = getDb().prepare('UPDATE xai_video_jobs SET trued_up=1 WHERE request_id=? AND user_id=? AND COALESCE(trued_up,0)=0').run(requestId, userId).changes;
  return changes > 0;
}

export function recordXaiSuccess(accountId: number): void {
  getDb().prepare(`UPDATE provider_accounts SET last_used_at=?, status=CASE WHEN status='cooldown' THEN 'active' ELSE status END, cooldown_until=CASE WHEN status='cooldown' THEN 0 ELSE cooldown_until END WHERE id=?`).run(Date.now(), accountId);
}

export function markXaiCooldown(accountId: number, ms: number, reason: string): void {
  const until = Date.now() + Math.max(0, ms);
  getDb().prepare("UPDATE provider_accounts SET status='cooldown', cooldown_until=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(until, accountId);
  getDb().prepare('INSERT INTO provider_health_events (provider_account_id,status,reason,detail) VALUES (?,?,?,?)').run(accountId, 'rate_limited', reason, String(ms));
}
