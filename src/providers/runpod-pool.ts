import crypto from 'node:crypto';
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import type { ProviderAccount } from './governor.js';
import { catalogModelIdsWithCapability } from './model-catalog.js';

// Two virtual model IDs map to a single upstream model on the Runpod
// Serverless vLLM endpoint. `qwen36-27b-fast` rewrites to `qwen36-27b` at the
// proxy layer with `chat_template_kwargs.enable_thinking=false` injected.
export const RUNPOD_UPSTREAM_MODEL = 'qwen36-27b';
export const DEFAULT_RUNPOD_MODEL = 'qwen36-27b';
export const KNOWN_RUNPOD_MODELS = new Set(catalogModelIdsWithCapability('runpod', 'chat'));
export const DEFAULT_RUNPOD_MAX_IN_FLIGHT = Math.max(1, config.runpodConcurrencyLimit || 4);

const runpodInFlight = new Map<number, number>();

function hashIndex(key: string, length: number): number {
  if (length <= 1) return 0;
  const digest = crypto.createHash('sha256').update(key).digest();
  return digest.readUInt32BE(0) % length;
}

export function runpodEndpointUrl(account: ProviderAccount): string {
  const endpointId = (account.account_id || config.runpodEndpointId || '').trim();
  if (!endpointId) throw new Error(`Runpod account ${account.label} missing endpoint id (account_id)`);
  return `${config.runpodUpstreamBaseUrl.replace(/\/$/, '')}/${endpointId}/openai/v1`;
}

export function getRunpodInFlight(accountId: number): number {
  return runpodInFlight.get(accountId) || 0;
}

export function getRunpodInFlightSnapshot(): Record<number, number> {
  const out: Record<number, number> = {};
  for (const [id, n] of runpodInFlight.entries()) out[id] = n;
  return out;
}

export function acquireRunpodSlot(account: ProviderAccount): boolean {
  const max = account.max_in_flight || DEFAULT_RUNPOD_MAX_IN_FLIGHT;
  const cur = runpodInFlight.get(account.id) || 0;
  if (cur >= max) return false;
  runpodInFlight.set(account.id, cur + 1);
  return true;
}

export function releaseRunpodSlot(account: ProviderAccount): void {
  const cur = runpodInFlight.get(account.id) || 0;
  runpodInFlight.set(account.id, Math.max(0, cur - 1));
}

export function selectRunpodAccount(stickyKey: string, excludeIds: number[] = []): ProviderAccount | null {
  const now = Date.now();
  const exclude = new Set(excludeIds);
  const rows = getDb().prepare(`
    SELECT id,provider,label,secret,refresh_secret,account_id,expires_at,max_in_flight,status,cooldown_until,last_used_at
    FROM provider_accounts
    WHERE provider = 'runpod' AND enabled = 1
    ORDER BY last_used_at ASC, id ASC
  `).all() as ProviderAccount[];
  const eligible = rows.filter((a: any) => {
    if (exclude.has(a.id)) return false;
    if (!a.secret) return false;
    if (['dead','disabled','invalid','refresh_failed'].includes(a.status)) return false;
    if ((a.cooldown_until || 0) > now) return false;
    const max = a.max_in_flight || DEFAULT_RUNPOD_MAX_IN_FLIGHT;
    if ((runpodInFlight.get(a.id) || 0) >= max) return false;
    return true;
  });
  if (!eligible.length) return null;
  const stable = [...eligible].sort((a, b) => a.id - b.id);
  const primary = stable[hashIndex(stickyKey, stable.length)];
  return primary || eligible[0];
}

export function markRunpodCooldown(account_id: number, ms: number, reason: string): void {
  const until = Date.now() + Math.max(0, ms);
  getDb().prepare(`
    UPDATE provider_accounts
    SET status='cooldown', cooldown_until=?, consecutive_failures=consecutive_failures+1, notes=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(until, reason, account_id);
  getDb().prepare('INSERT INTO provider_health_events (provider_account_id,status,reason,detail) VALUES (?,?,?,?)')
    .run(account_id, 'rate_limited', reason, String(ms));
}

export function recordRunpodSuccess(account_id: number): void {
  getDb().prepare(`
    UPDATE provider_accounts
    SET last_used_at=?, status=CASE WHEN status='cooldown' THEN 'active' ELSE status END,
        cooldown_until=CASE WHEN status='cooldown' THEN 0 ELSE cooldown_until END,
        consecutive_failures=0,
        updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(Date.now(), account_id);
}
