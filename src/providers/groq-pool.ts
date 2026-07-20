import crypto from 'node:crypto';
import { getDb } from '../db/index.js';
import type { ProviderAccount } from './governor.js';
import { catalogModelIdsWithCapability } from './model-catalog.js';

export const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-120b';
export const KNOWN_GROQ_MODELS = new Set(catalogModelIdsWithCapability('groq', 'chat'));

export interface GroqLimit { account_id: number; model: string; rpm: number | null; rpd: number | null; tpm: number | null; tpd: number | null }
export interface GroqCounters { model: string; minuteRequests: number; minuteTokens: number; dayRequests: number; dayTokens: number; limit?: GroqLimit }

function hashIndex(key: string, length: number): number {
  if (length <= 1) return 0;
  const digest = crypto.createHash('sha256').update(key).digest();
  return digest.readUInt32BE(0) % length;
}

export function groqWindows(now = new Date()): { minute: string; day: string } {
  return { minute: now.toISOString().slice(0, 16), day: now.toISOString().slice(0, 10) };
}

function readCounters(accountId: number, model: string, now = new Date()) {
  const { minute, day } = groqWindows(now);
  const row = getDb().prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN window_minute = ? THEN requests ELSE 0 END), 0) minuteRequests,
      COALESCE(SUM(CASE WHEN window_minute = ? THEN tokens ELSE 0 END), 0) minuteTokens,
      COALESCE(SUM(CASE WHEN window_day = ? THEN requests ELSE 0 END), 0) dayRequests,
      COALESCE(SUM(CASE WHEN window_day = ? THEN tokens ELSE 0 END), 0) dayTokens
    FROM groq_usage_buckets
    WHERE account_id = ? AND model = ?
  `).get(minute, minute, day, day, accountId, model) as any;
  return {
    minuteRequests: Number(row?.minuteRequests || 0),
    minuteTokens: Number(row?.minuteTokens || 0),
    dayRequests: Number(row?.dayRequests || 0),
    dayTokens: Number(row?.dayTokens || 0),
  };
}

export function selectGroqAccountForModel(model: string, stickyKey: string, estimatedTokens = 0, excludeIds: number[] = []): ProviderAccount | null {
  const now = Date.now();
  const exclude = new Set(excludeIds);
  const rows = getDb().prepare(`
    SELECT id,provider,label,secret,refresh_secret,account_id,expires_at,max_in_flight,status,cooldown_until,last_used_at
    FROM provider_accounts
    WHERE provider = 'groq' AND enabled = 1
    ORDER BY last_used_at ASC, id ASC
  `).all() as ProviderAccount[];
  const eligible = rows.filter((a: any) => {
    if (exclude.has(a.id)) return false;
    if (!a.secret) return false;
    if (['dead','disabled','invalid','refresh_failed'].includes(a.status)) return false;
    if ((a.cooldown_until || 0) > now) return false;
    const cd = getDb().prepare('SELECT cooldown_until FROM groq_model_cooldowns WHERE account_id=? AND model=?').get(a.id, model) as any;
    if ((cd?.cooldown_until || 0) > now) return false;
    const limit = getDb().prepare('SELECT account_id,model,rpm,rpd,tpm,tpd FROM groq_limits WHERE account_id=? AND model=?').get(a.id, model) as GroqLimit | undefined;
    if (limit) {
      const c = readCounters(a.id, model);
      if (limit.rpm != null && c.minuteRequests + 1 > limit.rpm) return false;
      if (limit.rpd != null && c.dayRequests + 1 > limit.rpd) return false;
      if (limit.tpm != null && c.minuteTokens + estimatedTokens > limit.tpm) return false;
      if (limit.tpd != null && c.dayTokens + estimatedTokens > limit.tpd) return false;
    }
    return true;
  });
  if (!eligible.length) return null;
  const stable = [...eligible].sort((a, b) => a.id - b.id);
  const primary = stable[hashIndex(stickyKey, stable.length)];
  return primary || eligible[0];
}

export function recordGroqRequest(account_id: number, model: string, tokens: number, ok: boolean): void {
  if (!ok) return;
  const { minute, day } = groqWindows(new Date());
  getDb().prepare(`
    INSERT INTO groq_usage_buckets (account_id, model, window_minute, window_day, requests, tokens)
    VALUES (?, ?, ?, ?, 1, ?)
    ON CONFLICT(account_id, model, window_minute, window_day)
    DO UPDATE SET requests = requests + 1, tokens = tokens + excluded.tokens
  `).run(account_id, model, minute, day, Math.max(0, Math.ceil(tokens || 0)));
  getDb().prepare(`UPDATE provider_accounts SET last_used_at=?, status=CASE WHEN status='cooldown' THEN 'active' ELSE status END, cooldown_until=CASE WHEN status='cooldown' THEN 0 ELSE cooldown_until END WHERE id=?`).run(Date.now(), account_id);
}

export function markGroqCooldown(account_id: number, model: string, ms: number, reason: string): void {
  const until = Date.now() + Math.max(0, ms);
  getDb().prepare(`
    INSERT INTO groq_model_cooldowns (account_id, model, cooldown_until, reason)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(account_id, model) DO UPDATE SET cooldown_until=excluded.cooldown_until, reason=excluded.reason
  `).run(account_id, model, until, reason);
  getDb().prepare('INSERT INTO provider_health_events (provider_account_id,status,reason,detail) VALUES (?,?,?,?)').run(account_id, 'rate_limited', reason, `${model}:${ms}`);
}

// Account-wide cooldown (vs markGroqCooldown which is per-model). Used for
// billing-related blocks like `blocked_api_access` where the entire account is
// out of quota regardless of model.
export function markGroqAccountCooldown(account_id: number, ms: number, reason: string): void {
  const until = Date.now() + Math.max(0, ms);
  getDb().prepare("UPDATE provider_accounts SET status='cooldown', cooldown_until=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(until, account_id);
  getDb().prepare('INSERT INTO provider_health_events (provider_account_id,status,reason,detail) VALUES (?,?,?,?)').run(account_id, 'rate_limited', reason, String(ms));
}

export function getGroqLiveCounters(account_id: number): GroqCounters[] {
  const models = new Set<string>();
  for (const r of getDb().prepare('SELECT model FROM groq_limits WHERE account_id=?').all(account_id) as any[]) models.add(r.model);
  for (const r of getDb().prepare('SELECT DISTINCT model FROM groq_usage_buckets WHERE account_id=? ORDER BY model').all(account_id) as any[]) models.add(r.model);
  for (const r of getDb().prepare('SELECT model FROM groq_model_cooldowns WHERE account_id=? AND cooldown_until > ?').all(account_id, Date.now()) as any[]) models.add(r.model);
  return [...models].sort().map((model) => {
    const limit = getDb().prepare('SELECT account_id,model,rpm,rpd,tpm,tpd FROM groq_limits WHERE account_id=? AND model=?').get(account_id, model) as GroqLimit | undefined;
    return { model, ...readCounters(account_id, model), ...(limit ? { limit } : {}) };
  });
}
