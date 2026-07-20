import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

const dbPath = path.join(os.tmpdir(), `super-proxy-alerts-${process.pid}-${Date.now()}.sqlite`);
process.env.DATABASE_PATH = dbPath;
process.env.DEV_ADMIN_KEY = 'test-admin';
// No webhook configured → delivery falls back to legacy alert() (DB-only here).
delete process.env.DISCORD_MONITOR_WEBHOOK;
process.env.MONITOR_PING_DISCORD_IDS = '111,222';

const { migrate } = await import('./db/migrate.js');
const { getDb } = await import('./db/index.js');
const { isCoolingDown, markFired, fireMonitorAlert } = await import('./monitoring/alert-send.js');
const { evaluateAlertRules, resolveDailyBudgetUsd } = await import('./monitoring/alert-rules.js');
const { mondayOf, isDigestDue, buildDigestData, updateBudgetSuggestion } = await import('./monitoring/digest.js');
const { rollupHour, hourBucket, dayBucket } = await import('./monitoring/rollup.js');

migrate();
const db = getDb();

const u = db.prepare(`INSERT INTO users (email, name, role) VALUES ('alerts@test.dev','A','member')`).run();
const USER = Number(u.lastInsertRowid);
const t = db.prepare(`INSERT INTO api_tokens (user_id, label, token_hash, token_prefix) VALUES (?,?,?,?)`).run(USER, 'a', 'h2', 'p2');
const TOKEN = Number(t.lastInsertRowid);

const fmtTs = (x: Date) => x.toISOString().slice(0, 19).replace('T', ' ');

