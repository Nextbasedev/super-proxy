import crypto from 'node:crypto';
import { getDb } from '../db/index.js';
import type { ProviderAccount } from './governor.js';
import { catalogModelIdsWithCapability } from './model-catalog.js';

export const DEFAULT_GLM_MODEL = 'glm-5.2';
export const KNOWN_GLM_MODELS = new Set(catalogModelIdsWithCapability('glm', 'chat'));

// z.ai GLM Coding Plan PER-MODEL concurrency limits (max simultaneous in-flight
// requests per model, per subscription seat/account). Exceeding these triggers
// upstream 429s, so we cap locally per (account, model). Values confirmed by Don
// from the z.ai plan dashboard (2026-06-25).
export const GLM_MODEL_CONCURRENCY: Record<string, number> = {
  'glm-5.2': 10,
  'glm-5.1': 10,
  'glm-5': 10,
  'glm-4.5': 10,
  'glm-4.6': 3,
  'glm-4.7': 2,
  'glm-5-turbo': 1,
};
// Conservative per-model fallback for any model not explicitly listed above.
export const DEFAULT_GLM_MAX_IN_FLIGHT = 3;
// Default account-level max_in_flight override on account creation. Set high so
// per-model caps (GLM_MODEL_CONCURRENCY) are the real limiter; effectiveModelCap
// takes min(modelCap, accountOverride).
export const DEFAULT_GLM_ACCOUNT_MAX_IN_FLIGHT = 10;

export function glmModelLimit(model: string): number {
  return GLM_MODEL_CONCURRENCY[model] ?? DEFAULT_GLM_MAX_IN_FLIGHT;
}

// In-flight tracked per (accountId, model) so each model respects its own cap.
const glmInFlight = new Map<string, number>();
const flightKey = (accountId: number, model: string) => `${accountId}:${model}`;

function hashIndex(key: string, length: number): number {
  if (length <= 1) return 0;
  const digest = crypto.createHash('sha256').update(key).digest();
  return digest.readUInt32BE(0) % length;
}

/** In-flight count for a specific account+model. */
export function getGlmModelInFlight(accountId: number, model: string): number {
  return glmInFlight.get(flightKey(accountId, model)) || 0;
}

/** Total in-flight across all models for an account. */
export function getGlmInFlight(accountId: number): number {
  let total = 0;
  const prefix = `${accountId}:`;
  for (const [k, n] of glmInFlight.entries()) {
    if (k.startsWith(prefix)) total += n;
  }
  return total;
}

/** Per-account in-flight totals (summed across models). */
export function getGlmInFlightSnapshot(): Record<number, number> {
  const out: Record<number, number> = {};
  for (const [k, n] of glmInFlight.entries()) {
    const id = Number(k.slice(0, k.indexOf(':')));
    out[id] = (out[id] || 0) + n;
  }
  return out;
}

/** Effective per-model cap for an account (min of z.ai model limit and any account override). */
function effectiveModelCap(account: ProviderAccount, model: string): number {
  const modelCap = glmModelLimit(model);
  const acctCap = account.max_in_flight && account.max_in_flight > 0 ? account.max_in_flight : modelCap;
  return Math.min(modelCap, acctCap);
}

export function acquireGlmSlot(account: ProviderAccount, model: string): boolean {
  const cap = effectiveModelCap(account, model);
  const key = flightKey(account.id, model);
  const cur = glmInFlight.get(key) || 0;
  if (cur >= cap) return false;
  glmInFlight.set(key, cur + 1);
  return true;
}

export function releaseGlmSlot(account: ProviderAccount, model: string): void {
  const key = flightKey(account.id, model);
  const cur = glmInFlight.get(key) || 0;
  glmInFlight.set(key, Math.max(0, cur - 1));
}

export function selectGlmAccount(stickyKey: string, model: string, excludeIds: number[] = []): ProviderAccount | null {
  const now = Date.now();
  const exclude = new Set(excludeIds);
  const rows = getDb().prepare(`
    SELECT id,provider,label,secret,refresh_secret,account_id,expires_at,max_in_flight,status,cooldown_until,last_used_at
    FROM provider_accounts
    WHERE provider = 'glm' AND enabled = 1
    ORDER BY last_used_at ASC, id ASC
  `).all() as ProviderAccount[];
  const eligible = rows.filter((a: any) => {
    if (exclude.has(a.id)) return false;
    if (!a.secret) return false;
    if (['dead','disabled','invalid','refresh_failed'].includes(a.status)) return false;
    if ((a.cooldown_until || 0) > now) return false;
    if (getGlmModelInFlight(a.id, model) >= effectiveModelCap(a, model)) return false;
    return true;
  });
  if (!eligible.length) return null;
  const stable = [...eligible].sort((a, b) => a.id - b.id);
  const primary = stable[hashIndex(stickyKey, stable.length)];
  return primary || eligible[0];
}

export function markGlmCooldown(account_id: number, ms: number, reason: string): void {
  const until = Date.now() + Math.max(0, ms);
  getDb().prepare(`
    UPDATE provider_accounts
    SET status='cooldown', cooldown_until=?, consecutive_failures=consecutive_failures+1, notes=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(until, reason, account_id);
  getDb().prepare('INSERT INTO provider_health_events (provider_account_id,status,reason,detail) VALUES (?,?,?,?)')
    .run(account_id, 'rate_limited', reason, String(ms));
}

export function recordGlmSuccess(account_id: number): void {
  getDb().prepare(`
    UPDATE provider_accounts
    SET last_used_at=?, status=CASE WHEN status='cooldown' THEN 'active' ELSE status END,
        cooldown_until=CASE WHEN status='cooldown' THEN 0 ELSE cooldown_until END,
        consecutive_failures=0,
        updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(Date.now(), account_id);
}
