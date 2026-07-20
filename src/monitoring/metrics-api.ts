// Monitoring metrics API (Phase 3 of docs/MONITORING-SYSTEM.md).
//
// Read-only /admin/metrics/* endpoints backed by the Phase 2 rollup tables
// (hourly for 24h ranges, daily + today's hourly for 7d/30d). The current
// partial hour is served from raw usage_events (indexed, small window).
//
// Access: root admin (dashboard session or DEV_ADMIN_KEY) as everywhere else,
// PLUS the monitor role — users whose email is in MONITOR_ACCESS_EMAILS may
// read these endpoints (and ONLY these) authenticated by their normal API
// token. Every monitor-authenticated request is audit-logged.
//
// Money invariant: metered / notional (flat-fee) / self-hosted costs are NEVER
// summed into a single number in any response. Always split by billing mode.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { audit } from '../admin/audit.js';
import { getDashboardUser, requireDashboardAdmin } from '../auth/dashboard-auth.js';
import { getProxyToken } from '../auth/token-auth.js';
import { sha256 } from '../utils/crypto.js';
import { getGovernorSnapshot } from '../providers/governor.js';
import { hourBucket, dayBucket } from './time-utils.js';
import { getRollupStatus } from './rollup.js';
import { cacheHitDenominator, tokenWeightedCacheHitRate, totalTokens } from './cache-accounting.js';

export interface MonitorActor {
  id: number;
  email: string;
  /** true = full admin; false = read-only monitor allowlist */
  isRootAdmin: boolean;
}

/**
 * Read-only guard for /admin/metrics/*.
 * Order: root admin (session cookie or dev key) → monitor allowlist via API
 * token → monitor allowlist via dashboard session. 403 otherwise.
 * NEVER reuse this on mutating routes — it grants less than requireAdmin but
 * to more people.
 */
export function requireMonitor(req: FastifyRequest, reply: FastifyReply): MonitorActor | null {
  // Root admin paths (same as every other /admin route).
  const dash = getDashboardUser(req);
  if (dash?.isAdmin) return { id: dash.id, email: dash.email, isRootAdmin: true };
  const devKey = process.env.DEV_ADMIN_KEY;
  if (devKey && req.headers['x-admin-key'] === devKey) return { id: 0, email: 'dev-admin', isRootAdmin: true };

  // Monitor allowlist via dashboard session (non-admin user signed into console).
  if (dash && config.monitorAccessEmails.has(dash.email.toLowerCase())) {
    audit({ actorUserId: dash.id, action: 'monitor_metrics_read', targetType: 'metrics', targetId: req.url.slice(0, 200) });
    return { id: dash.id, email: dash.email, isRootAdmin: false };
  }

  // Monitor allowlist via API token (Authorization: Bearer nbmg_…).
  const token = getProxyToken(req);
  if (token) {
    const row = getDb().prepare(`
      SELECT u.id, u.email, u.enabled user_enabled, t.enabled token_enabled
      FROM api_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ?
    `).get(sha256(token)) as any;
    if (row && row.user_enabled && row.token_enabled && config.monitorAccessEmails.has(String(row.email).toLowerCase())) {
      audit({ actorUserId: row.id, action: 'monitor_metrics_read', targetType: 'metrics', targetId: req.url.slice(0, 200) });
      return { id: row.id, email: row.email, isRootAdmin: false };
    }
  }

  reply.code(403).send({ error: 'Forbidden' });
  return null;
}

// ─── range → bucket sources ─────────────────────────────────────────────────

type Range = '24h' | '2d' | '7d' | '30d' | 'custom';
const RANGES: Record<Exclude<Range, 'custom'>, { hours: number }> = { '24h': { hours: 24 }, '2d': { hours: 48 }, '7d': { hours: 168 }, '30d': { hours: 720 } };

/**
 * Resolved time window. All bounds are UTC and half-open: [startMs, endMs).
 * - Preset ranges (24h/2d/7d/30d): endMs = now, startMs = now - hours.
 * - Custom (from/to inclusive dates): startMs = from T00:00:00Z,
 *   endMs = (to + 1 day) T00:00:00Z. The +1 day makes `to` an INCLUSIVE
 *   calendar day and is the single guard against off-by-one — a request for
 *   from=2026-07-01&to=2026-07-01 covers exactly one full UTC day.
 * `hours` is the window length; `interval` picks hourly vs daily buckets
 * (hourly only when the window is ≤ 48h, matching the raw hourly retention).
 */
interface Window { startMs: number; endMs: number; hours: number; interval: 'hour' | 'day'; }

