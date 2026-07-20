// Monitoring alert rules engine (Phase 4 of docs/MONITORING-SYSTEM.md §6.1).
//
// Deterministic thresholds evaluated every rollup pass (5 min), reading rollup
// tables + bounded raw windows. Rules are code, thresholds env-overridable.
// Severity: warn = silent embed; critical = operator ping (see alert-send.ts).
//
// | Rule                | Trigger (defaults)                                     | Severity | Cooldown |
// |---------------------|--------------------------------------------------------|----------|----------|
// | pool_low            | ≤1 active account, provider had traffic in 24h        | critical | 6h/prov  |
// | error_spike         | error rate >20% over 15min, ≥20 requests               | critical | 1h/prov  |
// | daily_budget        | metered spend today ≥80% / ≥100% of confirmed budget   | warn/crit| 1/day ea |
// | cost_spike          | metered 1h > 3× same-hour 7d avg AND > $5              | warn     | 6h/prov  |
// | rate_limit_pressure | 429 share >10% over 1h, ≥30 requests                   | warn     | 2h/prov  |
// | cache_collapse      | hit rate <50% of 7d avg, ≥100k input tokens in hour    | warn     | 6h/prov  |
// | latency_degraded    | p95 15min > 2.5× 7d p95, ≥20 requests                  | warn     | 1h/prov  |
// | rollup_stalled      | newest hourly bucket older than 2h                     | critical | 6h       |
//
// daily_budget source of truth: monitor_meta['daily_budget_usd'] (set via the
// dashboard confirm flow) or MONITOR_DAILY_BUDGET_USD env; absent/0 = disabled.
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { fireMonitorAlert, type MonitorAlert } from './alert-send.js';
import { hourBucket, dayBucket } from './time-utils.js';
import { cacheHitDenominator } from './cache-accounting.js';

const H = 3600_000;

