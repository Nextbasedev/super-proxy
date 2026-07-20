// Monitoring rollups & retention (Phase 2 of docs/MONITORING-SYSTEM.md).
//
// Every ROLLUP_INTERVAL_MS we fully recompute the current + previous hourly
// buckets from raw usage_events (idempotent full-recompute upsert — no
// incremental drift), then recompute today's + yesterday's daily buckets from
// the hourly table. Exact latency/TTFT percentiles are computed from raw rows
// at rollup time and STORED — they cannot be reconstructed after raw pruning.
//
// Retention (opt-in via MONITOR_RETENTION_ENABLED):
//   - raw usage_events older than monitorRetentionRawDays are deleted in
//     batches, but never past the rollup high-water mark
//   - hourly rollups older than monitorRetentionHourlyDays are deleted
//   - daily rollups are kept forever
//   - request_logs past their own expires_at are pruned (existing contract)
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { getRates } from '../proxy/cost.js';
import { promptTokensForCacheability } from './cache-accounting.js';

export const ROLLUP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Minimum prompt size (input + cache_read tokens) for a request to be
 * considered "cacheable". Providers only cache prompts at/above a floor
 * (Anthropic/OpenAI/Kimi all use ~1024 tokens), so a per-request hit rate that
 * includes tiny uncacheable prompts in the denominator would understate real
 * cache health. We count a request as cacheable when input+cache_read >= this.
 */
export const CACHEABLE_MIN_TOKENS = 1024;

// Time helpers live in time-utils.ts (pure, dependency-free) so alert-rules/
// digest can import them without a static cycle through this module.
export { hourBucket, dayBucket, hourBounds } from './time-utils.js';
import { hourBucket, dayBucket, hourBounds } from './time-utils.js';

// ─── percentiles ────────────────────────────────────────────────────────────

/** Exact nearest-rank percentile of a pre-sorted ascending array. */
export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

// ─── cache savings ──────────────────────────────────────────────────────────

/**
 * $ saved by caching for a provider/model group:
 *   saved = cache_read × (input_price − cache_read_price)
 *         − cache_creation × (cache_write_price − input_price)
 * (reads are cheaper than uncached input; writes cost a premium over input).
 * Returns 0 when no per-token pricing exists (never negative-infinity garbage;
 * may be negative when writes outweigh reads — that is real signal).
 */
// Notional dollars saved by caching, per provider cache-accounting semantics.
//
// The DISCOUNT on cache reads is identical for both styles: each cached-read
// token would otherwise have cost `input`, but costs `cacheRead` — so the read
// saving is cacheReadTokens * (input - cacheRead). What differs is the WRITE
// term:
//  - SEPARATE (anthropic, glm): writing to cache costs a premium over input
//    (Anthropic cacheWrite ≈ 1.25x input), so subtract
//    cacheCreationTokens * (cacheWrite - input). GLM reports no writes → term 0.
//  - SUBSET (openai_codex, xai, kimi): no separate cache-write billing that we
//    model. Codex 5.6 introduces cache_write @1.25x; if/when we record
//    cacheCreationTokens for it, the same subtraction applies via cacheWrite.
// A missing cacheRead rate falls back to `input` (→ zero read saving, correct).
export function cacheSavedUsd(provider: string, model: string, cacheReadTokens: number, cacheCreationTokens: number): number {
  const rates = getRates(provider, model);
  if (!rates) return 0;
  const readPrice = rates.cacheRead ?? rates.input;
  const readSaving = cacheReadTokens * (rates.input - readPrice);
  // Write premium only when the provider actually bills cache writes above input.
  const writePrice = rates.cacheWrite ?? rates.input;
  const writePremium = cacheCreationTokens * Math.max(0, writePrice - rates.input);
  const saved = readSaving - writePremium;
  return Math.round(saved * 1_000_000) / 1_000_000;
}

// ─── hourly rollup ──────────────────────────────────────────────────────────