function resolveWindow(q: { range: Range; from?: string; to?: string }, now = new Date()): Window {
  if (q.range === 'custom') {
    // from/to are YYYY-MM-DD (validated by zod). Parse as UTC midnight.
    const startMs = Date.parse(`${q.from}T00:00:00.000Z`);
    // Inclusive end: add one full day to the `to` date.
    const toMidnight = Date.parse(`${q.to}T00:00:00.000Z`);
    const endMs = toMidnight + 24 * 3600_000;
    const hours = Math.max(1, Math.round((endMs - startMs) / 3600_000));
    return { startMs, endMs, hours, interval: hours <= 48 ? 'hour' : 'day' };
  }
  const hours = RANGES[q.range].hours;
  // Live ranges end 'now'. Nudge the end 1s into the future so a row stamped at
  // the current second (created_at == now) is unambiguously inside [start, end).
  const endMs = now.getTime() + 1000;
  return { startMs: endMs - hours * 3600_000, endMs, hours, interval: hours <= 48 ? 'hour' : 'day' };
}

/**
 * Rows for a range, unioned from the right sources:
 * - 24h: hourly buckets (last 24), normalized bucket → hour string
 * - 7d/30d: daily buckets for full past days + today's hourly buckets
 * Each row: { bucket, provider, model, user_id, billing_mode, …sums }
 */
function selectRollups(win: Window, filters: { provider?: string; model?: string; userId?: number }): any[] {
  const db = getDb();
  const conds: string[] = [];
  const params: any[] = [];
  if (filters.provider) { conds.push('provider = ?'); params.push(filters.provider); }
  if (filters.model) { conds.push('model = ?'); params.push(filters.model); }
  if (filters.userId != null) { conds.push('user_id = ?'); params.push(filters.userId); }
  const extra = conds.length ? ` AND ${conds.join(' AND ')}` : '';

  const startDate = new Date(win.startMs);
  const endDate = new Date(win.endMs);

  // Upper bound: buckets are keyed by their START. To make endMs behave as an
  // inclusive instant (live 'now' ranges must include the in-progress hour/day,
  // custom ranges end exactly at a midnight boundary), we bound by the bucket
  // key STRICTLY BEFORE the bucket that starts AT endMs. Concretely:
  //   endHourExcl = hourBucket(endMs - 1ms), then include buckets <= endHourExcl.
  // Using `<= endHourExcl` (or equivalently `< hourBucket(endMs)` only when endMs
  // is a boundary) keeps both cases correct.
  const endInclusive = new Date(win.endMs - 1); // last instant inside the window

  if (win.interval === 'hour') {
    const startHour = hourBucket(startDate);
    const endHour = hourBucket(endInclusive); // inclusive last hour bucket
    return db.prepare(`SELECT * FROM usage_rollup_hourly WHERE bucket >= ? AND bucket <= ?${extra}`).all(startHour, endHour, ...params) as any[];
  }
  // interval === 'day': full days from daily + the trailing (possibly partial)
  // day from hourly. lastDay is the inclusive final calendar day of the window.
  const startDay = dayBucket(startDate);
  const lastDay = dayBucket(endInclusive);
  // Daily rows for every full day EXCEPT the last (which may be partial) come
  // from the daily table; the last day is composed from hourly for freshness.
  const daily = db.prepare(`SELECT * FROM usage_rollup_daily WHERE bucket >= ? AND bucket < ?${extra}`).all(startDay, lastDay, ...params) as any[];
  // Last day from hourly: buckets in [lastDay T00, endMs). endHourExcl is the
  // inclusive last hour bucket of the window. We prefer hourly for the last day
  // so an in-progress 'today' reflects the newest sub-hour activity.
  const endHourExcl = hourBucket(endInclusive);
  const todayHourly = db.prepare(`SELECT * FROM usage_rollup_hourly WHERE bucket >= ? AND bucket <= ?${extra}`).all(`${lastDay}T00`, endHourExcl, ...params) as any[];
  for (const r of todayHourly) r.bucket = lastDay;
  // Retention fallback (day-interval / >48h windows only): hourly rollups are
  // pruned after monitorRetentionHourlyDays, but daily rollups are kept forever.
  // If the last day is a COMPLETE past day (window ends at/after its next
  // midnight) and hourly returned nothing for it, the hourly data was pruned —
  // fall back to the daily rollup so the final day isn't silently dropped from
  // long-lookback custom ranges. We must NOT do this for an in-progress 'today'
  // (endInclusive within lastDay), or a partial final day would be counted as a
  // full day from the daily table.
  const lastDayComplete = win.endMs >= Date.parse(`${lastDay}T00:00:00.000Z`) + 24 * 3600_000;
  if (lastDayComplete && todayHourly.length === 0) {
    const lastDaily = db.prepare(`SELECT * FROM usage_rollup_daily WHERE bucket = ?${extra}`).all(lastDay, ...params) as any[];
    return daily.concat(lastDaily);
  }
  return daily.concat(todayHourly);
}

// ─── shared aggregation helpers ─────────────────────────────────────────────

interface CostSplit { metered: number; notional: number; selfHosted: number; freeTier: number }

function emptyCostSplit(): CostSplit { return { metered: 0, notional: 0, selfHosted: 0, freeTier: 0 } }

function addCost(split: CostSplit, billingMode: string, usd: number): void {
  if (billingMode === 'flat_fee') split.notional += usd;
  else if (billingMode === 'self_hosted') split.selfHosted += usd;
  else if (billingMode === 'free_tier') split.freeTier += usd;
  else split.metered += usd;
}

