import crypto from 'node:crypto';
import { getDb } from '../db/index.js';
import type { ProviderAccount } from './governor.js';
import { KNOWN_MODELS_BY_PROVIDER } from './known-models.js';

export const DEFAULT_OPENROUTER_MODEL = 'tencent/hy3:free';
export const KNOWN_OPENROUTER_MODELS = new Set<string>([...KNOWN_MODELS_BY_PROVIDER.openrouter]);

function hashIndex(key: string, length: number): number {
  if (length <= 1) return 0;
  const digest = crypto.createHash('sha256').update(key).digest();
  return digest.readUInt32BE(0) % length;
}

export function selectOpenRouterAccount(stickyKey: string, excludeIds: number[] = []): ProviderAccount | null {
  const now = Date.now();
  const exclude = new Set(excludeIds);
  const rows = getDb().prepare(`
    SELECT id,provider,label,secret,refresh_secret,account_id,expires_at,max_in_flight,status,cooldown_until,last_used_at
    FROM provider_accounts
    WHERE provider = 'openrouter' AND enabled = 1
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

export function recordOpenRouterSuccess(accountId: number): void {
  getDb().prepare(`UPDATE provider_accounts SET last_used_at=?, status=CASE WHEN status='cooldown' THEN 'active' ELSE status END, cooldown_until=CASE WHEN status='cooldown' THEN 0 ELSE cooldown_until END WHERE id=?`).run(Date.now(), accountId);
}

export function markOpenRouterCooldown(accountId: number, ms: number, reason: string): void {
  const until = Date.now() + Math.max(0, ms);
  getDb().prepare("UPDATE provider_accounts SET status='cooldown', cooldown_until=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(until, accountId);
  getDb().prepare('INSERT INTO provider_health_events (provider_account_id,status,reason,detail) VALUES (?,?,?,?)').run(accountId, 'rate_limited', reason, String(ms));
}
