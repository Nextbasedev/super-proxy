// Weekly monitoring digest (Phase 4 of docs/MONITORING-SYSTEM.md §7 item 86)
// + budget auto-suggestion (item 66/79 dependency).
//
// Digest: every Monday at/after 03:30 UTC (= 09:00 IST) post a week summary
// to the monitor webhook. Dedupe across restarts via monitor_meta.
// Budget suggestion: once ≥7 full days of metered baselines exist and no
// budget is confirmed, store a suggested value (p95 daily × 1.5) in
// monitor_meta for the dashboard to render; suggestion is passive (no alert).
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { dayBucket } from './time-utils.js';
import { cacheHitDenominator, totalTokens } from './cache-accounting.js';

const DIGEST_UTC_HOUR = 3.5; // 03:30 UTC == 09:00 IST
const METERED = `billing_mode NOT IN ('flat_fee','self_hosted','free_tier')`;

function metaGet(key: string): string | undefined {
  return (getDb().prepare('SELECT value FROM monitor_meta WHERE key = ?').get(key) as any)?.value;
}

function metaSet(key: string, value: string): void {
  getDb().prepare(`
    INSERT INTO monitor_meta (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(key, value);
}

/** ISO date of the Monday of the week containing `d` (UTC). */
export function mondayOf(d: Date): string {
  const day = d.getUTCDay(); // 0=Sun
  const diff = day === 0 ? 6 : day - 1;
  return dayBucket(new Date(d.getTime() - diff * 24 * 3600_000));
}

export function isDigestDue(now = new Date()): boolean {
  if (now.getUTCDay() !== 1) return false; // Monday only
  const hour = now.getUTCHours() + now.getUTCMinutes() / 60;
  if (hour < DIGEST_UTC_HOUR) return false;
  return metaGet('digest_last_monday') !== mondayOf(now);
}

export interface DigestData {
  weekStart: string;
  weekEnd: string;
  meteredUsd: number;
  notionalUsd: number;
  topModels: Array<{ model: string; provider: string; tokens: number }>;
  cacheHitRate: number | null;
  prevCacheHitRate: number | null;
  criticalAlerts: number;
  requests: number;
}

export function buildDigestData(now = new Date()): DigestData {
  const db = getDb();
  // Previous full week: Monday..Sunday before this Monday.
  const thisMonday = mondayOf(now);
  const weekStart = dayBucket(new Date(Date.parse(`${thisMonday}T00:00:00Z`) - 7 * 24 * 3600_000));
  const weekEnd = thisMonday; // exclusive
  const prevWeekStart = dayBucket(new Date(Date.parse(`${weekStart}T00:00:00Z`) - 7 * 24 * 3600_000));

  const spend = db.prepare(`
    SELECT
      SUM(CASE WHEN ${METERED} THEN cost_usd ELSE 0 END) metered,
      SUM(CASE WHEN billing_mode = 'flat_fee' THEN cost_usd ELSE 0 END) notional,
      SUM(requests) requests
    FROM usage_rollup_daily WHERE bucket >= ? AND bucket < ?
  `).get(weekStart, weekEnd) as any;

  const cacheRows = db.prepare(`
    SELECT provider, SUM(input_tokens) input, SUM(cache_read_tokens) cache_read
    FROM usage_rollup_daily WHERE bucket >= ? AND bucket < ? GROUP BY provider
  `).all(weekStart, weekEnd) as any[];

  const prevCacheRows = db.prepare(`
    SELECT provider, SUM(input_tokens) input, SUM(cache_read_tokens) cache_read
    FROM usage_rollup_daily WHERE bucket >= ? AND bucket < ? GROUP BY provider
  `).all(prevWeekStart, weekStart) as any[];

  const topModelsRaw = db.prepare(`
    SELECT provider, model, SUM(input_tokens) input, SUM(output_tokens) output,
           SUM(cache_read_tokens) cache_read, SUM(cache_creation_tokens) cache_creation
    FROM usage_rollup_daily WHERE bucket >= ? AND bucket < ?
    GROUP BY provider, model
  `).all(weekStart, weekEnd) as any[];
  const topModels = topModelsRaw
    .map((m) => ({ ...m, tokens: totalTokens(m.provider, m.input, m.output, m.cache_read, m.cache_creation) }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 5);

  const criticalAlerts = (db.prepare(`
    SELECT COUNT(*) c FROM alerts WHERE level = 'error' AND type LIKE 'monitor_%' AND created_at >= ? AND created_at < ?
  `).get(`${weekStart} 00:00:00`, `${weekEnd} 00:00:00`) as any)?.c || 0;

  const rate = (rows: any[]) => {
    const totals = rows.reduce((acc, r) => {
      acc.cacheRead += Number(r.cache_read) || 0;
      acc.denom += cacheHitDenominator(r.provider, r.input, r.cache_read);
      return acc;
    }, { cacheRead: 0, denom: 0 });
    return totals.denom > 0 ? Math.round((totals.cacheRead / totals.denom) * 10_000) / 10_000 : null;
  };

  return {
    weekStart, weekEnd,
    meteredUsd: Math.round((spend?.metered || 0) * 100) / 100,
    notionalUsd: Math.round((spend?.notional || 0) * 100) / 100,
    requests: spend?.requests || 0,
    topModels: topModels.map((m) => ({ model: m.model || '(none)', provider: m.provider, tokens: m.tokens })),
    cacheHitRate: rate(cacheRows),
    prevCacheHitRate: rate(prevCacheRows),
    criticalAlerts,
  };
}

export async function postDigestIfDue(now = new Date()): Promise<boolean> {
  if (!isDigestDue(now)) return false;
  metaSet('digest_last_monday', mondayOf(now)); // mark BEFORE posting: a failed post skips the week rather than spamming retries every 5 min
  if (!config.monitorWebhookUrl) return false;
  const d = buildDigestData(now);
  const pct = (x: number | null) => x == null ? '—' : (x * 100).toFixed(1) + '%';
  const trend = d.cacheHitRate != null && d.prevCacheHitRate != null ? (d.cacheHitRate >= d.prevCacheHitRate ? '↑' : '↓') : '';
  const lines = [
    `**📊 NBMG weekly digest** · ${d.weekStart} → ${d.weekEnd}`,
    `Requests: **${d.requests.toLocaleString()}** · Metered spend: **$${d.meteredUsd}** · Notional (subs): **$${d.notionalUsd}**`,
    `Cache hit rate: **${pct(d.cacheHitRate)}** ${trend} (prev ${pct(d.prevCacheHitRate)})`,
    `Critical alerts: **${d.criticalAlerts}**`,
    '',
    '**Top models by tokens:**',
    ...d.topModels.map((m, i) => `${i + 1}. \`${m.provider}/${m.model}\` — ${m.tokens.toLocaleString()}`),
  ];
  try {
    await fetch(config.monitorWebhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: lines.join('\n').slice(0, 1900) }),
      signal: AbortSignal.timeout(5000),
    });
  } catch { /* best-effort; already deduped */ }
  return true;
}