function roundSplit(s: CostSplit): CostSplit {
  const r = (x: number) => Math.round(x * 1_000_000) / 1_000_000;
  return { metered: r(s.metered), notional: r(s.notional), selfHosted: r(s.selfHosted), freeTier: r(s.freeTier) };
}

function cacheHitRate(provider: string, cacheRead: number, input: number): number | null {
  return tokenWeightedCacheHitRate(provider, cacheRead, input);
}

/**
 * Per-request cache hit rate: fraction of CACHEABLE requests that actually got
 * a cache read. Distinct from cacheHitRate() above, which is token-weighted
 * with a provider-aware denominator and makes healthy providers look broken
 * when a few huge uncached prompts dominate the token mix. Denominator is the
 * count of requests whose prompt met the caching floor (see rollup
 * CACHEABLE_MIN_TOKENS), so tiny uncacheable prompts don't drag it down.
 */
function cacheHitRatePerRequest(cacheHitRequests: number, cacheableRequests: number): number | null {
  if (!cacheableRequests) return null;
  return Math.round((cacheHitRequests / cacheableRequests) * 10_000) / 10_000;
}

function previousWindow(win: Window): Window {
  const durationMs = win.endMs - win.startMs;
  return {
    startMs: win.startMs - durationMs,
    endMs: win.startMs,
    hours: Math.max(1, Math.round(durationMs / 3600_000)),
    interval: win.interval,
  };
}

function aggregateCacheRollups(rows: any[]): any[] {
  const byModel = new Map<string, any>();
  for (const r of rows) {
    const key = `${r.provider}\u0000${r.model}`;
    let a = byModel.get(key);
    if (!a) {
      a = {
        provider: r.provider,
        model: r.model,
        cache_read: 0,
        cache_write: 0,
        input: 0,
        hit_denom: 0,
        saved: 0,
        cacheable_requests: 0,
        cache_hit_requests: 0,
      };
      byModel.set(key, a);
    }
    a.cache_read += Number(r.cache_read_tokens) || 0;
    a.cache_write += Number(r.cache_creation_tokens) || 0;
    a.input += Number(r.input_tokens) || 0;
    a.hit_denom += cacheHitDenominator(r.provider, r.input_tokens, r.cache_read_tokens);
    a.saved += Number(r.cache_saved_usd) || 0;
    a.cacheable_requests += Number(r.cacheable_requests) || 0;
    a.cache_hit_requests += Number(r.cache_hit_requests) || 0;
  }
  return [...byModel.values()];
}

function rawRetentionCutoffMs(now: Date): number | null {
  if (!config.monitorRetentionEnabled) return null;
  return now.getTime() - config.monitorRetentionRawDays * 24 * 3600_000;
}

function rawRangeUnsupported(win: Window, now: Date): boolean {
  const cutoff = rawRetentionCutoffMs(now);
  return cutoff != null && win.startMs < cutoff;
}

const rangeSchema = z.enum(['24h', '2d', '7d', '30d', 'custom']).default('24h');
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
// Shared range query: preset ranges, or custom with inclusive from/to dates.
// Refined so custom requires both dates and from <= to (prevents inverted/
// empty windows and the classic off-by-one where to < from silently returns 0).
const rangeQuery = z.object({
  range: rangeSchema,
  from: dateSchema.optional(),
  to: dateSchema.optional(),
}).refine((q) => q.range !== 'custom' || (q.from && q.to && q.from <= q.to), {
  message: 'custom range requires from and to (YYYY-MM-DD) with from <= to',
});

// ─── endpoints ──────────────────────────────────────────────────────────────