function num(envName: string, dflt: number): number {
  const v = Number(process.env[envName]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

// Raw-window helper: aggregate error stats per provider for the last N minutes.
function rawWindow(minutes: number, now: Date): Array<{ provider: string; requests: number; errors: number; errors429: number }> {
  const since = new Date(now.getTime() - minutes * 60_000).toISOString().slice(0, 19).replace('T', ' ');
  return getDb().prepare(`
    SELECT provider,
           COUNT(*) requests,
           SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) errors,
           SUM(CASE WHEN status_code = 429 THEN 1 ELSE 0 END) errors429
    FROM usage_events WHERE created_at >= ?
    GROUP BY provider
  `).all(since) as any[];
}

export function resolveDailyBudgetUsd(): number {
  const row = getDb().prepare(`SELECT value FROM monitor_meta WHERE key = 'daily_budget_usd'`).get() as any;
  const metaVal = row ? Number(row.value) : 0;
  if (Number.isFinite(metaVal) && metaVal > 0) return metaVal;
  return config.monitorDailyBudgetUsd;
}

/** All rules, one pass. Returns the alerts that actually fired (for tests/logs). */
export async function evaluateAlertRules(now = new Date()): Promise<string[]> {
  const db = getDb();
  const fired: string[] = [];
  const send = async (a: MonitorAlert) => { if (await fireMonitorAlert(a, now.getTime())) fired.push(`${a.rule}:${a.scope}`); };

  // ── pool_low (critical) ──────────────────────────────────────────────────
  {
    const dayAgo = new Date(now.getTime() - 24 * H).toISOString().slice(0, 19).replace('T', ' ');
    const traffic = new Set((db.prepare(`SELECT DISTINCT provider FROM usage_events WHERE created_at >= ?`).all(dayAgo) as any[]).map((r) => r.provider));
    const pools = db.prepare(`
      SELECT provider, SUM(CASE WHEN enabled = 1 AND status NOT IN ('cooldown','dead') THEN 1 ELSE 0 END) active
      FROM provider_accounts GROUP BY provider
    `).all() as any[];
    for (const p of pools) {
      if (!traffic.has(p.provider)) continue;
      if (p.active <= num('MONITOR_POOL_LOW_THRESHOLD', 1)) {
        await send({
          rule: 'pool_low', scope: p.provider, severity: 'critical', cooldownMs: 6 * H,
          title: `Pool low: ${p.provider}`,
          message: `${p.provider} has ${p.active} active account(s) left with live traffic in the last 24h. Requests may start failing.`,
          metadata: { provider: p.provider, active: p.active },
        });
      }
    }
  }

  // ── error_spike (critical) ───────────────────────────────────────────────
  {
    const minReq = num('MONITOR_ERROR_SPIKE_MIN_REQUESTS', 20);
    const threshold = num('MONITOR_ERROR_SPIKE_RATE', 0.2);
    for (const w of rawWindow(15, now)) {
      if (w.requests >= minReq && w.errors / w.requests > threshold) {
        await send({
          rule: 'error_spike', scope: w.provider, severity: 'critical', cooldownMs: 1 * H,
          title: `Error spike: ${w.provider}`,
          message: `${w.provider} error rate ${(100 * w.errors / w.requests).toFixed(1)}% over the last 15 min (${w.errors}/${w.requests}).`,
          metadata: { provider: w.provider, requests: w.requests, errors: w.errors, errors429: w.errors429 },
        });
      }
    }
  }

  // ── daily_budget (warn 80% / critical 100%) ──────────────────────────────
  {
    const budget = resolveDailyBudgetUsd();
    if (budget > 0) {
      const today = dayBucket(now);
      const spent = ((db.prepare(`
        SELECT COALESCE(SUM(cost_usd), 0) usd FROM usage_rollup_hourly
        WHERE bucket >= ? AND bucket < ? AND billing_mode NOT IN ('flat_fee','self_hosted','free_tier')
      `).get(`${today}T00`, `${today}T24`) as any)?.usd) || 0;
      const share = spent / budget;
      // Once-per-day-per-threshold via scope carrying the date.
      if (share >= 1) {
        await send({
          rule: 'daily_budget_100', scope: today, severity: 'critical', cooldownMs: 24 * H,
          title: 'Daily metered budget exceeded',
          message: `Metered spend today is $${spent.toFixed(2)} — ${(share * 100).toFixed(0)}% of the $${budget.toFixed(2)} budget.`,
          metadata: { spentUsd: spent.toFixed(4), budgetUsd: budget },
        });
      } else if (share >= num('MONITOR_BUDGET_WARN_SHARE', 0.8)) {
        await send({
          rule: 'daily_budget_80', scope: today, severity: 'warn', cooldownMs: 24 * H,
          title: 'Daily metered budget at 80%',
          message: `Metered spend today is $${spent.toFixed(2)} — ${(share * 100).toFixed(0)}% of the $${budget.toFixed(2)} budget.`,
          metadata: { spentUsd: spent.toFixed(4), budgetUsd: budget },
        });
      }
    }
  }

  // ── cost_spike (warn) ────────────────────────────────────────────────────
  {
    const prevHourBucket = hourBucket(new Date(now.getTime() - 1 * H));
    const lastHour = db.prepare(`
      SELECT provider, SUM(cost_usd) usd FROM usage_rollup_hourly
      WHERE bucket = ? AND billing_mode NOT IN ('flat_fee','self_hosted','free_tier')
      GROUP BY provider
    `).all(prevHourBucket) as any[];
    if (lastHour.length) {
      // 7d average of the same clock-hour per provider. Average over the
      // buckets that actually EXIST (not /7.0): dividing by 7 with sparse
      // history deflates the baseline and false-fires on new/low-traffic
      // providers. Require ≥3 historical buckets — fewer is no baseline.
      const sameHours: string[] = [];
      for (let d = 1; d <= 7; d++) sameHours.push(hourBucket(new Date(now.getTime() - 1 * H - d * 24 * H)));
      const marks = sameHours.map(() => '?').join(',');
      const hist = db.prepare(`
        SELECT provider, SUM(cost_usd) total_usd, COUNT(DISTINCT bucket) buckets
        FROM usage_rollup_hourly
        WHERE bucket IN (${marks}) AND billing_mode NOT IN ('flat_fee','self_hosted','free_tier')
        GROUP BY provider
      `).all(...sameHours) as any[];
      const minBuckets = num('MONITOR_COST_SPIKE_MIN_HISTORY', 3);
      const histBy = new Map(hist.filter((h) => h.buckets >= minBuckets).map((h) => [h.provider, h.total_usd / h.buckets]));
      const factor = num('MONITOR_COST_SPIKE_FACTOR', 3);
      const minUsd = num('MONITOR_COST_SPIKE_MIN_USD', 5);
      for (const r of lastHour) {
        const avg = histBy.get(r.provider) || 0;
        if (r.usd > minUsd && avg > 0 && r.usd > factor * avg) {
          await send({
            rule: 'cost_spike', scope: r.provider, severity: 'warn', cooldownMs: 6 * H,
            title: `Cost spike: ${r.provider}`,
            message: `${r.provider} metered spend last hour was $${r.usd.toFixed(2)} vs 7-day same-hour average $${avg.toFixed(2)} (${(r.usd / avg).toFixed(1)}×).`,
            metadata: { provider: r.provider, lastHourUsd: r.usd.toFixed(4), avg7dUsd: avg.toFixed(4) },
          });
        }
      }
    }
  }

  // ── rate_limit_pressure (warn) ───────────────────────────────────────────
  {
    const minReq = num('MONITOR_RATELIMIT_MIN_REQUESTS', 30);
    const share = num('MONITOR_RATELIMIT_SHARE', 0.1);
    for (const w of rawWindow(60, now)) {
      if (w.requests >= minReq && w.errors429 / w.requests > share) {
        await send({
          rule: 'rate_limit_pressure', scope: w.provider, severity: 'warn', cooldownMs: 2 * H,
          title: `Rate-limit pressure: ${w.provider}`,
          message: `${w.provider} saw ${(100 * w.errors429 / w.requests).toFixed(1)}% 429s over the last hour (${w.errors429}/${w.requests}). Pool may be undersized.`,
          metadata: { provider: w.provider, requests: w.requests, errors429: w.errors429 },
        });
      }
    }
  }

  // ── cache_collapse (warn) ────────────────────────────────────────────────
  {
    const prevHourBucket = hourBucket(new Date(now.getTime() - 1 * H));
    // Volume floor on the provider-aware hit-rate denominator.
    const minTokens = num('MONITOR_CACHE_COLLAPSE_MIN_TOKENS', 100_000);
    const rows = db.prepare(`
      SELECT provider, SUM(input_tokens) input, SUM(cache_read_tokens) cache_read
      FROM usage_rollup_hourly WHERE bucket = ? GROUP BY provider
    `).all(prevHourBucket) as any[];
    const weekAgoBucket = hourBucket(new Date(now.getTime() - 7 * 24 * H));
    const hist = db.prepare(`
      SELECT provider, SUM(input_tokens) input, SUM(cache_read_tokens) cache_read
      FROM usage_rollup_hourly WHERE bucket >= ? AND bucket < ? GROUP BY provider
    `).all(weekAgoBucket, prevHourBucket) as any[];
    const histBy = new Map(hist.map((h) => [h.provider, h]));
    for (const r of rows) {
      const denom = cacheHitDenominator(r.provider, r.input, r.cache_read);
      if (denom < minTokens) continue;
      const rate = r.cache_read / denom;
      const h = histBy.get(r.provider);
      const histDenom = h ? cacheHitDenominator(r.provider, h.input, h.cache_read) : 0;
      const histRate = histDenom > 0 ? h.cache_read / histDenom : null;
      if (histRate != null && histRate > 0.05 && rate < histRate * num('MONITOR_CACHE_COLLAPSE_FACTOR', 0.5)) {
        await send({
          rule: 'cache_collapse', scope: r.provider, severity: 'warn', cooldownMs: 6 * H,
          title: `Cache hit rate collapsed: ${r.provider}`,
          message: `${r.provider} cache hit rate last hour was ${(rate * 100).toFixed(1)}% vs 7-day average ${(histRate * 100).toFixed(1)}%.`,
          metadata: { provider: r.provider, hourRate: rate.toFixed(4), weekRate: histRate.toFixed(4) },
        });
      }
    }
  }

  // ── latency_degraded (warn) ──────────────────────────────────────────────
  {
    const minReq = num('MONITOR_LATENCY_MIN_REQUESTS', 20);
    const factor = num('MONITOR_LATENCY_FACTOR', 2.5);
    const since = new Date(now.getTime() - 15 * 60_000).toISOString().slice(0, 19).replace('T', ' ');
    const recent = db.prepare(`
      SELECT provider, COUNT(*) requests, latency_ms FROM usage_events
      WHERE created_at >= ? AND latency_ms IS NOT NULL GROUP BY provider, latency_ms
      ORDER BY provider, latency_ms
    `).all(since) as any[];
    // Exact p95 per provider via accumulative walk over the sorted grouped
    // rows — identical result to expanding each group into an array, without
    // allocating request-count-sized arrays.
    const byProvider = new Map<string, Array<{ latency: number; count: number }>>();
    for (const r of recent) {
      let arr = byProvider.get(r.provider);
      if (!arr) { arr = []; byProvider.set(r.provider, arr); }
      arr.push({ latency: r.latency_ms, count: r.requests });
    }
    const weekAgo = hourBucket(new Date(now.getTime() - 7 * 24 * H));
    const hist = db.prepare(`
      SELECT provider, latency_ms_p95, requests FROM usage_rollup_hourly
      WHERE bucket >= ? AND latency_ms_p95 IS NOT NULL
    `).all(weekAgo) as any[];
    const histByProvider = new Map<string, Array<[number, number]>>();
    for (const h of hist) {
      let arr = histByProvider.get(h.provider);
      if (!arr) { arr = []; histByProvider.set(h.provider, arr); }
      arr.push([h.latency_ms_p95, h.requests]);
    }
    const weightedMedian = (pairs: Array<[number, number]>): number | null => {
      if (!pairs.length) return null;
      pairs.sort((a, b) => a[0] - b[0]);
      const total = pairs.reduce((s, [, w]) => s + w, 0);
      let acc = 0;
      for (const [v, w] of pairs) { acc += w; if (acc >= total / 2) return v; }
      return pairs[pairs.length - 1][0];
    };
    for (const [provider, groups] of byProvider) {
      const total = groups.reduce((s, g) => s + g.count, 0);
      if (total < minReq) continue;
      // nearest-rank p95: the value at 1-based rank ceil(0.95 * total)
      const rank = Math.min(total, Math.ceil(0.95 * total));
      let acc = 0;
      let p95 = groups[groups.length - 1].latency;
      for (const g of groups) { acc += g.count; if (acc >= rank) { p95 = g.latency; break; } }
      const base = weightedMedian(histByProvider.get(provider) || []);
      if (base != null && base > 0 && p95 > factor * base) {
        await send({
          rule: 'latency_degraded', scope: provider, severity: 'warn', cooldownMs: 1 * H,
          title: `Latency degraded: ${provider}`,
          message: `${provider} p95 latency over the last 15 min is ${p95}ms vs 7-day baseline ${base}ms (${(p95 / base).toFixed(1)}×).`,
          metadata: { provider, p95Ms: p95, baselineMs: base, requests: total },
        });
      }
    }
  }

  // ── rollup_stalled (critical, self-monitoring) ───────────────────────────
  {
    const newest = (db.prepare(`SELECT MAX(bucket) b FROM usage_rollup_hourly`).get() as any)?.b as string | undefined;
    // Only meaningful once at least one rollup has ever run.
    if (newest) {
      const newestMs = Date.parse(`${newest}:00:00Z`);
      const ageH = (now.getTime() - newestMs) / H;
      if (Number.isFinite(newestMs) && ageH > num('MONITOR_ROLLUP_STALL_HOURS', 2)) {
        await send({
          rule: 'rollup_stalled', scope: '', severity: 'critical', cooldownMs: 6 * H,
          title: 'Monitoring rollup stalled',
          message: `Newest hourly rollup bucket is ${newest} (${ageH.toFixed(1)}h old). The monitoring pipeline itself may be broken.`,
          metadata: { newestBucket: newest, ageHours: ageH.toFixed(1) },
        });
      }
    }
  }

  return fired;
}
