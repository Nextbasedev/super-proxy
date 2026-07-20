import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { alert } from '../utils/alerts.js';

export type Provider = 'anthropic' | 'openai_codex' | 'openai' | 'groq' | 'cerebras' | 'kimi' | 'glm' | 'gemini' | 'openrouter' | 'deepgram' | 'fish' | 'xai' | 'runpod' | 'serper';

interface RuntimeState {
  inFlight: number;
  cooldownUntil: number;
  recent: Array<{ ts: number; inputTokens: number; outputTokens: number; costUsd: number }>;
}

const state = new Map<number, RuntimeState>();
const DEFAULT_ANTHROPIC_MAX_IN_FLIGHT = config.globalAnthropicMaxInFlight || 10;

function getState(id: number): RuntimeState {
  let s = state.get(id);
  if (!s) {
    s = { inFlight: 0, cooldownUntil: 0, recent: [] };
    state.set(id, s);
  }
  return s;
}

function hash(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) h = ((h << 5) - h + input.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export interface ProviderAccount {
  id: number;
  provider: Provider;
  label: string;
  secret: string;
  refresh_secret: string | null;
  account_id: string | null;
  expires_at: number;
  max_in_flight: number | null;
  status: string;
  cooldown_until: number;
}

export interface SelectionResult {
  account: ProviderAccount;
  release: (usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number }) => void;
}

export function selectAccount(provider: Provider, stickyKey: string): SelectionResult | null {
  const rows = getDb().prepare(`
    SELECT id,provider,label,secret,refresh_secret,account_id,expires_at,max_in_flight,status,cooldown_until
    FROM provider_accounts
    WHERE provider = ? AND enabled = 1
    ORDER BY id
  `).all(provider) as ProviderAccount[];
  if (rows.length === 0) return null;

  const now = Date.now();
  const available = rows.filter((a) => {
    const s = getState(a.id);
    const cooldownUntil = Math.max(a.cooldown_until || 0, s.cooldownUntil || 0);
    const max = a.max_in_flight || (provider === 'anthropic' ? DEFAULT_ANTHROPIC_MAX_IN_FLIGHT : 10);
    return !['dead','disabled','invalid','refresh_failed'].includes(a.status) && cooldownUntil <= now && s.inFlight < max;
  });
  if (available.length === 0) return null;

  available.sort((a, b) => getState(a.id).inFlight - getState(b.id).inFlight || a.id - b.id);
  const sticky = available[hash(stickyKey) % available.length];
  const sorted = [...available].sort((a, b) => getState(a.id).inFlight - getState(b.id).inFlight);
  const chosen = sticky && getState(sticky.id).inFlight <= (sticky.max_in_flight || DEFAULT_ANTHROPIC_MAX_IN_FLIGHT) ? sticky : sorted[0];
  const s = getState(chosen.id);
  s.inFlight += 1;
  let released = false;
  return {
    account: chosen,
    release: (usage = {}) => {
      if (released) return;
      released = true;
      s.inFlight = Math.max(0, s.inFlight - 1);
      const now = Date.now();
      s.recent.push({ ts: now, inputTokens: usage.inputTokens || 0, outputTokens: usage.outputTokens || 0, costUsd: usage.costUsd || 0 });
      const cutoff = now - 60_000;
      s.recent = s.recent.filter((x) => x.ts >= cutoff);
      // Persist last-used so the admin UI can show "last used" relative time.
      try { getDb().prepare('UPDATE provider_accounts SET last_used_at = ? WHERE id = ?').run(now, chosen.id); } catch {}
    },
  };
}

// Live snapshot of governor state for admin UI / observability.
export function getGovernorSnapshot(): Record<number, { inFlight: number; cooldownUntil: number; recentCount: number; recentInputTokens: number; recentOutputTokens: number; recentCostUsd: number }> {
  const out: Record<number, { inFlight: number; cooldownUntil: number; recentCount: number; recentInputTokens: number; recentOutputTokens: number; recentCostUsd: number }> = {};
  for (const [id, s] of state.entries()) {
    let i = 0, o = 0, c = 0;
    for (const r of s.recent) { i += r.inputTokens; o += r.outputTokens; c += r.costUsd; }
    out[id] = { inFlight: s.inFlight, cooldownUntil: s.cooldownUntil, recentCount: s.recent.length, recentInputTokens: i, recentOutputTokens: o, recentCostUsd: c };
  }
  return out;
}

export function markCooldown(accountId: number, durationMs: number, reason: string) {
  const until = Date.now() + durationMs;
  getState(accountId).cooldownUntil = until;
  getDb().prepare('UPDATE provider_accounts SET status = ?, cooldown_until = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('cooldown', until, accountId);
  getDb().prepare('INSERT INTO provider_health_events (provider_account_id,status,reason) VALUES (?,?,?)').run(accountId, 'cooldown', reason);
  void alert('warn', 'provider_account_cooldown', `Provider account ${accountId} cooled down`, { accountId, reason, until });
}

export function markDead(accountId: number, reason: string) {
  getDb().prepare('UPDATE provider_accounts SET status = ?, enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('dead', accountId);
  getDb().prepare('INSERT INTO provider_health_events (provider_account_id,status,reason) VALUES (?,?,?)').run(accountId, 'dead', reason);
  void alert('error', 'provider_account_dead', `Provider account ${accountId} disabled`, { accountId, reason });
}

export function markActive(accountId: number) {
  getDb().prepare('UPDATE provider_accounts SET status = ?, cooldown_until = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = ?').run('active', accountId, 'cooldown');
}

export function classifyProviderError(status: number, body: string): 'rate_limit' | 'dead' | 'permission' | 'temporary' | 'fatal' {
  const lower = body.toLowerCase();
  if (status === 429 || lower.includes('rate limit') || lower.includes('quota')) return 'rate_limit';
  if (status === 401 || lower.includes('invalid token') || lower.includes('revoked')) return 'dead';
  if (status === 403 || lower.includes('permission') || lower.includes('disabled')) return 'permission';
  if (status >= 500) return 'temporary';
  return 'fatal';
}