export function registerMetricsApi(app: FastifyInstance) {
  // Overview: totals + per-provider rows.
  app.get('/admin/metrics/overview', async (req, reply) => {
    const actor = requireMonitor(req, reply); if (!actor) return;
    const q = rangeQuery.parse(req.query || {});
    const win = resolveWindow(q);
    const rows = selectRollups(win, {});

    const totals = {
      requests: 0, errors: 0, errors429: 0,
      inputTokens: 0, outputTokens: 0, reasoningTokens: 0,
      cacheReadTokens: 0, cacheCreationTokens: 0, cacheHitDenominator: 0, compressionSavedTokens: 0,
      cost: emptyCostSplit(), cacheSavedUsd: 0, retries: 0, latencyMsSum: 0,
      cacheableRequests: 0, cacheHitRequests: 0,
    };
    const byProvider = new Map<string, any>();
    for (const r of rows) {
      totals.requests += r.requests;
      totals.errors += r.errors_4xx + r.errors_429 + r.errors_5xx;
      totals.errors429 += r.errors_429;
      totals.inputTokens += r.input_tokens;
      totals.outputTokens += r.output_tokens;
      totals.reasoningTokens += r.reasoning_tokens;
      totals.cacheReadTokens += r.cache_read_tokens;
      totals.cacheCreationTokens += r.cache_creation_tokens;
      totals.cacheHitDenominator += cacheHitDenominator(r.provider, r.input_tokens, r.cache_read_tokens);
      totals.compressionSavedTokens += r.tokens_saved_compression;
      addCost(totals.cost, r.billing_mode, r.cost_usd);
      totals.cacheSavedUsd += r.cache_saved_usd;
      totals.retries += r.retry_count;
      totals.latencyMsSum += r.latency_ms_sum;
      totals.cacheableRequests += r.cacheable_requests || 0;
      totals.cacheHitRequests += r.cache_hit_requests || 0;

      let p = byProvider.get(r.provider);
      if (!p) {
        p = { provider: r.provider, requests: 0, errors: 0, errors429: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cacheHitDenominator: 0, cost: emptyCostSplit(), cacheSavedUsd: 0, retries: 0, latencyMsSum: 0, cacheableRequests: 0, cacheHitRequests: 0 };
        byProvider.set(r.provider, p);
      }
      p.requests += r.requests;
      p.errors += r.errors_4xx + r.errors_429 + r.errors_5xx;
      p.errors429 += r.errors_429;
      p.inputTokens += r.input_tokens;
      p.outputTokens += r.output_tokens;
      p.reasoningTokens += r.reasoning_tokens;
      p.cacheReadTokens += r.cache_read_tokens;
      p.cacheCreationTokens += r.cache_creation_tokens;
      p.cacheHitDenominator += cacheHitDenominator(r.provider, r.input_tokens, r.cache_read_tokens);
      addCost(p.cost, r.billing_mode, r.cost_usd);
      p.cacheSavedUsd += r.cache_saved_usd;
      p.retries += r.retry_count;
      p.latencyMsSum += r.latency_ms_sum;
      p.cacheableRequests += r.cacheable_requests || 0;
      p.cacheHitRequests += r.cache_hit_requests || 0;
    }

    const providers = [...byProvider.values()]
      .map((p) => ({
        ...p,
        cost: roundSplit(p.cost),
        cacheSavedUsd: Math.round(p.cacheSavedUsd * 1_000_000) / 1_000_000,
        cacheHitRate: cacheHitRate(p.provider, p.cacheReadTokens, p.inputTokens),
        cacheHitRatePerRequest: cacheHitRatePerRequest(p.cacheHitRequests, p.cacheableRequests),
        cacheableRequests: p.cacheableRequests,
        cacheHitRequests: p.cacheHitRequests,
        errorRate: p.requests ? Math.round((p.errors / p.requests) * 10_000) / 10_000 : 0,
        avgLatencyMs: p.requests ? Math.round(p.latencyMsSum / p.requests) : null,
      }))
      .sort((a, b) => b.requests - a.requests);

    return {
      range: q.range,
      rollup: getRollupStatus(),
      totals: {
        ...totals,
        cost: roundSplit(totals.cost),
        cacheSavedUsd: Math.round(totals.cacheSavedUsd * 1_000_000) / 1_000_000,
        cacheHitRate: totals.cacheHitDenominator ? Math.round((totals.cacheReadTokens / totals.cacheHitDenominator) * 10_000) / 10_000 : null,
        cacheHitRatePerRequest: cacheHitRatePerRequest(totals.cacheHitRequests, totals.cacheableRequests),
        cacheableRequests: totals.cacheableRequests,
        cacheHitRequests: totals.cacheHitRequests,
        errorRate: totals.requests ? Math.round((totals.errors / totals.requests) * 10_000) / 10_000 : 0,
        avgLatencyMs: totals.requests ? Math.round(totals.latencyMsSum / totals.requests) : null,
      },
      providers,
    };
  });

  // Timeseries for charting.
  app.get('/admin/metrics/timeseries', async (req, reply) => {
    const actor = requireMonitor(req, reply); if (!actor) return;
    const q = z.object({
      metric: z.enum(['requests', 'tokens_in', 'tokens_out', 'reasoning_tokens', 'cache_hit_rate', 'cache_saved_usd', 'cost_usd', 'error_rate', 'latency_p50', 'latency_p95', 'ttft_p50', 'ttft_p95', 'retries', 'compression_saved']),
      range: rangeSchema,
      from: dateSchema.optional(),
      to: dateSchema.optional(),
      interval: z.enum(['hour', 'day']).optional(),
      provider: z.string().optional(),
      model: z.string().optional(),
      userId: z.coerce.number().int().optional(),
    }).refine((x) => x.range !== 'custom' || (x.from && x.to && x.from <= x.to), {
      message: 'custom range requires from and to (YYYY-MM-DD) with from <= to',
    }).parse(req.query || {});
    const win = resolveWindow(q);
    // Explicit interval override still honoured; otherwise use the window's.
    if (q.interval) win.interval = q.interval;
    const interval = win.interval;
    const rows = selectRollups(win, { provider: q.provider, model: q.model, userId: q.userId });

    // Group by bucket; percentile metrics use request-weighted median across groups.
    const buckets = new Map<string, { requests: number; errors: number; in: number; out: number; reasoning: number; cacheRead: number; hitDenom: number; saved: number; cost: CostSplit; retries: number; compression: number; pct: Array<[number, number]> }>();
    const pctField = q.metric === 'latency_p50' ? 'latency_ms_p50' : q.metric === 'latency_p95' ? 'latency_ms_p95' : q.metric === 'ttft_p50' ? 'ttft_ms_p50' : q.metric === 'ttft_p95' ? 'ttft_ms_p95' : null;
    for (const r of rows) {
      let b = buckets.get(r.bucket);
      if (!b) { b = { requests: 0, errors: 0, in: 0, out: 0, reasoning: 0, cacheRead: 0, hitDenom: 0, saved: 0, cost: emptyCostSplit(), retries: 0, compression: 0, pct: [] }; buckets.set(r.bucket, b); }
      b.requests += r.requests;
      b.errors += r.errors_4xx + r.errors_429 + r.errors_5xx;
      b.in += r.input_tokens;
      b.out += r.output_tokens;
      b.reasoning += r.reasoning_tokens;
      b.cacheRead += r.cache_read_tokens;
      b.hitDenom += cacheHitDenominator(r.provider, r.input_tokens, r.cache_read_tokens);
      b.saved += r.cache_saved_usd;
      addCost(b.cost, r.billing_mode, r.cost_usd);
      b.retries += r.retry_count;
      b.compression += r.tokens_saved_compression;
      if (pctField && r[pctField] != null) b.pct.push([r[pctField], r.requests]);
    }
    const weightedMedian = (pairs: Array<[number, number]>): number | null => {
      if (!pairs.length) return null;
      pairs.sort((a, b) => a[0] - b[0]);
      const total = pairs.reduce((s, [, w]) => s + w, 0);
      let acc = 0;
      for (const [v, w] of pairs) { acc += w; if (acc >= total / 2) return v; }
      return pairs[pairs.length - 1][0];
    };
    const series = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([bucket, b]) => {
      let value: number | CostSplit | null;
      switch (q.metric) {
        case 'requests': value = b.requests; break;
        case 'tokens_in': value = b.in; break;
        case 'tokens_out': value = b.out; break;
        case 'reasoning_tokens': value = b.reasoning; break;
        case 'cache_hit_rate': value = b.hitDenom ? Math.round((b.cacheRead / b.hitDenom) * 10_000) / 10_000 : null; break;
        case 'cache_saved_usd': value = Math.round(b.saved * 1_000_000) / 1_000_000; break;
        case 'cost_usd': value = roundSplit(b.cost); break;
        case 'error_rate': value = b.requests ? Math.round((b.errors / b.requests) * 10_000) / 10_000 : 0; break;
        case 'retries': value = b.retries; break;
        case 'compression_saved': value = b.compression; break;
        default: value = weightedMedian(b.pct);
      }
      return { bucket, value };
    });
    return { metric: q.metric, range: q.range, interval, series };
  });

  // Cache efficiency per provider/model with trend vs previous period.
  app.get('/admin/metrics/cache', async (req, reply) => {
    const actor = requireMonitor(req, reply); if (!actor) return;
    const q = rangeQuery.parse(req.query || {});
    const win = resolveWindow(q);
    // Current window and an equal-length immediately-preceding window for trend.
    // Use the same retention-aware rollup composition as the rest of metrics:
    // short windows come from hourly; longer/custom windows use daily rollups
    // plus the live trailing day from hourly. This avoids silently dropping
    // cache activity after hourly rollups have been pruned.
    const current = aggregateCacheRollups(selectRollups(win, {}));
    const previous = new Map(aggregateCacheRollups(selectRollups(previousWindow(win), {})).map((r) => [`${r.provider}\u0000${r.model}`, r]));
    return {
      range: q.range,
      rows: current
        .map((r) => {
          const p = previous.get(`${r.provider}\u0000${r.model}`);
          const rate = cacheHitRate(r.provider, r.cache_read, r.input);
          const prevRate = p ? cacheHitRate(r.provider, p.cache_read, p.input) : null;
          const reqRate = cacheHitRatePerRequest(r.cache_hit_requests || 0, r.cacheable_requests || 0);
          const prevReqRate = p ? cacheHitRatePerRequest(p.cache_hit_requests || 0, p.cacheable_requests || 0) : null;
          return {
            provider: r.provider, model: r.model,
            cacheReadTokens: r.cache_read, cacheWriteTokens: r.cache_write,
            hitRate: rate, prevHitRate: prevRate,
            hitRatePerRequest: reqRate, prevHitRatePerRequest: prevReqRate,
            cacheableRequests: r.cacheable_requests || 0, cacheHitRequests: r.cache_hit_requests || 0,
            readWriteRatio: r.cache_write ? Math.round((r.cache_read / r.cache_write) * 100) / 100 : null,
            savedUsd: Math.round(r.saved * 1_000_000) / 1_000_000,
          };
        })
        .filter((r) => r.cacheReadTokens || r.cacheWriteTokens)
        .sort((a, b) => b.savedUsd - a.savedUsd),
    };
  });

  // Top-N by dimension.
  app.get('/admin/metrics/top', async (req, reply) => {
    const actor = requireMonitor(req, reply); if (!actor) return;
    const q = z.object({
      dimension: z.enum(['user', 'model', 'provider']),
      by: z.enum(['cost', 'tokens', 'requests', 'errors']).default('cost'),
      range: rangeSchema,
      from: dateSchema.optional(),
      to: dateSchema.optional(),
      limit: z.coerce.number().int().min(1).max(50).default(10),
    }).refine((x) => x.range !== 'custom' || (x.from && x.to && x.from <= x.to), {
      message: 'custom range requires from and to (YYYY-MM-DD) with from <= to',
    }).parse(req.query || {});
    const rows = selectRollups(resolveWindow(q), {});
    const keyOf = (r: any) => q.dimension === 'user' ? String(r.user_id) : q.dimension === 'model' ? `${r.provider}/${r.model}` : r.provider;
    const agg = new Map<string, { key: string; requests: number; errors: number; tokens: number; cacheReadTokens: number; cacheCreationTokens: number; inputTokens: number; cacheableRequests: number; cacheHitRequests: number; cacheHitDenominator: number; cost: CostSplit }>();
    for (const r of rows) {
      const k = keyOf(r);
      let a = agg.get(k);
      if (!a) { a = { key: k, requests: 0, errors: 0, tokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, inputTokens: 0, cacheableRequests: 0, cacheHitRequests: 0, cacheHitDenominator: 0, cost: emptyCostSplit() }; agg.set(k, a); }
      a.requests += r.requests;
      a.errors += r.errors_4xx + r.errors_429 + r.errors_5xx;
      a.tokens += totalTokens(r.provider, r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_creation_tokens);
      a.cacheReadTokens += r.cache_read_tokens;
      a.cacheCreationTokens += r.cache_creation_tokens;
      a.inputTokens += r.input_tokens;
      a.cacheHitDenominator += cacheHitDenominator(r.provider, r.input_tokens, r.cache_read_tokens);
      a.cacheableRequests += r.cacheable_requests || 0;
      a.cacheHitRequests += r.cache_hit_requests || 0;
      addCost(a.cost, r.billing_mode, r.cost_usd);
    }
    const totalCost = (c: CostSplit) => c.metered + c.notional + c.selfHosted + c.freeTier;
    const sorted = [...agg.values()].sort((a, b) => {
      switch (q.by) {
        case 'requests': return b.requests - a.requests;
        case 'errors': return b.errors - a.errors;
        case 'tokens': return b.tokens - a.tokens;
        default: return totalCost(b.cost) - totalCost(a.cost);
      }
    }).slice(0, q.limit);
    // Resolve user emails for the user dimension.
    if (q.dimension === 'user') {
      const db = getDb();
      for (const row of sorted) {
        const u = db.prepare('SELECT email FROM users WHERE id = ?').get(Number(row.key)) as any;
        (row as any).label = Number(row.key) === 0 ? '(unattributed)' : (u?.email || `user #${row.key}`);
      }
    }
    return { dimension: q.dimension, by: q.by, range: q.range, rows: sorted.map((r) => ({
      ...r,
      // Honest per-request cache hit rate (matches #135 overview/per-provider metric):
      // fraction of cacheable requests that actually got a cache read. This is the visible column.
      cacheHitRatePerRequest: cacheHitRatePerRequest(r.cacheHitRequests, r.cacheableRequests),
      // Token-weighted value kept for reference/back-compat; NOT the visible column.
      cacheHitRate: r.cacheHitDenominator ? Math.round((r.cacheReadTokens / r.cacheHitDenominator) * 10_000) / 10_000 : null,
      cost: roundSplit(r.cost),
    })) };
  });

  // Reliability: error classes, retries, pool snapshot, recent health events.
  app.get('/admin/metrics/reliability', async (req, reply) => {
    const actor = requireMonitor(req, reply); if (!actor) return;
    const q = rangeQuery.parse(req.query || {});
    const win = resolveWindow(q);
    const rows = selectRollups(win, {});
    const byProvider = new Map<string, any>();
    for (const r of rows) {
      let p = byProvider.get(r.provider);
      if (!p) { p = { provider: r.provider, requests: 0, errors4xx: 0, errors429: 0, errors5xx: 0, retries: 0 }; byProvider.set(r.provider, p); }
      p.requests += r.requests;
      p.errors4xx += r.errors_4xx;
      p.errors429 += r.errors_429;
      p.errors5xx += r.errors_5xx;
      p.retries += r.retry_count;
    }
    const db = getDb();
    // Pool snapshot: accounts per provider by status + live in-flight.
    const accounts = db.prepare(`SELECT provider, status, enabled, COUNT(*) n FROM provider_accounts GROUP BY provider, status, enabled`).all() as any[];
    const governor = getGovernorSnapshot();
    const inFlightTotal = Object.values(governor).reduce((s: number, g: any) => s + (g.inFlight || 0), 0);
    const pools = new Map<string, { provider: string; active: number; cooldown: number; dead: number; disabled: number; total: number }>();
    for (const a of accounts) {
      let p = pools.get(a.provider);
      if (!p) { p = { provider: a.provider, active: 0, cooldown: 0, dead: 0, disabled: 0, total: 0 }; pools.set(a.provider, p); }
      p.total += a.n;
      if (!a.enabled) p.disabled += a.n;
      else if (a.status === 'active') p.active += a.n;
      else if (a.status === 'cooldown') p.cooldown += a.n;
      else if (a.status === 'dead') p.dead += a.n;
      else p.active += a.n; // unknown-but-enabled counts as usable
    }
    const healthEvents = db.prepare(`
      SELECT e.id, e.provider_account_id, a.provider, a.label, e.status, e.reason, e.created_at
      FROM provider_health_events e LEFT JOIN provider_accounts a ON a.id = e.provider_account_id
      ORDER BY e.id DESC LIMIT 25
    `).all();
    // Retry reasons from raw events (indexed by provider+created_at; range-bound).
    const since = new Date(win.startMs).toISOString().slice(0, 19).replace('T', ' ');
    // Inclusive upper bound = last full second inside the window (endMs - 1s).
    // For live ranges endMs≈now so this counts the just-now row; for custom
    // ranges endMs is next-day midnight so this is 'to' day 23:59:59 (correct,
    // never leaks the excluded following day).
    const until = new Date(win.endMs - 1000).toISOString().slice(0, 19).replace('T', ' ');
    const retryReasons = db.prepare(`
      SELECT provider, retry_reason reason, COUNT(*) n, SUM(retry_count) attempts
      FROM usage_events
      WHERE created_at >= ? AND created_at <= ? AND retry_reason IS NOT NULL
      GROUP BY provider, retry_reason ORDER BY attempts DESC
    `).all(since, until);
    return {
      range: q.range,
      providers: [...byProvider.values()].map((p) => ({
        ...p,
        errorRate: p.requests ? Math.round(((p.errors4xx + p.errors429 + p.errors5xx) / p.requests) * 10_000) / 10_000 : 0,
      })).sort((a, b) => b.requests - a.requests),
      pools: [...pools.values()].sort((a, b) => a.provider.localeCompare(b.provider)),
      inFlightTotal,
      retryReasons,
      healthEvents,
    };
  });

  // Flat-fee subscription utilization: notional value absorbed per account +
  // pressure signals (429/cooldown frequency).
  app.get('/admin/metrics/utilization', async (req, reply) => {
    const actor = requireMonitor(req, reply); if (!actor) return;
    const q = rangeQuery.parse(req.query || {});
    const now = new Date();
    const win = resolveWindow(q, now);
    const cutoff = rawRetentionCutoffMs(now);
    if (rawRangeUnsupported(win, now)) {
      return reply.code(400).send({
        error: 'Unsupported range for per-account utilization',
        detail: 'Per-account flat-fee utilization is only available while raw usage_events are retained; provider account labels are not present in aggregate rollups.',
        rawRetentionDays: config.monitorRetentionRawDays,
        oldestSupportedAt: new Date(cutoff!).toISOString(),
      });
    }
    const db = getDb();
    const since = new Date(win.startMs).toISOString().slice(0, 19).replace('T', ' ');
    // Inclusive upper bound = last full second inside the window (see reliability).
    const until = new Date(win.endMs - 1000).toISOString().slice(0, 19).replace('T', ' ');
    // Per-account from raw (rollups don't keep account grain — acceptable:
    // indexed by provider+created_at, and this endpoint is on-demand).
    const rows = db.prepare(`
      SELECT e.provider, COALESCE(e.provider_account_label, '(unknown)') account,
             COUNT(*) requests,
             SUM(CASE WHEN e.status_code = 429 THEN 1 ELSE 0 END) rate_limited,
             SUM(e.estimated_cost_usd) notional_usd,
             SUM(e.input_tokens + e.output_tokens + e.cache_read_tokens + e.cache_creation_tokens) tokens
      FROM usage_events e
      WHERE e.created_at >= ? AND e.created_at <= ? AND e.billing_mode = 'flat_fee'
      GROUP BY e.provider, e.provider_account_label
      ORDER BY notional_usd DESC
    `).all(since, until) as any[];
    return {
      range: q.range,
      accounts: rows.map((r) => ({
        provider: r.provider, account: r.account, requests: r.requests, tokens: r.tokens,
        rateLimited: r.rate_limited,
        rateLimitedShare: r.requests ? Math.round((r.rate_limited / r.requests) * 10_000) / 10_000 : 0,
        notionalUsd: Math.round(r.notional_usd * 1_000_000) / 1_000_000,
      })),
    };
  });

  // Month-to-date metered burn + linear projection.
  app.get('/admin/metrics/burn', async (req, reply) => {
    const actor = requireMonitor(req, reply); if (!actor) return;
    const q = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional() }).parse(req.query || {});
    const db = getDb();
    const now = new Date();
    const month = q.month || now.toISOString().slice(0, 7);
    const isCurrentMonth = month === now.toISOString().slice(0, 7);
    const rows = db.prepare(`
      SELECT provider, SUM(cost_usd) usd
      FROM usage_rollup_daily
      WHERE bucket >= ? AND bucket < ? AND billing_mode NOT IN ('flat_fee','self_hosted','free_tier')
      GROUP BY provider
    `).all(`${month}-01`, `${month}-99`) as any[];
    // Include today's hourly (not yet in daily) for the current month.
    if (isCurrentMonth) {
      const today = dayBucket(now);
      const todayRows = db.prepare(`
        SELECT provider, SUM(cost_usd) usd FROM usage_rollup_hourly
        WHERE bucket >= ? AND billing_mode NOT IN ('flat_fee','self_hosted','free_tier')
        GROUP BY provider
      `).all(`${today}T00`) as any[];
      const byP = new Map(rows.map((r) => [r.provider, r]));
      for (const t of todayRows) {
        const existing = byP.get(t.provider);
        if (existing) existing.usd += t.usd;
        else rows.push(t);
      }
    }
    const total = rows.reduce((s, r) => s + r.usd, 0);
    const daysInMonth = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
    const dayOfMonth = isCurrentMonth ? now.getUTCDate() : daysInMonth;
    const fractionElapsed = isCurrentMonth
      ? (dayOfMonth - 1 + (now.getUTCHours() + now.getUTCMinutes() / 60) / 24) / daysInMonth
      : 1;
    const r6 = (x: number) => Math.round(x * 1_000_000) / 1_000_000;
    return {
      month,
      meteredUsd: r6(total),
      projectedUsd: fractionElapsed > 0 ? r6(total / fractionElapsed) : null,
      fractionElapsed: Math.round(fractionElapsed * 10_000) / 10_000,
      providers: rows.map((r) => ({ provider: r.provider, usd: r6(r.usd) })).sort((a, b) => b.usd - a.usd),
    };
  });

  // Daily budget state: confirmed value, suggestion, and env fallback.
  // GET is monitor-readable; PUT (confirm) is ROOT ADMIN ONLY — monitors are
  // read-only by definition.
  app.get('/admin/metrics/budget', async (req, reply) => {
    const actor = requireMonitor(req, reply); if (!actor) return;
    const db = getDb();
    const get = (k: string) => (db.prepare('SELECT value FROM monitor_meta WHERE key = ?').get(k) as any)?.value;
    const confirmed = Number(get('daily_budget_usd')) || 0;
    const suggested = Number(get('daily_budget_suggested')) || 0;
    return {
      confirmedUsd: confirmed || null,
      suggestedUsd: suggested || null,
      envUsd: config.monitorDailyBudgetUsd || null,
      active: confirmed || config.monitorDailyBudgetUsd || null,
    };
  });

  app.put('/admin/metrics/budget', async (req, reply) => {
    // Mutating — root admin only, NOT requireMonitor.
    const actor = requireDashboardAdmin(req, reply); if (!actor) return;
    const body = z.object({ dailyBudgetUsd: z.number().positive().max(1_000_000) }).parse(req.body || {});
    getDb().prepare(`
      INSERT INTO monitor_meta (key, value, updated_at) VALUES ('daily_budget_usd', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `).run(String(body.dailyBudgetUsd));
    audit({ actorUserId: actor.id, action: 'set_daily_budget', targetType: 'monitor_meta', targetId: 'daily_budget_usd', after: { dailyBudgetUsd: body.dailyBudgetUsd } });
    return { ok: true, dailyBudgetUsd: body.dailyBudgetUsd };
  });

  // Fire a test alert through the REAL delivery path (webhook, pings,
  // fallback) so operators can verify DISCORD_MONITOR_WEBHOOK /
  // MONITOR_PING_DISCORD_IDS at deploy time. Root admin only (it pings
  // people); bypasses cooldowns intentionally.
  app.post('/admin/metrics/alert-test', async (req, reply) => {
    const actor = requireDashboardAdmin(req, reply); if (!actor) return;
    const body = z.object({ severity: z.enum(['warn', 'critical']).default('warn') }).parse(req.body || {});
    const { sendMonitorAlert } = await import('./alert-send.js');
    await sendMonitorAlert({
      rule: 'test', scope: 'manual', severity: body.severity, cooldownMs: 0,
      title: 'Test alert',
      message: `Manual ${body.severity} test fired from the console by ${actor.email}. If you can read this, delivery works.`,
      metadata: { firedBy: actor.email, webhookConfigured: !!config.monitorWebhookUrl },
    });
    audit({ actorUserId: actor.id, action: 'alert_test_fired', targetType: 'monitor', targetId: body.severity });
    return { ok: true, severity: body.severity, webhookConfigured: !!config.monitorWebhookUrl };
  });
}