interface GroupAgg {
  provider: string;
  model: string;
  userId: number;
  billingMode: string;
  requests: number;
  errors4xx: number;
  errors429: number;
  errors5xx: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  tokensSavedCompression: number;
  costUsd: number;
  latencySum: number;
  latencies: number[];
  ttfts: number[];
  retryCount: number;
  cacheableRequests: number;
  cacheHitRequests: number;
}

/**
 * Fully recompute one hourly bucket from raw usage_events (delete + reinsert:
 * idempotent, self-healing if raw rows arrived late or a previous run died).
 */
export function rollupHour(bucket: string): number {
  const db = getDb();
  const { start, end } = hourBounds(bucket);
  const rows = db.prepare(`
    SELECT provider, COALESCE(model, '') AS model, COALESCE(user_id, 0) AS user_id,
           COALESCE(billing_mode, 'metered') AS billing_mode,
           status_code, input_tokens, output_tokens, reasoning_tokens,
           cache_creation_tokens, cache_read_tokens, tokens_saved_compression,
           estimated_cost_usd, latency_ms, ttft_ms, retry_count, unit
    FROM usage_events
    WHERE created_at >= ? AND created_at < ?
  `).all(start, end) as any[];

  // Guard: never wipe an existing rollup when raw rows are gone (e.g. pruned
  // by retention, or a non-contiguous manual re-roll). Full-recompute would
  // delete the only remaining aggregate and reinsert nothing. An old bucket
  // that is genuinely empty has no rollup rows either, so this is always safe.
  if (rows.length === 0) {
    const existing = (db.prepare('SELECT COUNT(*) c FROM usage_rollup_hourly WHERE bucket = ?').get(bucket) as any)?.c ?? 0;
    if (existing > 0) return 0;
  }

  const groups = new Map<string, GroupAgg>();
  for (const r of rows) {
    const key = `${r.provider}\u0000${r.model}\u0000${r.user_id}\u0000${r.billing_mode}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        provider: r.provider, model: r.model, userId: r.user_id, billingMode: r.billing_mode,
        requests: 0, errors4xx: 0, errors429: 0, errors5xx: 0,
        inputTokens: 0, outputTokens: 0, reasoningTokens: 0,
        cacheCreationTokens: 0, cacheReadTokens: 0, tokensSavedCompression: 0,
        costUsd: 0, latencySum: 0, latencies: [], ttfts: [], retryCount: 0,
        cacheableRequests: 0, cacheHitRequests: 0,
      };
      groups.set(key, g);
    }
    g.requests += 1;
    const sc = Number(r.status_code) || 0;
    if (sc === 429) g.errors429 += 1;
    else if (sc >= 400 && sc < 500) g.errors4xx += 1;
    else if (sc >= 500) g.errors5xx += 1;
    // Non-token units (seconds/chars/images/videos) must NOT pollute token sums.
    const isTokens = r.unit == null || r.unit === 'tokens';
    if (isTokens) {
      g.inputTokens += Number(r.input_tokens) || 0;
      g.outputTokens += Number(r.output_tokens) || 0;
      g.reasoningTokens += Number(r.reasoning_tokens) || 0;
      g.cacheCreationTokens += Number(r.cache_creation_tokens) || 0;
      g.cacheReadTokens += Number(r.cache_read_tokens) || 0;
      g.tokensSavedCompression += Number(r.tokens_saved_compression) || 0;
      // Per-request cache accounting: a request is "cacheable" when its prompt
      // (uncached input + cache reads) meets the provider caching floor; it's a
      // "hit" when it also read >0 cached tokens. Only count successful requests
      // (2xx/3xx) — errors carry estimated input and never touch the cache.
      const cacheRead = Number(r.cache_read_tokens) || 0;
      const promptTokens = promptTokensForCacheability(g.provider, Number(r.input_tokens) || 0, cacheRead);
      if (sc < 400 && promptTokens >= CACHEABLE_MIN_TOKENS) {
        g.cacheableRequests += 1;
        if (cacheRead > 0) g.cacheHitRequests += 1;
      }
    }
    g.costUsd += Number(r.estimated_cost_usd) || 0;
    if (r.latency_ms != null) { g.latencySum += Number(r.latency_ms) || 0; g.latencies.push(Number(r.latency_ms)); }
    if (r.ttft_ms != null) g.ttfts.push(Number(r.ttft_ms));
    g.retryCount += Number(r.retry_count) || 0;
  }

  const insert = db.prepare(`
    INSERT INTO usage_rollup_hourly (
      bucket, provider, model, user_id, billing_mode,
      requests, errors_4xx, errors_429, errors_5xx,
      input_tokens, output_tokens, reasoning_tokens,
      cache_creation_tokens, cache_read_tokens, tokens_saved_compression,
      cost_usd, cache_saved_usd, latency_ms_sum,
      latency_ms_p50, latency_ms_p95, ttft_ms_p50, ttft_ms_p95, retry_count,
      cacheable_requests, cache_hit_requests
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const run = db.transaction(() => {
    db.prepare('DELETE FROM usage_rollup_hourly WHERE bucket = ?').run(bucket);
    for (const g of groups.values()) {
      g.latencies.sort((a, b) => a - b);
      g.ttfts.sort((a, b) => a - b);
      insert.run(
        bucket, g.provider, g.model, g.userId, g.billingMode,
        g.requests, g.errors4xx, g.errors429, g.errors5xx,
        g.inputTokens, g.outputTokens, g.reasoningTokens,
        g.cacheCreationTokens, g.cacheReadTokens, g.tokensSavedCompression,
        Math.round(g.costUsd * 1_000_000) / 1_000_000,
        cacheSavedUsd(g.provider, g.model, g.cacheReadTokens, g.cacheCreationTokens),
        g.latencySum,
        percentile(g.latencies, 50), percentile(g.latencies, 95),
        percentile(g.ttfts, 50), percentile(g.ttfts, 95),
        g.retryCount,
        g.cacheableRequests, g.cacheHitRequests,
      );
    }
    // Contiguous high-water: the newest hour H such that every hour <= H has
    // been rolled. Advance only to the same hour (re-roll) or the immediate
    // next hour — never leapfrog a gap via MAX(), which would strand un-rolled
    // hours and (with retention) allow their raw rows to be pruned forever.
    const prevHw = (db.prepare(`SELECT value FROM monitor_meta WHERE key = 'rollup_high_water'`).get() as any)?.value as string | undefined;
    const nextAfterHw = prevHw
      ? hourBucket(new Date(new Date(`${prevHw}:00:00.000Z`).getTime() + 3600_000))
      : null;
    const canAdvance = !prevHw || bucket === prevHw || bucket === nextAfterHw;
    if (canAdvance) {
      db.prepare(`
        INSERT INTO monitor_meta (key, value, updated_at) VALUES ('rollup_high_water', ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
      `).run(bucket);
    }
  });
  run();
  return groups.size;
}

// ─── daily rollup (from hourly) ─────────────────────────────────────────────

/**
 * Recompute one daily bucket from its 24 hourly buckets. Percentiles are
 * request-weighted merges of hourly percentiles (exact daily percentiles
 * would need raw rows, which may already be pruned; weighted-median of
 * hourly p50/p95 is a stable, honest approximation at our volume).
 */
export function rollupDay(bucket: string): number {
  const db = getDb();
  // Guard: daily rollups are kept forever, but they are recomputed FROM hourly
  // rollups — which are pruned after monitorRetentionHourlyDays. Recomputing a
  // day whose hourly rows are gone would wipe the permanent daily aggregate.
  // Normal passes only touch today/yesterday; this protects manual/API calls.
  const rows = db.prepare(`
    SELECT provider, model, user_id, billing_mode,
           SUM(requests) requests, SUM(errors_4xx) errors_4xx, SUM(errors_429) errors_429, SUM(errors_5xx) errors_5xx,
           SUM(input_tokens) input_tokens, SUM(output_tokens) output_tokens, SUM(reasoning_tokens) reasoning_tokens,
           SUM(cache_creation_tokens) cache_creation_tokens, SUM(cache_read_tokens) cache_read_tokens,
           SUM(tokens_saved_compression) tokens_saved_compression,
           SUM(cost_usd) cost_usd, SUM(cache_saved_usd) cache_saved_usd, SUM(latency_ms_sum) latency_ms_sum,
           SUM(retry_count) retry_count,
           SUM(cacheable_requests) cacheable_requests, SUM(cache_hit_requests) cache_hit_requests
    FROM usage_rollup_hourly
    WHERE bucket >= ? AND bucket < ?
    GROUP BY provider, model, user_id, billing_mode
  `).all(`${bucket}T00`, `${bucket}T24`) as any[];
  if (rows.length === 0) {
    const existing = db.prepare('SELECT COUNT(*) c FROM usage_rollup_daily WHERE bucket = ?').get(bucket) as any;
    if (existing.c > 0) return 0; // hourly source gone; keep the daily aggregate
  }

  // Request-weighted percentile merge per group.
  const pctRows = db.prepare(`
    SELECT provider, model, user_id, billing_mode, requests,
           latency_ms_p50, latency_ms_p95, ttft_ms_p50, ttft_ms_p95
    FROM usage_rollup_hourly
    WHERE bucket >= ? AND bucket < ?
  `).all(`${bucket}T00`, `${bucket}T24`) as any[];
  const pctByGroup = new Map<string, { l50: Array<[number, number]>; l95: Array<[number, number]>; t50: Array<[number, number]>; t95: Array<[number, number]> }>();
  for (const r of pctRows) {
    const key = `${r.provider}\u0000${r.model}\u0000${r.user_id}\u0000${r.billing_mode}`;
    let e = pctByGroup.get(key);
    if (!e) { e = { l50: [], l95: [], t50: [], t95: [] }; pctByGroup.set(key, e); }
    const w = Number(r.requests) || 0;
    if (r.latency_ms_p50 != null) e.l50.push([Number(r.latency_ms_p50), w]);
    if (r.latency_ms_p95 != null) e.l95.push([Number(r.latency_ms_p95), w]);
    if (r.ttft_ms_p50 != null) e.t50.push([Number(r.ttft_ms_p50), w]);
    if (r.ttft_ms_p95 != null) e.t95.push([Number(r.ttft_ms_p95), w]);
  }
  const weightedMedian = (pairs: Array<[number, number]>): number | null => {
    if (!pairs.length) return null;
    pairs.sort((a, b) => a[0] - b[0]);
    const total = pairs.reduce((s, [, w]) => s + w, 0);
    let acc = 0;
    for (const [v, w] of pairs) { acc += w; if (acc >= total / 2) return v; }
    return pairs[pairs.length - 1][0];
  };

  const insert = db.prepare(`
    INSERT INTO usage_rollup_daily (
      bucket, provider, model, user_id, billing_mode,
      requests, errors_4xx, errors_429, errors_5xx,
      input_tokens, output_tokens, reasoning_tokens,
      cache_creation_tokens, cache_read_tokens, tokens_saved_compression,
      cost_usd, cache_saved_usd, latency_ms_sum,
      latency_ms_p50, latency_ms_p95, ttft_ms_p50, ttft_ms_p95, retry_count,
      cacheable_requests, cache_hit_requests
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const run = db.transaction(() => {
    db.prepare('DELETE FROM usage_rollup_daily WHERE bucket = ?').run(bucket);
    for (const r of rows) {
      const key = `${r.provider}\u0000${r.model}\u0000${r.user_id}\u0000${r.billing_mode}`;
      const p = pctByGroup.get(key);
      insert.run(
        bucket, r.provider, r.model, r.user_id, r.billing_mode,
        r.requests, r.errors_4xx, r.errors_429, r.errors_5xx,
        r.input_tokens, r.output_tokens, r.reasoning_tokens,
        r.cache_creation_tokens, r.cache_read_tokens, r.tokens_saved_compression,
        Math.round(Number(r.cost_usd) * 1_000_000) / 1_000_000,
        Math.round(Number(r.cache_saved_usd) * 1_000_000) / 1_000_000,
        r.latency_ms_sum,
        p ? weightedMedian(p.l50) : null, p ? weightedMedian(p.l95) : null,
        p ? weightedMedian(p.t50) : null, p ? weightedMedian(p.t95) : null,
        r.retry_count,
        Number(r.cacheable_requests) || 0, Number(r.cache_hit_requests) || 0,
      );
    }
  });
  run();
  return rows.length;
}

// ─── retention ──────────────────────────────────────────────────────────────

const PRUNE_BATCH = 5000;
// Max rows deleted per table per pass. Bounds a single pass's write work while
// letting first-time retention enablement (30 days of backlog) catch up in
// hours instead of days (1 batch/pass = ~1.44M/day ceiling was too slow).
const PRUNE_MAX_PER_PASS = 50_000;

export function pruneRetention(now = new Date()): { rawDeleted: number; hourlyDeleted: number; requestLogsDeleted: number } {
  const db = getDb();
  let rawDeleted = 0;
  let hourlyDeleted = 0;
  let requestLogsDeleted = 0;

  // Sole background owner of request_logs expiry GC (no other DELETE-by-expires_at
  // loop exists). Rows carry expires_at from requestLogRetentionDays at insert
  // time (policy.logRequestResponse). This is independent of the opt-in
  // monitoring retention switch — request body logs are a privacy/disk contract,
  // not a monitoring rollup concern — so always enforce here.
  const rlStmt = db.prepare(`DELETE FROM request_logs WHERE id IN (SELECT id FROM request_logs WHERE expires_at < ? LIMIT ?)`);
  while (requestLogsDeleted < PRUNE_MAX_PER_PASS) {
    const n = rlStmt.run(now.toISOString(), PRUNE_BATCH).changes;
    requestLogsDeleted += n;
    if (n < PRUNE_BATCH) break;
  }

  // Historical aside_usage_log (inert OSS tables). Prune only if the table exists.
  const asideTable = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='aside_usage_log'").get() as { ok: number } | undefined;
  if (asideTable) {
    const asideStmt = db.prepare(`DELETE FROM aside_usage_log WHERE id IN (SELECT id FROM aside_usage_log WHERE expires_at < ? LIMIT ?)`);
    let asideDeleted = 0;
    while (asideDeleted < PRUNE_MAX_PER_PASS) {
      const n = asideStmt.run(now.toISOString(), PRUNE_BATCH).changes;
      asideDeleted += n;
      if (n < PRUNE_BATCH) break;
    }
  }

  if (!config.monitorRetentionEnabled) return { rawDeleted, hourlyDeleted, requestLogsDeleted };

  // Raw usage_events: prune only data that is (a) past retention AND
  // (b) fully covered by the rollup high-water mark.
  const highWater = (db.prepare(`SELECT value FROM monitor_meta WHERE key = 'rollup_high_water'`).get() as any)?.value as string | undefined;
  if (highWater) {
    const retentionCutoff = new Date(now.getTime() - config.monitorRetentionRawDays * 24 * 3600_000);
    // High-water bucket start marks "everything before this hour is rolled up".
    const highWaterStart = hourBounds(highWater).start;
    const retentionStr = retentionCutoff.toISOString().slice(0, 19).replace('T', ' ');
    const cutoff = retentionStr < highWaterStart ? retentionStr : highWaterStart;
    const rawStmt = db.prepare(`
      DELETE FROM usage_events WHERE id IN (
        SELECT id FROM usage_events WHERE created_at < ? LIMIT ?
      )
    `);
    while (rawDeleted < PRUNE_MAX_PER_PASS) {
      const n = rawStmt.run(cutoff, PRUNE_BATCH).changes;
      rawDeleted += n;
      if (n < PRUNE_BATCH) break;
    }
  }

  // Hourly rollups past retention (daily kept forever).
  const hourlyCutoff = hourBucket(new Date(now.getTime() - config.monitorRetentionHourlyDays * 24 * 3600_000));
  const hr = db.prepare('DELETE FROM usage_rollup_hourly WHERE bucket < ?').run(hourlyCutoff);
  hourlyDeleted = hr.changes;

  return { rawDeleted, hourlyDeleted, requestLogsDeleted };
}

// ─── orchestration ──────────────────────────────────────────────────────────

let running = false;
let lastError: string | null = null;

export function getRollupStatus(): { running: boolean; lastError: string | null } {
  return { running, lastError };
}

// Bound hours processed per pass so a multi-week backlog cannot monopolize the
// event loop. Catch-up is oldest-first and contiguous: a longer outage simply
// takes multiple passes. High-water never leaps past un-rolled hours, so
// retention (cutoff = min(retention, highWater)) cannot delete raw rows that
// have not yet been aggregated.
export const MAX_CATCHUP_HOURS = 48;

/**
 * One full rollup pass. Rolls hours oldest-first from the high-water mark
 * (inclusive — it may have been rolled while still partial) toward now, so
 * gap hours after a crash/downtime are back-filled instead of silently
 * skipped. Work per pass is capped at MAX_CATCHUP_HOURS; the next pass
 * continues from the new contiguous high-water. Then recomputes the daily
 * buckets of every touched day (+ today and yesterday), then retention.
 */
export function runRollupPass(now = new Date()): void {
  const db = getDb();
  // Steady-state always re-covers previous + current hour for late arrivals.
  // When high-water lags further back, start there and walk forward (oldest
  // first) so the watermark stays a true contiguous prefix of rolled hours.
  const prevBucket = hourBucket(new Date(now.getTime() - 3600_000));
  const hw = (db.prepare(`SELECT value FROM monitor_meta WHERE key = 'rollup_high_water'`).get() as any)?.value as string | undefined;
  let startBucket = prevBucket;
  if (hw && hw < prevBucket) startBucket = hw;

  const startMs = new Date(`${startBucket}:00:00.000Z`).getTime();
  // Inclusive cap: at most MAX_CATCHUP_HOURS hours, never past `now`.
  const cappedEndMs = startMs + (MAX_CATCHUP_HOURS - 1) * 3600_000;
  const endMs = Math.min(now.getTime(), cappedEndMs);

  const days = new Set<string>();
  for (let t = startMs; t <= endMs; t += 3600_000) {
    const d = new Date(t);
    rollupHour(hourBucket(d));
    days.add(dayBucket(d));
  }
  days.add(dayBucket(new Date(now.getTime() - 24 * 3600_000)));
  days.add(dayBucket(now));
  for (const d of days) rollupDay(d);
  pruneRetention(now);
}

export function startRollupLoop(log?: { info?: (o: any, m?: string) => void; warn?: (o: any, m?: string) => void }): NodeJS.Timeout {
  const tick = () => {
    if (running) { log?.warn?.({}, 'monitoring rollup: previous pass still running, skipping'); return; }
    running = true;
    try {
      runRollupPass();
      lastError = null;
    } catch (e: any) {
      lastError = String(e?.message || e);
      log?.warn?.({ err: lastError }, 'monitoring rollup pass failed');
    } finally {
      running = false;
    }
    // Phase 4: alerting + digest + budget suggestion run AFTER the rollup pass
    // (they read the tables it just wrote). Async fire-and-forget — failures
    // must never affect the rollup loop. Dynamic import ONLY for alert-rules/
    // digest (heavier modules, first-tick lazy load); time-utils are static.
    void (async () => {
      try {
        const { evaluateAlertRules } = await import('./alert-rules.js');
        const { postDigestIfDue, updateBudgetSuggestion } = await import('./digest.js');
        await evaluateAlertRules();
        await postDigestIfDue();
        updateBudgetSuggestion();
      } catch (e: any) {
        log?.warn?.({ err: String(e?.message || e) }, 'monitoring alert/digest pass failed');
      }
    })();
  };
  // First pass shortly after boot (give migrations/server settle time).
  const timer = setInterval(tick, ROLLUP_INTERVAL_MS);
  timer.unref?.();
  setTimeout(tick, 15_000).unref?.();
  return timer;
}