// ─── budget suggestion (item 66) ────────────────────────────────────────────

/**
 * When no budget is confirmed and ≥7 full days of metered data exist, compute
 * suggested budget = ceil(p95 of daily metered spend × 1.5) and store it in
 * monitor_meta['daily_budget_suggested'] for the dashboard. Passive.
 */
export function updateBudgetSuggestion(now = new Date()): number | null {
  const db = getDb();
  const confirmed = (db.prepare(`SELECT value FROM monitor_meta WHERE key = 'daily_budget_usd'`).get() as any)?.value;
  if (confirmed && Number(confirmed) > 0) return null;
  const today = dayBucket(now);
  const days = db.prepare(`
    SELECT bucket, SUM(cost_usd) usd FROM usage_rollup_daily
    WHERE bucket < ? AND ${METERED}
    GROUP BY bucket ORDER BY bucket DESC LIMIT 30
  `).all(today) as any[];
  if (days.length < 7) return null;
  const usds = days.map((d) => d.usd).sort((a, b) => a - b);
  const p95 = usds[Math.min(usds.length - 1, Math.ceil(0.95 * usds.length) - 1)];
  const suggested = Math.max(1, Math.ceil(p95 * 1.5));
  metaSet('daily_budget_suggested', String(suggested));
  return suggested;
}
