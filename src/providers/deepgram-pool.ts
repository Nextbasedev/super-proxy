import crypto from 'node:crypto';
import { getDb } from '../db/index.js';
import type { ProviderAccount } from './governor.js';
import { KNOWN_MODELS_BY_PROVIDER } from './known-models.js';

export const DEFAULT_DEEPGRAM_MODEL = 'nova-3';
export const KNOWN_DEEPGRAM_MODELS = new Set<string>([...KNOWN_MODELS_BY_PROVIDER.deepgram]);

const inFlight = new Map<number, number>();
export const DEFAULT_DEEPGRAM_MAX_IN_FLIGHT = 45;

function hashIndex(key: string, length: number): number {
  if (length <= 1) return 0;
  const digest = crypto.createHash('sha256').update(key).digest();
  return digest.readUInt32BE(0) % length;
}

export function getDeepgramInFlightSnapshot(): Record<number, number> {
  return Object.fromEntries([...inFlight.entries()]);
}

export function acquireDeepgramSlot(account: ProviderAccount): boolean {
  const max = Number(account.max_in_flight || DEFAULT_DEEPGRAM_MAX_IN_FLIGHT);
  const cur = inFlight.get(account.id) || 0;
  if (cur >= max) return false;
  inFlight.set(account.id, cur + 1);
  return true;
}

export function releaseDeepgramSlot(account: ProviderAccount): void {
  const cur = inFlight.get(account.id) || 0;
  if (cur <= 1) inFlight.delete(account.id); else inFlight.set(account.id, cur - 1);
}

export function selectDeepgramAccount(stickyKey: string, excludeIds: number[] = []): ProviderAccount | null {
  const now = Date.now();
  const exclude = new Set(excludeIds);
  const rows = getDb().prepare(`
    SELECT id,provider,label,secret,refresh_secret,account_id,expires_at,max_in_flight,status,cooldown_until,last_used_at
    FROM provider_accounts
    WHERE provider = 'deepgram' AND enabled = 1
    ORDER BY last_used_at ASC, id ASC
  `).all() as ProviderAccount[];
  const eligible = rows.filter((a: any) => {
    if (exclude.has(a.id)) return false;
    if (!a.secret) return false;
    if (['dead','disabled','invalid','refresh_failed'].includes(a.status)) return false;
    if ((a.cooldown_until || 0) > now) return false;
    if ((inFlight.get(a.id) || 0) >= Number(a.max_in_flight || DEFAULT_DEEPGRAM_MAX_IN_FLIGHT)) return false;
    return true;
  });
  if (!eligible.length) return null;
  const stable = [...eligible].sort((a, b) => a.id - b.id);
  return stable[hashIndex(stickyKey, stable.length)] || eligible[0];
}

export function recordDeepgramSuccess(accountId: number): void {
  getDb().prepare(`UPDATE provider_accounts SET last_used_at=?, status=CASE WHEN status='cooldown' THEN 'active' ELSE status END, cooldown_until=CASE WHEN status='cooldown' THEN 0 ELSE cooldown_until END WHERE id=?`).run(Date.now(), accountId);
}

export function markDeepgramCooldown(accountId: number, ms: number, reason: string): void {
  const until = Date.now() + Math.max(0, ms);
  getDb().prepare("UPDATE provider_accounts SET status='cooldown', cooldown_until=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(until, accountId);
  getDb().prepare('INSERT INTO provider_health_events (provider_account_id,status,reason,detail) VALUES (?,?,?,?)').run(accountId, 'rate_limited', reason, String(ms));
}
