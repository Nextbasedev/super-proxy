import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

const dbPath = path.join(os.tmpdir(), `super-proxy-rollup-${process.pid}-${Date.now()}.sqlite`);
process.env.DATABASE_PATH = dbPath;
process.env.DEV_ADMIN_KEY = 'test-admin';
process.env.MONITOR_RETENTION_ENABLED = 'true';
process.env.MONITOR_RETENTION_RAW_DAYS = '30';
process.env.MONITOR_RETENTION_HOURLY_DAYS = '180';

const { migrate } = await import('./db/migrate.js');
const { getDb } = await import('./db/index.js');
const {
  hourBucket, dayBucket, hourBounds, percentile, cacheSavedUsd,
  rollupHour, rollupDay, pruneRetention, runRollupPass, MAX_CATCHUP_HOURS,
} = await import('./monitoring/rollup.js');
const {
  config,
  resolveMonitorRetentionRawDays, resolveMonitorRetentionHourlyDays,
  MIN_MONITOR_RETENTION_RAW_DAYS,
} = await import('./config.js');

migrate();
const db = getDb();

const u = db.prepare(`INSERT INTO users (email, name, role) VALUES ('rollup@test.dev','R','member')`).run();
const USER = Number(u.lastInsertRowid);
const t = db.prepare(`INSERT INTO api_tokens (user_id, label, token_hash, token_prefix) VALUES (?,?,?,?)`).run(USER, 'r', 'h', 'p');
const TOKEN = Number(t.lastInsertRowid);