function insertEvent(opts: { minutesAgo: number; provider?: string; status?: number; latency?: number; input?: number; cacheRead?: number; cost?: number; billing?: string }): void {
  db.prepare(`
    INSERT INTO usage_events (user_id, token_id, provider, endpoint, status_code, latency_ms, input_tokens, cache_read_tokens, estimated_cost_usd, billing_mode, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(USER, TOKEN, opts.provider ?? 'anthropic', '/e', opts.status ?? 200, opts.latency ?? null,
    opts.input ?? 0, opts.cacheRead ?? 0, opts.cost ?? 0, opts.billing ?? 'flat_fee',
    fmtTs(new Date(Date.now() - opts.minutesAgo * 60_000)));
}

function clearAll() {
  db.prepare('DELETE FROM usage_events').run();
  db.prepare('DELETE FROM usage_rollup_hourly').run();
  db.prepare('DELETE FROM usage_rollup_daily').run();
  db.prepare('DELETE FROM alert_cooldowns').run();
  db.prepare('DELETE FROM alerts').run();
  db.prepare('DELETE FROM provider_accounts').run();
  db.prepare(`DELETE FROM monitor_meta`).run();
}

// ─── cooldowns ──────────────────────────────────────────────────────────────

test('cooldowns: DB-backed, restart-safe semantics', async () => {
  clearAll();
  assert.equal(isCoolingDown('r1', 'p', 3600_000), false);
  markFired('r1', 'p');
  assert.equal(isCoolingDown('r1', 'p', 3600_000), true);
  assert.equal(isCoolingDown('r1', 'other-scope', 3600_000), false);
  assert.equal(isCoolingDown('r2', 'p', 3600_000), false);
  // expired cooldown
  db.prepare(`UPDATE alert_cooldowns SET last_fired_at = ? WHERE rule='r1'`).run(new Date(Date.now() - 7200_000).toISOString());
  assert.equal(isCoolingDown('r1', 'p', 3600_000), false);
});

test('fireMonitorAlert: sends once, then respects cooldown; writes alerts row', async () => {
  clearAll();
  const a = { rule: 'test_rule', scope: 'x', severity: 'warn' as const, title: 'T', message: 'M', cooldownMs: 3600_000 };
  assert.equal(await fireMonitorAlert(a), true);
  assert.equal(await fireMonitorAlert(a), false); // cooling down
  const rows = db.prepare(`SELECT * FROM alerts WHERE type = 'monitor_test_rule'`).all();
  assert.equal(rows.length, 1);
});

// ─── rules: fire / no-fire / cooldown per rule ──────────────────────────────

test('pool_low: fires when ≤1 active with traffic; silent without traffic', async () => {
  clearAll();
  db.prepare(`INSERT INTO provider_accounts (provider, label, secret, enabled, status) VALUES ('anthropic','only-one','s',1,'active')`).run();
  db.prepare(`INSERT INTO provider_accounts (provider, label, secret, enabled, status) VALUES ('kimi','k1','s',1,'active')`).run();
  insertEvent({ minutesAgo: 30, provider: 'anthropic' }); // traffic for anthropic only
  const fired = await evaluateAlertRules();
  assert.ok(fired.includes('pool_low:anthropic'), `fired=${fired}`);
  assert.ok(!fired.some((f) => f.startsWith('pool_low:kimi')), 'kimi has no traffic — must not fire');
});

test('pool_low: does not fire with 2+ active accounts', async () => {
  clearAll();
  db.prepare(`INSERT INTO provider_accounts (provider, label, secret, enabled, status) VALUES ('anthropic','a1','s',1,'active'),('anthropic','a2','s',1,'active')`).run();
  insertEvent({ minutesAgo: 30, provider: 'anthropic' });
  const fired = await evaluateAlertRules();
  assert.ok(!fired.some((f) => f.startsWith('pool_low:')), `fired=${fired}`);
});

test('error_spike: fires >20% over 15min with ≥20 requests; below thresholds silent', async () => {
  clearAll();
  for (let i = 0; i < 15; i++) insertEvent({ minutesAgo: 5, provider: 'glm', status: 500 });
  for (let i = 0; i < 10; i++) insertEvent({ minutesAgo: 5, provider: 'glm', status: 200 });
  // 15/25 = 60% error rate, 25 requests → fire
  let fired = await evaluateAlertRules();
  assert.ok(fired.includes('error_spike:glm'), `fired=${fired}`);
  // Cooldown: immediate re-eval is silent
  fired = await evaluateAlertRules();
  assert.ok(!fired.includes('error_spike:glm'));
  // Below min requests: silent
  clearAll();
  for (let i = 0; i < 5; i++) insertEvent({ minutesAgo: 5, provider: 'glm', status: 500 });
  fired = await evaluateAlertRules();
  assert.ok(!fired.includes('error_spike:glm'), 'only 5 requests — below floor');
});

test('daily_budget: disabled without budget; warn at 80%; critical at 100%; once per day', async () => {
  clearAll();
  const now = new Date();
  const bucket = hourBucket(now);
  db.prepare(`INSERT INTO usage_rollup_hourly (bucket, provider, model, user_id, billing_mode, requests, cost_usd) VALUES (?,?,?,?,?,?,?)`)
    .run(bucket, 'gemini', 'g', 0, 'metered', 10, 8.5);
  // No budget → silent.
  let fired = await evaluateAlertRules(now);
  assert.ok(!fired.some((f) => f.startsWith('daily_budget')), `fired=${fired}`);
  // Budget $10 → 85% → warn.
  db.prepare(`INSERT INTO monitor_meta (key, value) VALUES ('daily_budget_usd','10')`).run();
  assert.equal(resolveDailyBudgetUsd(), 10);
  fired = await evaluateAlertRules(now);
  assert.ok(fired.includes(`daily_budget_80:${dayBucket(now)}`), `fired=${fired}`);
  // Spend crosses 100% → critical fires (different rule name, own cooldown).
  db.prepare(`UPDATE usage_rollup_hourly SET cost_usd = 12 WHERE bucket = ?`).run(bucket);
  fired = await evaluateAlertRules(now);
  assert.ok(fired.includes(`daily_budget_100:${dayBucket(now)}`), `fired=${fired}`);
  // Re-eval: both silent for the rest of the day.
  fired = await evaluateAlertRules(now);
  assert.ok(!fired.some((f) => f.startsWith('daily_budget')));
});

test('rate_limit_pressure: fires >10% 429s over 1h with ≥30 requests', async () => {
  clearAll();
  for (let i = 0; i < 6; i++) insertEvent({ minutesAgo: 30, provider: 'openai_codex', status: 429 });
  for (let i = 0; i < 30; i++) insertEvent({ minutesAgo: 30, provider: 'openai_codex', status: 200 });
  // 6/36 = 16.7% → fire
  const fired = await evaluateAlertRules();
  assert.ok(fired.includes('rate_limit_pressure:openai_codex'), `fired=${fired}`);
});

test('cache_collapse: fires when hour rate < 50% of 7d average with volume', async () => {
  clearAll();
  const now = new Date();
  const prevHour = hourBucket(new Date(now.getTime() - 3600_000));
  // History: 3 days ago, 60% hit rate at volume.
  const histBucket = hourBucket(new Date(now.getTime() - 3 * 24 * 3600_000));
  db.prepare(`INSERT INTO usage_rollup_hourly (bucket, provider, model, user_id, billing_mode, requests, input_tokens, cache_read_tokens) VALUES (?,?,?,?,?,?,?,?)`)
    .run(histBucket, 'anthropic', 'm', 0, 'flat_fee', 100, 400_000, 600_000);
  // Last hour: 10% hit rate at volume.
  db.prepare(`INSERT INTO usage_rollup_hourly (bucket, provider, model, user_id, billing_mode, requests, input_tokens, cache_read_tokens) VALUES (?,?,?,?,?,?,?,?)`)
    .run(prevHour, 'anthropic', 'm', 0, 'flat_fee', 100, 900_000, 100_000);
  const fired = await evaluateAlertRules(now);
  assert.ok(fired.includes('cache_collapse:anthropic'), `fired=${fired}`);
});

test('cache_collapse: subset providers use input_tokens as the hit-rate denominator/volume floor', async () => {
  clearAll();
  const now = new Date();
  const prevHour = hourBucket(new Date(now.getTime() - 3600_000));
  const histBucket = hourBucket(new Date(now.getTime() - 3 * 24 * 3600_000));
  db.prepare(`INSERT INTO usage_rollup_hourly (bucket, provider, model, user_id, billing_mode, requests, input_tokens, cache_read_tokens) VALUES (?,?,?,?,?,?,?,?)`)
    .run(histBucket, 'xai', 'grok-4.5', 0, 'flat_fee', 100, 100_000, 80_000);
  // SUBSET accounting: denominator is input_tokens=90k, below the default 100k
  // volume floor. The old input+cache_read denominator would be 110k and could
  // false-fire this alert.
  db.prepare(`INSERT INTO usage_rollup_hourly (bucket, provider, model, user_id, billing_mode, requests, input_tokens, cache_read_tokens) VALUES (?,?,?,?,?,?,?,?)`)
    .run(prevHour, 'xai', 'grok-4.5', 0, 'flat_fee', 100, 90_000, 20_000);
  const fired = await evaluateAlertRules(now);
  assert.ok(!fired.includes('cache_collapse:xai'), `fired=${fired}`);
});

test('latency_degraded: fires when 15min p95 > 2.5× 7d baseline', async () => {
  clearAll();
  const now = new Date();
  // Baseline: hourly rollup p95=200ms.
  const histBucket = hourBucket(new Date(now.getTime() - 2 * 24 * 3600_000));
  db.prepare(`INSERT INTO usage_rollup_hourly (bucket, provider, model, user_id, billing_mode, requests, latency_ms_p95) VALUES (?,?,?,?,?,?,?)`)
    .run(histBucket, 'xai', 'm', 0, 'flat_fee', 100, 200);
  // Recent: 25 requests at 900ms.
  for (let i = 0; i < 25; i++) insertEvent({ minutesAgo: 5, provider: 'xai', latency: 900 });
  const fired = await evaluateAlertRules(now);
  assert.ok(fired.includes('latency_degraded:xai'), `fired=${fired}`);
});

test('rollup_stalled: fires when newest bucket >2h old; silent when fresh or empty', async () => {
  clearAll();
  // Empty table → silent (never rolled yet).
  let fired = await evaluateAlertRules();
  assert.ok(!fired.includes('rollup_stalled:'), `fired=${fired}`);
  // Stale bucket (5h old) → fire.
  const stale = hourBucket(new Date(Date.now() - 5 * 3600_000));
  db.prepare(`INSERT INTO usage_rollup_hourly (bucket, provider, model, user_id, billing_mode, requests) VALUES (?,?,?,?,?,?)`)
    .run(stale, 'anthropic', 'm', 0, 'flat_fee', 1);
  fired = await evaluateAlertRules();
  assert.ok(fired.includes('rollup_stalled:'), `fired=${fired}`);
  // Fresh bucket → silent (delete stale first so MAX picks fresh).
  db.prepare('DELETE FROM usage_rollup_hourly').run();
  db.prepare('DELETE FROM alert_cooldowns').run();
  db.prepare(`INSERT INTO usage_rollup_hourly (bucket, provider, model, user_id, billing_mode, requests) VALUES (?,?,?,?,?,?)`)
    .run(hourBucket(new Date()), 'anthropic', 'm', 0, 'flat_fee', 1);
  fired = await evaluateAlertRules();
  assert.ok(!fired.includes('rollup_stalled:'));
});

// ─── digest ─────────────────────────────────────────────────────────────────

test('mondayOf + isDigestDue schedule/dedupe math', () => {
  clearAll();
  assert.equal(mondayOf(new Date('2026-07-09T10:00:00Z')), '2026-07-06'); // Thursday → that week's Monday
  assert.equal(mondayOf(new Date('2026-07-06T00:30:00Z')), '2026-07-06'); // Monday itself
  assert.equal(mondayOf(new Date('2026-07-05T10:00:00Z')), '2026-06-29'); // Sunday → previous Monday
  // Not Monday → not due.
  assert.equal(isDigestDue(new Date('2026-07-09T10:00:00Z')), false);
  // Monday before 03:30 UTC → not due.
  assert.equal(isDigestDue(new Date('2026-07-06T02:00:00Z')), false);
  // Monday after 03:30 UTC → due.
  assert.equal(isDigestDue(new Date('2026-07-06T04:00:00Z')), true);
  // Already posted this Monday → not due.
  db.prepare(`INSERT INTO monitor_meta (key, value) VALUES ('digest_last_monday','2026-07-06')`).run();
  assert.equal(isDigestDue(new Date('2026-07-06T04:00:00Z')), false);
});

test('buildDigestData aggregates previous full week from daily rollups', () => {
  clearAll();
  const monday = new Date('2026-07-06T04:00:00Z'); // digest runs this Monday
  // Previous week: 2026-06-29 .. 2026-07-05
  db.prepare(`INSERT INTO usage_rollup_daily (bucket, provider, model, user_id, billing_mode, requests, input_tokens, output_tokens, cache_read_tokens, cost_usd) VALUES
    ('2026-07-01','gemini','g',0,'metered',100,50000,10000,0,4.5),
    ('2026-07-02','anthropic','claude-sonnet-4-6',0,'flat_fee',200,80000,20000,120000,9.0)`).run();
  const d = buildDigestData(monday);
  assert.equal(d.weekStart, '2026-06-29');
  assert.equal(d.weekEnd, '2026-07-06');
  assert.equal(d.meteredUsd, 4.5);
  assert.equal(d.notionalUsd, 9);
  assert.equal(d.requests, 300);
  assert.equal(d.topModels[0].provider, 'anthropic'); // most tokens
  // hit rate = 120000/(130000+120000)
  assert.ok(Math.abs(d.cacheHitRate! - 120000 / 250000) < 0.001);
});

// ─── budget suggestion ──────────────────────────────────────────────────────

test('cost_spike: sparse history (<3 buckets) is no baseline — must not fire', async () => {
  clearAll();
  const now = new Date();
  const prevHour = hourBucket(new Date(now.getTime() - 3600_000));
  // Last hour: $20 metered on gemini.
  db.prepare(`INSERT INTO usage_rollup_hourly (bucket, provider, model, user_id, billing_mode, requests, cost_usd) VALUES (?,?,?,?,?,?,?)`)
    .run(prevHour, 'gemini', 'g', 0, 'metered', 10, 20);
  // Only ONE historical same-hour bucket ($1): with the old /7.0 math the
  // baseline would be $0.14 and $20 would false-fire. With ≥3-bucket floor,
  // no baseline → silent.
  const oneDayAgo = hourBucket(new Date(now.getTime() - 3600_000 - 24 * 3600_000));
  db.prepare(`INSERT INTO usage_rollup_hourly (bucket, provider, model, user_id, billing_mode, requests, cost_usd) VALUES (?,?,?,?,?,?,?)`)
    .run(oneDayAgo, 'gemini', 'g', 0, 'metered', 10, 1);
  const fired = await evaluateAlertRules(now);
  assert.ok(!fired.includes('cost_spike:gemini'), `sparse history must not fire: ${fired}`);
});

test('cost_spike: fires with full history and a real spike; average uses actual bucket count', async () => {
  clearAll();
  const now = new Date();
  const prevHour = hourBucket(new Date(now.getTime() - 3600_000));
  db.prepare(`INSERT INTO usage_rollup_hourly (bucket, provider, model, user_id, billing_mode, requests, cost_usd) VALUES (?,?,?,?,?,?,?)`)
    .run(prevHour, 'gemini', 'g', 0, 'metered', 10, 20);
  // 4 historical buckets at $2 each → baseline $2 (NOT 8/7=$1.14 — either
  // way $20 > 3×, but the assertion pins the fire with partial-but-≥3 history).
  for (const d of [1, 2, 3, 4]) {
    const b = hourBucket(new Date(now.getTime() - 3600_000 - d * 24 * 3600_000));
    db.prepare(`INSERT INTO usage_rollup_hourly (bucket, provider, model, user_id, billing_mode, requests, cost_usd) VALUES (?,?,?,?,?,?,?)`)
      .run(b, 'gemini', 'g', 0, 'metered', 10, 2);
  }
  const fired = await evaluateAlertRules(now);
  assert.ok(fired.includes('cost_spike:gemini'), `expected fire: ${fired}`);
});

test('updateBudgetSuggestion: null under 7 days; p95×1.5 with data; null when confirmed', () => {
  clearAll();
  const now = new Date();
  // 5 days only → no suggestion.
  for (let i = 1; i <= 5; i++) {
    db.prepare(`INSERT INTO usage_rollup_daily (bucket, provider, model, user_id, billing_mode, requests, cost_usd) VALUES (?,?,?,?,?,?,?)`)
      .run(dayBucket(new Date(now.getTime() - i * 24 * 3600_000)), 'gemini', 'g', 0, 'metered', 10, 4);
  }
  assert.equal(updateBudgetSuggestion(now), null);
  // 10 days at ~$4/day → suggested = ceil(4×1.5) = 6.
  for (let i = 6; i <= 10; i++) {
    db.prepare(`INSERT INTO usage_rollup_daily (bucket, provider, model, user_id, billing_mode, requests, cost_usd) VALUES (?,?,?,?,?,?,?)`)
      .run(dayBucket(new Date(now.getTime() - i * 24 * 3600_000)), 'gemini', 'g', 0, 'metered', 10, 4);
  }
  assert.equal(updateBudgetSuggestion(now), 6);
  assert.equal((db.prepare(`SELECT value FROM monitor_meta WHERE key='daily_budget_suggested'`).get() as any).value, '6');
  // Confirmed budget → suggestion becomes a no-op.
  db.prepare(`INSERT INTO monitor_meta (key, value) VALUES ('daily_budget_usd','20')`).run();
  assert.equal(updateBudgetSuggestion(now), null);
});
