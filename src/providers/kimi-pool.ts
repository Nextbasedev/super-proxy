import crypto from 'node:crypto';
import { getDb } from '../db/index.js';
import type { ProviderAccount } from './governor.js';
import { catalogModelIdsWithCapability } from './model-catalog.js';

export const DEFAULT_KIMI_MODEL = 'kimi-k2.6';
export const KNOWN_KIMI_MODELS = new Set(catalogModelIdsWithCapability('kimi', 'chat'));
export const DEFAULT_KIMI_MAX_IN_FLIGHT = 10;

const kimiInFlight = new Map<number, number>();

function hashIndex(key: string, length: number): number {
  if (length <= 1) return 0;
  const digest = crypto.createHash('sha256').update(key).digest();
  return digest.readUInt32BE(0) % length;
}

export function getKimiInFlight(accountId: number): number {
  return kimiInFlight.get(accountId) || 0;
}

export function getKimiInFlightSnapshot(): Record<number, number> {
  const out: Record<number, number> = {};
  for (const [id, n] of kimiInFlight.entries()) out[id] = n;
  return out;
}

export function acquireKimiSlot(account: ProviderAccount): boolean {
  const max = account.max_in_flight || DEFAULT_KIMI_MAX_IN_FLIGHT;
  const cur = kimiInFlight.get(account.id) || 0;
  if (cur >= max) return false;
  kimiInFlight.set(account.id, cur + 1);
  return true;
}

export function releaseKimiSlot(account: ProviderAccount): void {
  const cur = kimiInFlight.get(account.id) || 0;
  kimiInFlight.set(account.id, Math.max(0, cur - 1));
}

export function selectKimiAccount(stickyKey: string, excludeIds: number[] = []): ProviderAccount | null {
  const now = Date.now();
  const exclude = new Set(excludeIds);
  const rows = getDb().prepare(`
    SELECT id,provider,label,secret,refresh_secret,account_id,expires_at,max_in_flight,status,cooldown_until,last_used_at
    FROM provider_accounts
    WHERE provider = 'kimi' AND enabled = 1
    ORDER BY last_used_at ASC, id ASC
  `).all() as ProviderAccount[];
  const eligible = rows.filter((a: any) => {
    if (exclude.has(a.id)) return false;
    if (!a.secret) return false;
    if (['dead','disabled','invalid','refresh_failed'].includes(a.status)) return false;
    if ((a.cooldown_until || 0) > now) return false;
    const max = a.max_in_flight || DEFAULT_KIMI_MAX_IN_FLIGHT;
    if ((kimiInFlight.get(a.id) || 0) >= max) return false;
    return true;
  });
  if (!eligible.length) return null;
  const stable = [...eligible].sort((a, b) => a.id - b.id);
  const primary = stable[hashIndex(stickyKey, stable.length)];
  return primary || eligible[0];
}

export function markKimiCooldown(account_id: number, ms: number, reason: string): void {
  const until = Date.now() + Math.max(0, ms);
  getDb().prepare(`
    UPDATE provider_accounts
    SET status='cooldown', cooldown_until=?, consecutive_failures=consecutive_failures+1, notes=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(until, reason, account_id);
  getDb().prepare('INSERT INTO provider_health_events (provider_account_id,status,reason,detail) VALUES (?,?,?,?)')
    .run(account_id, 'rate_limited', reason, String(ms));
}

export function recordKimiSuccess(account_id: number): void {
  getDb().prepare(`
    UPDATE provider_accounts
    SET last_used_at=?, status=CASE WHEN status='cooldown' THEN 'active' ELSE status END,
        cooldown_until=CASE WHEN status='cooldown' THEN 0 ELSE cooldown_until END,
        consecutive_failures=0,
        updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(Date.now(), account_id);
}