function insertEvent(opts: {
  createdAt: string; provider?: string; model?: string; status?: number;
  input?: number; output?: number; reasoning?: number; cacheRead?: number; cacheWrite?: number;
  cost?: number; latency?: number; ttft?: number; retries?: number; unit?: string; billing?: string;
  compressionSaved?: number; userId?: number;
}): number {
  const r = db.prepare(`
    INSERT INTO usage_events (user_id, token_id, provider, endpoint, model, status_code,
      input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_creation_tokens,
      estimated_cost_usd, latency_ms, ttft_ms, retry_count, unit, billing_mode,
      tokens_saved_compression, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    opts.userId ?? USER, TOKEN, opts.provider ?? 'anthropic', '/v1/messages', opts.model ?? 'claude-sonnet-4-6',
    opts.status ?? 200, opts.input ?? 0, opts.output ?? 0, opts.reasoning ?? null,
    opts.cacheRead ?? 0, opts.cacheWrite ?? 0, opts.cost ?? 0, opts.latency ?? null,
    opts.ttft ?? null, opts.retries ?? null, opts.unit ?? null, opts.billing ?? 'flat_fee',
    opts.compressionSaved ?? null, opts.createdAt,
  );
  return Number(r.lastInsertRowid);
}

const H = '2026-07-01T10'; // fixed test hour bucket
const AT = (min: number) => `2026-07-01 10:${String(min).padStart(2, '0')}:00`;

// ─── helpers ────────────────────────────────────────────────────────────────

test('hour/day bucket + bounds math', () => {
  const d = new Date('2026-07-01T10:42:13.000Z');
  assert.equal(hourBucket(d), '2026-07-01T10');
  assert.equal(dayBucket(d), '2026-07-01');
  assert.deepEqual(hourBounds('2026-07-01T10'), { start: '2026-07-01 10:00:00', end: '2026-07-01 11:00:00' });
});

test('percentile: exact nearest-rank on odd/even/single/empty', () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([7], 50), 7);
  assert.equal(percentile([7], 95), 7);
  assert.equal(percentile([1, 2, 3, 4, 5], 50), 3);
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  assert.equal(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200], 95), 190);
});

test('cacheSavedUsd: anthropic write+read pricing shape', () => {
  // claude-sonnet: input 3/M, cacheRead 0.3/M, cacheWrite 3.75/M
  // 1M reads save (3−0.3)=2.7; 1M writes cost premium (3.75−3)=0.75 → net 1.95
  assert.equal(cacheSavedUsd('anthropic', 'claude-sonnet-4-6', 1_000_000, 1_000_000), 1.95);
  // reads only
  assert.equal(cacheSavedUsd('anthropic', 'claude-sonnet-4-6', 1_000_000, 0), 2.7);
  // writes only → negative (real signal: paying cache premium, reading nothing)
  assert.equal(cacheSavedUsd('anthropic', 'claude-sonnet-4-6', 0, 1_000_000), -0.75);
});

test('cacheSavedUsd: read-only pricing (kimi) and unpriced providers', () => {
  // kimi-k2.6: input 0.95/M, cacheRead 0.16/M, no cacheWrite → write price = input → no write premium
  assert.equal(cacheSavedUsd('kimi', 'kimi-k2.6', 1_000_000, 500_000), Math.round((0.95 - 0.16) * 1_000_000) / 1_000_000);
  // no pricing → 0, never NaN
  assert.equal(cacheSavedUsd('groq', 'whatever', 1_000_000, 0), 0);
  assert.equal(cacheSavedUsd('fusion', 'max', 1_000_000, 0), 0);
});

// ─── hourly rollup ──────────────────────────────────────────────────────────

test('rollupHour aggregates one group correctly (tokens, errors, cost, percentiles, retries)', () => {
  db.prepare('DELETE FROM usage_events').run();
  insertEvent({ createdAt: AT(1), input: 100, output: 50, reasoning: 10, cacheRead: 200, cacheWrite: 20, cost: 0.01, latency: 100, ttft: 50, compressionSaved: 5 });
  insertEvent({ createdAt: AT(2), input: 300, output: 150, reasoning: 30, cacheRead: 400, cacheWrite: 40, cost: 0.03, latency: 200, ttft: 80, retries: 2 });
  insertEvent({ createdAt: AT(3), status: 429, latency: 50 });
  insertEvent({ createdAt: AT(4), status: 500, latency: 60 });
  insertEvent({ createdAt: AT(5), status: 400, latency: 70 });
  const groups = rollupHour(H);
  assert.equal(groups, 1);
  const row = db.prepare('SELECT * FROM usage_rollup_hourly WHERE bucket = ?').get(H) as any;
  assert.equal(row.requests, 5);
  assert.equal(row.errors_429, 1);
  assert.equal(row.errors_5xx, 1);
  assert.equal(row.errors_4xx, 1);
  assert.equal(row.input_tokens, 400);
  assert.equal(row.output_tokens, 200);
  assert.equal(row.reasoning_tokens, 40);
  assert.equal(row.cache_read_tokens, 600);
  assert.equal(row.cache_creation_tokens, 60);
  assert.equal(row.tokens_saved_compression, 5);
  assert.equal(row.cost_usd, 0.04);
  assert.equal(row.retry_count, 2);
  assert.equal(row.latency_ms_sum, 100 + 200 + 50 + 60 + 70);
  assert.equal(row.latency_ms_p50, 70); // sorted: 50,60,70,100,200 → rank 3
  assert.equal(row.latency_ms_p95, 200);
  assert.equal(row.ttft_ms_p50, 50); // sorted: 50,80
  assert.equal(row.ttft_ms_p95, 80);
  // cache_saved_usd uses sonnet rates on 600/60 tokens
  const expectedSaved = cacheSavedUsd('anthropic', 'claude-sonnet-4-6', 600, 60);
  assert.equal(row.cache_saved_usd, expectedSaved);
});

test('rollupHour is idempotent — re-run produces identical rows, no duplicates', () => {
  rollupHour(H);
  rollupHour(H);
  const rows = db.prepare('SELECT COUNT(*) c FROM usage_rollup_hourly WHERE bucket = ?').get(H) as any;
  assert.equal(rows.c, 1);
});

test('rollupHour cacheable request floor is provider-aware for subset vs separate cache accounting', () => {
  db.prepare('DELETE FROM usage_events').run();
  db.prepare('DELETE FROM usage_rollup_hourly').run();
  // Kimi is SUBSET accounting: cache_read is already inside input_tokens, so
  // input=1000 remains below the 1024 cacheable floor even with 900 cached.
  insertEvent({ createdAt: AT(6), provider: 'kimi', model: 'kimi-k2.6', billing: 'metered', input: 1000, cacheRead: 900, output: 1 });
  // Anthropic is SEPARATE accounting: prompt=input+cache_read=1900, cacheable.
  insertEvent({ createdAt: AT(7), provider: 'anthropic', model: 'claude-sonnet-4-6', billing: 'flat_fee', input: 1000, cacheRead: 900, output: 1 });
  rollupHour(H);
  const kimi = db.prepare(`SELECT cacheable_requests, cache_hit_requests FROM usage_rollup_hourly WHERE bucket=? AND provider='kimi'`).get(H) as any;
  const anth = db.prepare(`SELECT cacheable_requests, cache_hit_requests FROM usage_rollup_hourly WHERE bucket=? AND provider='anthropic'`).get(H) as any;
  assert.equal(kimi.cacheable_requests, 0);
  assert.equal(kimi.cache_hit_requests, 0);
  assert.equal(anth.cacheable_requests, 1);
  assert.equal(anth.cache_hit_requests, 1);
});

test('rollupHour splits groups by provider/model/user/billing and excludes non-token units from token sums', () => {
  db.prepare('DELETE FROM usage_events').run();
  db.prepare('DELETE FROM usage_rollup_hourly').run();
  insertEvent({ createdAt: AT(10), provider: 'gemini', model: 'gemini-2.5-flash', billing: 'metered', input: 111, cost: 0.001 });
  insertEvent({ createdAt: AT(11), provider: 'deepgram', model: 'nova-3', billing: 'metered', input: 3600, unit: 'seconds', cost: 0 });
  insertEvent({ createdAt: AT(12), provider: 'fish', model: 's2.1-pro-free', billing: 'free_tier', input: 15000, unit: 'chars' });
  const groups = rollupHour(H);
  assert.equal(groups, 3);
  const dg = db.prepare(`SELECT * FROM usage_rollup_hourly WHERE bucket=? AND provider='deepgram'`).get(H) as any;
  assert.equal(dg.requests, 1);
  assert.equal(dg.input_tokens, 0); // seconds NOT counted as tokens
  const fish = db.prepare(`SELECT * FROM usage_rollup_hourly WHERE bucket=? AND provider='fish'`).get(H) as any;
  assert.equal(fish.input_tokens, 0); // chars NOT counted as tokens
  const gem = db.prepare(`SELECT * FROM usage_rollup_hourly WHERE bucket=? AND provider='gemini'`).get(H) as any;
  assert.equal(gem.input_tokens, 111);
});

test('rollupHour advances high-water mark contiguously (no leapfrog, no regress)', () => {
  // Contiguous re-roll of the same hour is fine.
  rollupHour(H);
  const hwSame = (db.prepare(`SELECT value FROM monitor_meta WHERE key='rollup_high_water'`).get() as any).value;
  assert.equal(hwSame, H);
  // Older non-adjacent hour must not regress the watermark.
  rollupHour('2026-07-01T09');
  const hw1 = (db.prepare(`SELECT value FROM monitor_meta WHERE key='rollup_high_water'`).get() as any).value;
  assert.equal(hw1, H); // did not regress to T09
  // Future leap past the next hour must not jump the watermark.
  rollupHour('2026-07-01T12');
  const hw2 = (db.prepare(`SELECT value FROM monitor_meta WHERE key='rollup_high_water'`).get() as any).value;
  assert.equal(hw2, H); // did not leapfrog to T12
  // Immediate next hour advances contiguously.
  rollupHour('2026-07-01T11');
  const hw3 = (db.prepare(`SELECT value FROM monitor_meta WHERE key='rollup_high_water'`).get() as any).value;
  assert.equal(hw3, '2026-07-01T11');
});

// ─── daily rollup ───────────────────────────────────────────────────────────

test('rollupDay sums hourly buckets and weight-merges percentiles', () => {
  db.prepare('DELETE FROM usage_events').run();
  db.prepare('DELETE FROM usage_rollup_hourly').run();
  db.prepare('DELETE FROM usage_rollup_daily').run();
  // Hour A: 3 requests latency p50=100; hour B: 1 request p50=500
  insertEvent({ createdAt: '2026-07-01 08:01:00', input: 10, latency: 100, ttft: 40 });
  insertEvent({ createdAt: '2026-07-01 08:02:00', input: 10, latency: 100, ttft: 40 });
  insertEvent({ createdAt: '2026-07-01 08:03:00', input: 10, latency: 100, ttft: 40 });
  insertEvent({ createdAt: '2026-07-01 09:01:00', input: 20, latency: 500, ttft: 200 });
  rollupHour('2026-07-01T08');
  rollupHour('2026-07-01T09');
  const n = rollupDay('2026-07-01');
  assert.equal(n, 1);
  const d = db.prepare(`SELECT * FROM usage_rollup_daily WHERE bucket='2026-07-01'`).get() as any;
  assert.equal(d.requests, 4);
  assert.equal(d.input_tokens, 50);
  assert.equal(d.latency_ms_sum, 800);
  // weighted median of [100(w3), 500(w1)] → 100
  assert.equal(d.latency_ms_p50, 100);
  assert.equal(d.ttft_ms_p50, 40);
});

test('rollupDay is idempotent', () => {
  rollupDay('2026-07-01');
  rollupDay('2026-07-01');
  const c = (db.prepare(`SELECT COUNT(*) c FROM usage_rollup_daily WHERE bucket='2026-07-01'`).get() as any).c;
  assert.equal(c, 1);
});

// ─── retention ──────────────────────────────────────────────────────────────

test('pruneRetention deletes only raw rows past retention AND behind the high-water mark', () => {
  db.prepare('DELETE FROM usage_events').run();
  db.prepare('DELETE FROM usage_rollup_hourly').run();
  db.prepare(`DELETE FROM monitor_meta WHERE key='rollup_high_water'`).run();
  const now = new Date('2026-07-09T12:00:00.000Z');
  const oldId = insertEvent({ createdAt: '2026-05-01 10:00:00', input: 1 });   // 69 days old
  const recentId = insertEvent({ createdAt: '2026-07-08 10:00:00', input: 2 }); // 1 day old

  // No high-water mark yet → nothing raw is pruned (never delete un-rolled-up data).
  let res = pruneRetention(now);
  assert.equal(res.rawDeleted, 0);
  assert.ok(db.prepare('SELECT id FROM usage_events WHERE id=?').get(oldId));

  // Contiguous high-water: roll old hour, then the next hour so the watermark
  // passes the old row (prune cutoff is high-water hour *start*, so the rolled
  // hour's own raw stays protected until high-water advances past it).
  rollupHour('2026-05-01T10');
  rollupHour('2026-05-01T11');
  res = pruneRetention(now);
  assert.equal(res.rawDeleted, 1);
  assert.equal(db.prepare('SELECT id FROM usage_events WHERE id=?').get(oldId), undefined);
  // Recent raw is still un-covered by high-water → must not be deleted.
  assert.ok(db.prepare('SELECT id FROM usage_events WHERE id=?').get(recentId));
});

test('pruneRetention prunes hourly rollups past 180d but keeps daily forever', () => {
  db.prepare('DELETE FROM usage_rollup_hourly').run();
  db.prepare('DELETE FROM usage_rollup_daily').run();
  db.prepare(`INSERT INTO usage_rollup_hourly (bucket, provider, model, user_id, billing_mode, requests) VALUES ('2025-01-01T10','anthropic','m',0,'flat_fee',1)`).run();
  db.prepare(`INSERT INTO usage_rollup_daily (bucket, provider, model, user_id, billing_mode, requests) VALUES ('2025-01-01','anthropic','m',0,'flat_fee',1)`).run();
  const res = pruneRetention(new Date('2026-07-09T12:00:00.000Z'));
  assert.equal(res.hourlyDeleted, 1);
  assert.equal((db.prepare('SELECT COUNT(*) c FROM usage_rollup_daily').get() as any).c, 1);
});

test('pruneRetention enforces request_logs expiry regardless of retention switch', () => {
  db.prepare(`INSERT INTO request_logs (usage_event_id, user_id, request_json, response_text, expires_at) VALUES (NULL, ?, '{}', 'x', '2020-01-01T00:00:00.000Z')`).run(USER);
  const res = pruneRetention(new Date('2026-07-09T12:00:00.000Z'));
  assert.equal(res.requestLogsDeleted, 1);
});

test('pruneRetention multi-batch: clears backlogs larger than one batch in a single pass', () => {
  db.prepare('DELETE FROM usage_events').run();
  db.prepare('DELETE FROM usage_rollup_hourly').run();
  db.prepare(`DELETE FROM monitor_meta WHERE key='rollup_high_water'`).run();
  // 12k old rows — more than two 5k batches.
  const ins = db.prepare(`INSERT INTO usage_events (user_id, token_id, provider, endpoint, billing_mode, created_at) VALUES (?,?,?,?,?,?)`);
  const seed = db.transaction(() => {
    for (let i = 0; i < 12_000; i++) ins.run(USER, TOKEN, 'anthropic', '/e', 'flat_fee', '2026-05-01 10:00:00');
  });
  seed();
  // Contiguous advance past the seeded hour so raw falls behind high-water start.
  rollupHour('2026-05-01T10');
  rollupHour('2026-05-01T11');
  const res = pruneRetention(new Date('2026-07-09T12:00:00.000Z'));
  assert.equal(res.rawDeleted, 12_000, `expected all 12k pruned in one pass, got ${res.rawDeleted}`);
});

// ─── full pass ──────────────────────────────────────────────────────────────

test('runRollupPass covers current+previous hour and today+yesterday daily without throwing', () => {
  db.prepare('DELETE FROM usage_events').run();
  db.prepare('DELETE FROM usage_rollup_hourly').run();
  db.prepare('DELETE FROM usage_rollup_daily').run();
  // Reset high-water so this pass is steady-state (prev+current), not a deep catch-up.
  db.prepare(`DELETE FROM monitor_meta WHERE key='rollup_high_water'`).run();
  const now = new Date();
  const fmt = (x: Date) => x.toISOString().slice(0, 19).replace('T', ' ');
  insertEvent({ createdAt: fmt(now), input: 5, output: 3, latency: 42, ttft: 21 });
  insertEvent({ createdAt: fmt(new Date(now.getTime() - 3600_000)), input: 7, output: 2, latency: 55, ttft: 30 });
  runRollupPass(now);
  const hourly = (db.prepare('SELECT COUNT(*) c FROM usage_rollup_hourly WHERE bucket >= ?').get(hourBucket(new Date(now.getTime() - 3600_000))) as any).c;
  assert.ok(hourly >= 1, `expected hourly rows, got ${hourly}`);
  const daily = (db.prepare('SELECT COUNT(*) c FROM usage_rollup_daily WHERE bucket = ?').get(dayBucket(now)) as any).c;
  assert.ok(daily >= 1, `expected daily rows, got ${daily}`);
});

// ─── review-fix guards ─────────────────────────────────────────────────────

test('rollupHour of an already-pruned bucket does NOT wipe its existing rollup', () => {
  db.prepare('DELETE FROM usage_events').run();
  db.prepare('DELETE FROM usage_rollup_hourly').run();
  db.prepare(`DELETE FROM monitor_meta WHERE key='rollup_high_water'`).run();
  // Roll an hour with data, then delete the raw rows (simulating retention),
  // then advance high-water past it via a later hour.
  insertEvent({ createdAt: '2026-06-01 05:10:00', input: 42 });
  rollupHour('2026-06-01T05');
  db.prepare('DELETE FROM usage_events').run();
  insertEvent({ createdAt: '2026-06-02 09:10:00', input: 1 });
  rollupHour('2026-06-02T09');
  // Re-rolling the pruned hour must be a no-op, not a wipe.
  const n = rollupHour('2026-06-01T05');
  assert.equal(n, 0);
  const kept = db.prepare(`SELECT input_tokens FROM usage_rollup_hourly WHERE bucket='2026-06-01T05'`).get() as any;
  assert.ok(kept, 'rollup row for pruned bucket must survive');
  assert.equal(kept.input_tokens, 42);
});

test('rollupDay of a day whose hourly rows were pruned keeps the permanent daily aggregate', () => {
  db.prepare('DELETE FROM usage_rollup_hourly').run();
  db.prepare('DELETE FROM usage_rollup_daily').run();
  db.prepare(`INSERT INTO usage_rollup_hourly (bucket, provider, model, user_id, billing_mode, requests, input_tokens) VALUES ('2026-06-01T05','anthropic','m',0,'flat_fee',3,99)`).run();
  rollupDay('2026-06-01');
  db.prepare('DELETE FROM usage_rollup_hourly').run(); // hourly retention pruned
  const n = rollupDay('2026-06-01');
  assert.equal(n, 0);
  const kept = db.prepare(`SELECT input_tokens FROM usage_rollup_daily WHERE bucket='2026-06-01'`).get() as any;
  assert.ok(kept, 'daily row must survive hourly pruning');
  assert.equal(kept.input_tokens, 99);
});

test('runRollupPass back-fills gap hours after downtime (high-water catch-up)', () => {
  db.prepare('DELETE FROM usage_events').run();
  db.prepare('DELETE FROM usage_rollup_hourly').run();
  db.prepare('DELETE FROM usage_rollup_daily').run();
  db.prepare(`DELETE FROM monitor_meta WHERE key='rollup_high_water'`).run();
  const now = new Date();
  const fmt = (x: Date) => x.toISOString().slice(0, 19).replace('T', ' ');
  const h = (n: number) => new Date(now.getTime() - n * 3600_000);
  // Simulate: last pass ran 6 hours ago (high-water = that bucket), then the
  // gateway was down; events landed 5h, 3h and 0h ago.
  insertEvent({ createdAt: fmt(h(6)), input: 1 });
  rollupHour(hourBucket(h(6)));
  insertEvent({ createdAt: fmt(h(5)), input: 2 });
  insertEvent({ createdAt: fmt(h(3)), input: 3 });
  insertEvent({ createdAt: fmt(now), input: 4 });
  runRollupPass(now);
  for (const n of [5, 3, 0]) {
    const b = hourBucket(h(n));
    const row = db.prepare('SELECT SUM(input_tokens) s FROM usage_rollup_hourly WHERE bucket = ?').get(b) as any;
    assert.ok(row?.s, `gap hour ${b} (${n}h ago) must be back-filled, got ${row?.s}`);
  }
});

test('runRollupPass contiguously covers a >MAX_CATCHUP_HOURS backlog without skipping hours', () => {
  // Regression for the high-water leapfrog bug: a gap longer than the per-pass
  // cap must be drained oldest-first across multiple passes. High-water may
  // only ever equal a fully covered contiguous prefix; prune must never delete
  // raw rows for hours the watermark has not yet passed.
  db.prepare('DELETE FROM usage_events').run();
  db.prepare('DELETE FROM usage_rollup_hourly').run();
  db.prepare('DELETE FROM usage_rollup_daily').run();
  db.prepare(`DELETE FROM monitor_meta WHERE key='rollup_high_water'`).run();

  const now = new Date('2026-07-09T12:30:00.000Z');
  const fmt = (x: Date) => x.toISOString().slice(0, 19).replace('T', ' ');
  const hourAgo = (n: number) => new Date(now.getTime() - n * 3600_000);

  // High-water stuck 72h ago; events every hour across the whole gap (plus
  // sparse empty hours between). 72 > MAX_CATCHUP_HOURS so one pass cannot
  // finish the backlog.
  const gapHours = 72;
  assert.ok(gapHours > MAX_CATCHUP_HOURS, 'fixture must exceed per-pass cap');
  const startBucket = hourBucket(hourAgo(gapHours));
  insertEvent({ createdAt: fmt(hourAgo(gapHours)), input: 1000, cost: 1 });
  rollupHour(startBucket);
  let hw = (db.prepare(`SELECT value FROM monitor_meta WHERE key='rollup_high_water'`).get() as any).value;
  assert.equal(hw, startBucket);

  // Seed every hour in (start, now] with a unique token count = hour-index.
  // Empty hours are still "covered" by advancing high-water; event hours must
  // produce correct summed rollups.
  const expected = new Map<string, number>();
  for (let n = gapHours - 1; n >= 0; n--) {
    const b = hourBucket(hourAgo(n));
    const tokens = n + 1; // unique non-zero
    insertEvent({ createdAt: fmt(hourAgo(n)), input: tokens, cost: tokens * 0.001 });
    expected.set(b, tokens);
  }

  // Enable retention with an aggressive window so that, if high-water ever
  // leapfrogged, prune would try to delete un-covered raw rows. Keep the
  // config override local to this test.
  const prevEnabled = config.monitorRetentionEnabled;
  const prevRawDays = config.monitorRetentionRawDays;
  config.monitorRetentionEnabled = true;
  config.monitorRetentionRawDays = 1; // 24h floor-ish; many gap hours older

  const seenHw: string[] = [hw];
  // Enough passes to cover 72h at 48h/pass + steady-state re-rolls.
  for (let pass = 0; pass < 4; pass++) {
    // Snapshot raw count for hours still behind the current high-water before pass.
    const preHw = (db.prepare(`SELECT value FROM monitor_meta WHERE key='rollup_high_water'`).get() as any).value as string;
    const preHwStart = hourBounds(preHw).start;
    const protectedRaw = (db.prepare(
      `SELECT COUNT(*) c FROM usage_events WHERE created_at >= ?`,
    ).get(preHwStart) as any).c as number;

    runRollupPass(now);

    hw = (db.prepare(`SELECT value FROM monitor_meta WHERE key='rollup_high_water'`).get() as any).value as string;
    seenHw.push(hw);
    // High-water only advances (or stays); never jumps past an un-rolled hour.
    // Because catch-up is oldest-first + contiguous, each pass advances by at
    // most MAX_CATCHUP_HOURS from the previous watermark.
    const prev = seenHw[seenHw.length - 2];
    const prevMs = new Date(`${prev}:00:00.000Z`).getTime();
    const hwMs = new Date(`${hw}:00:00.000Z`).getTime();
    assert.ok(hwMs >= prevMs, `high-water must not regress: ${prev} → ${hw}`);
    const advancedHours = (hwMs - prevMs) / 3600_000;
    assert.ok(
      advancedHours <= MAX_CATCHUP_HOURS,
      `high-water advanced ${advancedHours}h in one pass (cap ${MAX_CATCHUP_HOURS}): ${prev} → ${hw}`,
    );

    // Raw rows for hours not yet covered by high-water must still exist after prune.
    // cutoff = min(retention, highWaterStart); anything at/after highWaterStart is safe.
    const postProtected = (db.prepare(
      `SELECT COUNT(*) c FROM usage_events WHERE created_at >= ?`,
    ).get(hourBounds(hw).start) as any).c as number;
    // protectedRaw was counted at pre-pass high-water; after advancing, the
    // remaining-at-or-after-new-hw count can only shrink by hours that are now
    // behind the watermark. Assert no un-covered raw was deleted: every event
    // whose hour is still > hw must remain.
    for (const [b, tokens] of expected) {
      if (b > hw) {
        const raw = (db.prepare(
          `SELECT SUM(input_tokens) s FROM usage_events WHERE created_at >= ? AND created_at < ?`,
        ).get(hourBounds(b).start, hourBounds(b).end) as any).s;
        assert.equal(raw, tokens, `raw for un-covered hour ${b} must survive prune (hw=${hw})`);
      }
    }
    void protectedRaw;
    void postProtected;
  }

  // After enough passes every seeded hour has a rollup with correct tokens.
  for (const [b, tokens] of expected) {
    const row = db.prepare(
      `SELECT SUM(input_tokens) s, ROUND(SUM(cost_usd), 6) c FROM usage_rollup_hourly WHERE bucket = ?`,
    ).get(b) as any;
    assert.equal(row?.s, tokens, `hour ${b} must be rolled with ${tokens} tokens, got ${row?.s}`);
    assert.equal(row?.c, Math.round(tokens * 0.001 * 1e6) / 1e6);
  }

  // Contiguous watermark ends at the newest fully covered hour (current hour).
  const finalHw = (db.prepare(`SELECT value FROM monitor_meta WHERE key='rollup_high_water'`).get() as any).value as string;
  assert.equal(finalHw, hourBucket(now));
  // Every hour from start..finalHw must have been visited (empty hours ok as 0-row).
  for (let t = new Date(`${startBucket}:00:00.000Z`).getTime(); t <= new Date(`${finalHw}:00:00.000Z`).getTime(); t += 3600_000) {
    const b = hourBucket(new Date(t));
    // If we seeded it, assert already done above; if empty, high-water past it
    // is enough proof it was considered (contiguous advance).
    assert.ok(b <= finalHw);
  }

  config.monitorRetentionEnabled = prevEnabled;
  config.monitorRetentionRawDays = prevRawDays;
});

test('resolveMonitorRetentionRawDays floors at daily-cap window and rejects NaN', () => {
  assert.equal(MIN_MONITOR_RETENTION_RAW_DAYS, 1);
  assert.equal(resolveMonitorRetentionRawDays(undefined), 30);
  assert.equal(resolveMonitorRetentionRawDays('30'), 30);
  assert.equal(resolveMonitorRetentionRawDays('0'), 1);
  assert.equal(resolveMonitorRetentionRawDays('-3'), 1);
  assert.equal(resolveMonitorRetentionRawDays('0.5'), 1);
  assert.equal(resolveMonitorRetentionRawDays('not-a-number'), 30);
  assert.equal(resolveMonitorRetentionRawDays(''), 30);
  assert.equal(resolveMonitorRetentionHourlyDays(undefined), 180);
  assert.equal(resolveMonitorRetentionHourlyDays('nope'), 180);
  assert.equal(resolveMonitorRetentionHourlyDays('0'), 1);
});

test('rollup vs ad-hoc raw query parity (validation query from checklist)', () => {
  // The Phase 2 acceptance check: rollup numbers must match a direct GROUP BY.
  db.prepare('DELETE FROM usage_events').run();
  db.prepare('DELETE FROM usage_rollup_hourly').run();
  for (let i = 0; i < 50; i++) {
    insertEvent({ createdAt: AT(i % 60), input: i, output: i * 2, cost: i * 0.001, latency: i * 10 || null as any });
  }
  rollupHour(H);
  const raw = db.prepare(`
    SELECT COUNT(*) requests, SUM(input_tokens) input, SUM(output_tokens) output, ROUND(SUM(estimated_cost_usd), 6) cost
    FROM usage_events WHERE created_at >= '2026-07-01 10:00:00' AND created_at < '2026-07-01 11:00:00'
  `).get() as any;
  const rolled = db.prepare(`
    SELECT SUM(requests) requests, SUM(input_tokens) input, SUM(output_tokens) output, ROUND(SUM(cost_usd), 6) cost
    FROM usage_rollup_hourly WHERE bucket = ?
  `).get(H) as any;
  assert.deepEqual(rolled, raw);
});
