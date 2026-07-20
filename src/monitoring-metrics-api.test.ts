import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';

const dbPath = path.join(os.tmpdir(), `model-gateway-metrics-${process.pid}-${Date.now()}.sqlite`);
process.env.DATABASE_PATH = dbPath;
process.env.DEV_ADMIN_KEY = 'test-admin-key';
process.env.MONITOR_ACCESS_EMAILS = 'yash@infinitycorp.tech, daxitm432@gmail.com';

const { migrate } = await import('./db/migrate.js');
const { getDb } = await import('./db/index.js');
const { config } = await import('./config.js');
const { createProxyToken } = await import('./utils/crypto.js');
const { registerMetricsApi } = await import('./monitoring/metrics-api.js');
const { registerAdminApi } = await import('./admin/admin-api.js');
const { rollupHour, rollupDay, hourBucket, dayBucket } = await import('./monitoring/rollup.js');

migrate();
const db = getDb();

// ─── seed users/tokens ──────────────────────────────────────────────────────

function seedUser(email: string): { userId: number; token: string } {
  const u = db.prepare(`INSERT INTO users (email, name, role) VALUES (?, ?, 'member')`).run(email, email.split('@')[0]);
  const tok = createProxyToken();
  db.prepare(`INSERT INTO api_tokens (user_id, label, token_hash, token_prefix) VALUES (?,?,?,?)`).run(Number(u.lastInsertRowid), 'metrics-test', tok.hash, tok.raw.slice(0, 12));
  return { userId: Number(u.lastInsertRowid), token: tok.raw };
}

const monitor = seedUser('yash@infinitycorp.tech'); // allowlisted
const outsider = seedUser('random@nowhere.dev');    // NOT allowlisted

// Seed usage in the current hour so rollups land in the 24h window.
const now = new Date();
const fmt = (x: Date) => x.toISOString().slice(0, 19).replace('T', ' ');
const ins = db.prepare(`
  INSERT INTO usage_events (user_id, token_id, provider, endpoint, model, status_code,
    input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_creation_tokens,
    estimated_cost_usd, latency_ms, ttft_ms, unit, billing_mode, provider_account_label, created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);
// anthropic flat_fee with cache activity
ins.run(monitor.userId, 1, 'anthropic', '/v1/messages', 'claude-sonnet-4-6', 200, 100, 50, 10, 400, 40, 0.012, 900, 300, null, 'flat_fee', 'acc-a', fmt(now));
ins.run(monitor.userId, 1, 'anthropic', '/v1/messages', 'claude-sonnet-4-6', 429, 0, 0, 0, 0, 0, 0, 50, null, null, 'flat_fee', 'acc-a', fmt(now));
// gemini metered
ins.run(monitor.userId, 1, 'gemini', '/v1/gemini/chat/completions', 'gemini-2.5-flash', 200, 1000, 200, 0, 0, 0, 0.0008, 400, 150, null, 'metered', 'g-1', fmt(now));
// deepgram seconds (must not pollute tokens)
ins.run(monitor.userId, 1, 'deepgram', '/v1/deepgram/listen', 'nova-3', 200, 3600, 0, 0, 0, 0, 0, 800, null, 'seconds', 'metered', 'd-1', fmt(now));

rollupHour(hourBucket(now));
rollupDay(dayBucket(now));

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  registerMetricsApi(app);
  registerAdminApi(app);
  await app.ready();
  return app;
}

// ─── requireMonitor guard ───────────────────────────────────────────────────

test('root admin (dev key) can read metrics', async () => {
  const app = await buildApp();
  const res = await app.inject({ method: 'GET', url: '/admin/metrics/overview?range=24h', headers: { 'x-admin-key': 'test-admin-key' } });
  assert.equal(res.statusCode, 200, res.body);
  await app.close();
});

test('allowlisted monitor email passes via API token', async () => {
  const app = await buildApp();
  const res = await app.inject({ method: 'GET', url: '/admin/metrics/overview?range=24h', headers: { authorization: `Bearer ${monitor.token}` } });
  assert.equal(res.statusCode, 200, res.body);
  await app.close();
});

test('non-allowlisted user token gets 403', async () => {
  const app = await buildApp();
  const res = await app.inject({ method: 'GET', url: '/admin/metrics/overview?range=24h', headers: { authorization: `Bearer ${outsider.token}` } });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('no auth gets 403', async () => {
  const app = await buildApp();
  const res = await app.inject({ method: 'GET', url: '/admin/metrics/overview' });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('disabled token gets 403 even when allowlisted', async () => {
  const extra = seedUser('daxitm432@gmail.com');
  db.prepare('UPDATE api_tokens SET enabled = 0 WHERE user_id = ?').run(extra.userId);
  const app = await buildApp();
  const res = await app.inject({ method: 'GET', url: '/admin/metrics/overview', headers: { authorization: `Bearer ${extra.token}` } });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('monitor token CANNOT access mutating admin routes (privilege escalation guard)', async () => {
  const app = await buildApp();
  // A mutating admin route: create user. Monitor token must be rejected by requireAdmin.
  const res = await app.inject({ method: 'POST', url: '/admin/users', headers: { authorization: `Bearer ${monitor.token}`, 'content-type': 'application/json' }, payload: { email: 'sneaky@evil.dev' } });
  assert.equal(res.statusCode, 403, `expected 403, got ${res.statusCode}: ${res.body}`);
  // And a read-only admin route outside metrics is also denied.
  const res2 = await app.inject({ method: 'GET', url: '/admin/users', headers: { authorization: `Bearer ${monitor.token}` } });
  assert.equal(res2.statusCode, 403);
  await app.close();
});

test('monitor reads are audit-logged', async () => {
  const before = (db.prepare(`SELECT COUNT(*) c FROM admin_audit_logs WHERE action='monitor_metrics_read'`).get() as any).c;
  const app = await buildApp();
  await app.inject({ method: 'GET', url: '/admin/metrics/overview', headers: { authorization: `Bearer ${monitor.token}` } });
  const after = (db.prepare(`SELECT COUNT(*) c FROM admin_audit_logs WHERE action='monitor_metrics_read'`).get() as any).c;
  assert.ok(after > before, 'expected an audit row for the monitor read');
  await app.close();
});

// ─── response shapes & invariants ───────────────────────────────────────────

test('overview: metered/notional never summed; token sums exclude non-token units', async () => {
  const app = await buildApp();
  const res = await app.inject({ method: 'GET', url: '/admin/metrics/overview?range=24h', headers: { 'x-admin-key': 'test-admin-key' } });
  const j = res.json();
  // Cost is ALWAYS a split object.
  assert.ok(typeof j.totals.cost === 'object' && 'metered' in j.totals.cost && 'notional' in j.totals.cost);
  assert.ok(j.totals.cost.notional >= 0.012);
  assert.ok(j.totals.cost.metered >= 0.0008);
  // No combined single-number cost anywhere in totals.
  assert.equal('costUsd' in j.totals, false);
  // deepgram's 3600 "seconds" must NOT appear in token totals: anthropic 100+gemini 1000 input.
  assert.equal(j.totals.inputTokens, 1100);
  assert.equal(j.totals.reasoningTokens, 10);
  // provider rows include cache hit + error rates
  const anth = j.providers.find((p: any) => p.provider === 'anthropic');
  assert.ok(anth);
  assert.ok(anth.cacheHitRate > 0.7, `cache hit ${anth.cacheHitRate}`); // 400/(400+100)
  assert.ok(anth.errors429 === 1);
  await app.close();
});

test('timeseries: cost_usd returns split objects, cache_hit_rate returns ratio', async () => {
  const app = await buildApp();
  const res = await app.inject({ method: 'GET', url: '/admin/metrics/timeseries?metric=cost_usd&range=24h', headers: { 'x-admin-key': 'test-admin-key' } });
  const j = res.json();
  assert.ok(j.series.length >= 1);
  assert.ok(typeof j.series[0].value === 'object' && 'metered' in j.series[0].value);
  const res2 = await app.inject({ method: 'GET', url: '/admin/metrics/timeseries?metric=cache_hit_rate&range=24h', headers: { 'x-admin-key': 'test-admin-key' } });
  const v = res2.json().series[0].value;
  assert.ok(v > 0 && v <= 1);
  await app.close();
});

test('cache endpoint reports per-model hit rates and savings', async () => {
  const app = await buildApp();
  const res = await app.inject({ method: 'GET', url: '/admin/metrics/cache?range=24h', headers: { 'x-admin-key': 'test-admin-key' } });
  const j = res.json();
  const row = j.rows.find((r: any) => r.provider === 'anthropic');
  assert.ok(row, 'anthropic cache row expected');
  assert.equal(row.cacheReadTokens, 400);
  assert.equal(row.cacheWriteTokens, 40);
  assert.ok(row.savedUsd > 0);
  await app.close();
});

test('top by user resolves emails and returns cost splits', async () => {
  const app = await buildApp();
  const res = await app.inject({ method: 'GET', url: '/admin/metrics/top?dimension=user&by=cost&range=24h', headers: { 'x-admin-key': 'test-admin-key' } });
  const j = res.json();
  assert.ok(j.rows.length >= 1);
  assert.equal(j.rows[0].label, 'yash@infinitycorp.tech');
  assert.ok(typeof j.rows[0].cost === 'object');
  await app.close();
});

test('top rows expose per-request + token-weighted cache fields', async () => {
  const app = await buildApp();
  const res = await app.inject({ method: 'GET', url: '/admin/metrics/top?dimension=user&by=cost&range=24h', headers: { 'x-admin-key': 'test-admin-key' } });
  const j = res.json();
  assert.ok(j.rows.length >= 1);
  const row = j.rows[0];
  // Per-request metric (visible column) + raw counts must be present on every row.
  assert.ok('cacheHitRatePerRequest' in row, 'row must include cacheHitRatePerRequest');
  assert.ok('cacheableRequests' in row, 'row must include cacheableRequests');
  assert.ok('cacheHitRequests' in row, 'row must include cacheHitRequests');
  assert.ok(typeof row.cacheableRequests === 'number', 'cacheableRequests must be a number');
  assert.ok(typeof row.cacheHitRequests === 'number', 'cacheHitRequests must be a number');
  // per-request is null when no cacheable requests, else a 0-1 fraction.
  if (row.cacheableRequests === 0) {
    assert.equal(row.cacheHitRatePerRequest, null, 'per-request must be null with 0 cacheable requests');
  } else {
    assert.ok(row.cacheHitRatePerRequest >= 0 && row.cacheHitRatePerRequest <= 1, `per-request must be 0-1, got ${row.cacheHitRatePerRequest}`);
  }
  // token-weighted value kept for back-compat (may be null when no input tokens).
  assert.ok('cacheHitRate' in row, 'row must include token-weighted cacheHitRate');
  await app.close();
});

test('reliability returns error classes, pools and retry reasons', async () => {
  const app = await buildApp();
  const res = await app.inject({ method: 'GET', url: '/admin/metrics/reliability?range=24h', headers: { 'x-admin-key': 'test-admin-key' } });
  const j = res.json();
  const anth = j.providers.find((p: any) => p.provider === 'anthropic');
  assert.equal(anth.errors429, 1);
  assert.ok(Array.isArray(j.pools));
  assert.ok(Array.isArray(j.healthEvents));
  await app.close();
});

test('utilization lists flat-fee accounts only', async () => {
  const app = await buildApp();
  const res = await app.inject({ method: 'GET', url: '/admin/metrics/utilization?range=24h', headers: { 'x-admin-key': 'test-admin-key' } });
  const j = res.json();
  assert.ok(j.accounts.length >= 1);
  assert.ok(j.accounts.every((a: any) => a.provider === 'anthropic'), JSON.stringify(j.accounts)); // only flat_fee rows seeded for anthropic
  assert.equal(j.accounts[0].account, 'acc-a');
  await app.close();
});

test('burn projects metered-only month spend', async () => {
  const app = await buildApp();
  const res = await app.inject({ method: 'GET', url: '/admin/metrics/burn', headers: { 'x-admin-key': 'test-admin-key' } });
  const j = res.json();
  assert.ok(j.meteredUsd >= 0.0008, `metered ${j.meteredUsd}`);
  // flat-fee 0.012 must NOT be included
  assert.ok(j.meteredUsd < 0.012, `flat-fee leaked into burn: ${j.meteredUsd}`);
  assert.ok(j.projectedUsd == null || j.projectedUsd >= j.meteredUsd);
  await app.close();
});

test('invalid range rejected', async () => {
  const app = await buildApp();
  const res = await app.inject({ method: 'GET', url: '/admin/metrics/overview?range=99y', headers: { 'x-admin-key': 'test-admin-key' } });
  assert.ok(res.statusCode >= 400);
  await app.close();
});

// ─── per-request cache hit rate (distinct from token-weighted) ───────────────
// Seeds a dedicated provider with a controlled mix of rows so the arithmetic is
// exact and independent of the other fixtures above:
//   - 3 cacheable requests (prompt >= 1024 tokens), 2 of them actual cache hits
//   - 1 non-cacheable request (tiny prompt) that DID read cache -> must be
//     ignored by BOTH numerator and denominator (below the caching floor)
//   - 1 error (500) cacheable-size request with a cache read -> excluded (errors
//     carry estimated tokens and never touch the cache)
// Expected: cacheableRequests = 3, cacheHitRequests = 2, per-request = 0.6667.
// Token-weighted rate would be very different, proving the two are independent.
test('overview + cache: per-request hit rate counts cacheable requests, not tokens', async () => {
  const now2 = new Date();
  const fmt2 = (x: Date) => x.toISOString().slice(0, 19).replace('T', ' ');
  const p = 'kimi';
  const mdl = 'kimi-k2.7-code';
  // cacheable + HIT (input 2000, cache_read 30000 -> prompt 32000 >= 1024)
  ins.run(monitor.userId, 1, p, '/v1/kimi/chat/completions', mdl, 200, 2000, 100, 0, 30000, 0, 0.01, 500, 200, null, 'metered', 'k-1', fmt2(now2));
  // cacheable + HIT
  ins.run(monitor.userId, 1, p, '/v1/kimi/chat/completions', mdl, 200, 5000, 100, 0, 20000, 0, 0.01, 500, 200, null, 'metered', 'k-1', fmt2(now2));
  // cacheable + MISS (input 40000, cache_read 0 -> prompt 40000 >= 1024, no hit)
  ins.run(monitor.userId, 1, p, '/v1/kimi/chat/completions', mdl, 200, 40000, 100, 0, 0, 0, 0.05, 500, 200, null, 'metered', 'k-1', fmt2(now2));
  // NON-cacheable tiny prompt that still read cache (input 100, cache_read 50 ->
  // prompt 150 < 1024): must be excluded from both counts.
  ins.run(monitor.userId, 1, p, '/v1/kimi/chat/completions', mdl, 200, 100, 20, 0, 50, 0, 0.001, 300, 120, null, 'metered', 'k-1', fmt2(now2));
  // error (500) with cacheable size + cache read: must be excluded.
  ins.run(monitor.userId, 1, p, '/v1/kimi/chat/completions', mdl, 500, 30000, 0, 0, 5000, 0, 0, 400, null, null, 'metered', 'k-1', fmt2(now2));
  rollupHour(hourBucket(now2));
  rollupDay(dayBucket(now2));

  const app = await buildApp();
  const res = await app.inject({ method: 'GET', url: '/admin/metrics/overview?range=24h', headers: { 'x-admin-key': 'test-admin-key' } });
  const j = res.json();
  const kimi = j.providers.find((r: any) => r.provider === 'kimi');
  assert.ok(kimi, 'kimi provider row expected');
  assert.equal(kimi.cacheableRequests, 3, `cacheableRequests=${kimi.cacheableRequests}`);
  assert.equal(kimi.cacheHitRequests, 2, `cacheHitRequests=${kimi.cacheHitRequests}`);
  assert.equal(kimi.cacheHitRatePerRequest, 0.6667, `perRequest=${kimi.cacheHitRatePerRequest}`);
  // Kimi is SUBSET accounting: cache_read_tokens are already included in
  // input_tokens, so token-weighted hit rate is cache_read / input, NOT
  // cache_read / (input + cache_read).
  const kimiSubsetRate = Math.round((kimi.cacheReadTokens / kimi.inputTokens) * 10_000) / 10_000;
  assert.equal(kimi.cacheHitRate, kimiSubsetRate);
  assert.notEqual(kimi.cacheHitRate, kimi.cacheHitRatePerRequest);

  // Cache endpoint surfaces the same per-request numbers per model and the same
  // subset-aware token-weighted hit rate.
  const resC = await app.inject({ method: 'GET', url: '/admin/metrics/cache?range=24h', headers: { 'x-admin-key': 'test-admin-key' } });
  const rowC = resC.json().rows.find((r: any) => r.provider === 'kimi' && r.model === mdl);
  assert.ok(rowC, 'kimi cache row expected');
  assert.equal(rowC.cacheableRequests, 3);
  assert.equal(rowC.cacheHitRequests, 2);
  assert.equal(rowC.hitRatePerRequest, 0.6667);
  assert.equal(rowC.hitRate, kimiSubsetRate);

  // Timeseries uses the same provider-specific denominator for filtered rows.
  const resTs = await app.inject({ method: 'GET', url: `/admin/metrics/timeseries?metric=cache_hit_rate&range=24h&provider=${p}`, headers: { 'x-admin-key': 'test-admin-key' } });
  const tsValues = resTs.json().series.map((r: any) => r.value).filter((v: any) => v != null);
  assert.ok(tsValues.includes(kimiSubsetRate), JSON.stringify(tsValues));
  await app.close();
});

// /top must expose the honest per-request cache metric (matches #135 overview/
// per-provider) on Top-consumers rows, not just the token-weighted value. Relies
// on the kimi fixture seeded above (3 cacheable reqs, 2 hits -> 0.6667).
test('top provider rows include honest per-request cache hit rate', async () => {
  const app = await buildApp();
  const res = await app.inject({ method: 'GET', url: '/admin/metrics/top?dimension=provider&by=cost&range=24h', headers: { 'x-admin-key': 'test-admin-key' } });
  const j = res.json();
  const kimi = j.rows.find((r: any) => r.key === 'kimi');
  assert.ok(kimi, 'kimi top row expected');
  assert.equal(kimi.cacheableRequests, 3, `cacheableRequests=${kimi.cacheableRequests}`);
  assert.equal(kimi.cacheHitRequests, 2, `cacheHitRequests=${kimi.cacheHitRequests}`);
  assert.equal(kimi.cacheHitRatePerRequest, 0.6667, `perRequest=${kimi.cacheHitRatePerRequest}`);
  // token-weighted value is subset-aware for Kimi: cache_read / input.
  assert.equal(kimi.cacheHitRate, Math.round((kimi.cacheReadTokens / kimi.inputTokens) * 10_000) / 10_000);
  assert.notEqual(kimi.cacheHitRate, kimi.cacheHitRatePerRequest);

  // A provider with only tiny/non-cacheable prompts (gemini in base fixture) must
  // report cacheableRequests=0 and per-request=null (rendered as — in console).
  const gemini = j.rows.find((r: any) => r.key === 'gemini');
  if (gemini) {
    assert.equal(gemini.cacheableRequests, 0, `gemini cacheableRequests=${gemini.cacheableRequests}`);
    assert.equal(gemini.cacheHitRatePerRequest, null, 'gemini per-request must be null');
  }
  await app.close();
});

// ─── date-range boundaries: 2d preset + custom from/to (off-by-one guards) ───
// Seeds exactly one distinctly-priced flat-fee row on three separate past UTC
// days, each at 12:00 (mid-day, so no midnight-edge ambiguity), then verifies
// custom ranges include/exclude the right days. The three cost values are unique
// primes-ish so we can assert on the summed notional to the cent.
{
  const dayAt12 = (daysAgo: number) => {
    const d = new Date();
    d.setUTCHours(12, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - daysAgo);
    return d;
  };
  const fmtE = (x: Date) => x.toISOString().slice(0, 19).replace('T', ' ');
  const dateStr = (x: Date) => x.toISOString().slice(0, 10);
  const insE = db.prepare(`
    INSERT INTO usage_events (user_id, token_id, provider, endpoint, model, status_code,
      input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_creation_tokens,
      estimated_cost_usd, latency_ms, ttft_ms, unit, billing_mode, provider_account_label, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  // Use a unique provider so these rows don't perturb other tests' assertions.
  const d3 = dayAt12(3), d5 = dayAt12(5), d10 = dayAt12(10);
  insE.run(monitor.userId, 1, 'boundtest', '/v1/x', 'm', 200, 100, 10, 0, 0, 0, 3.00, 100, null, null, 'flat_fee', 'b-1', fmtE(d3));
  insE.run(monitor.userId, 1, 'boundtest', '/v1/x', 'm', 200, 100, 10, 0, 0, 0, 5.00, 100, null, null, 'flat_fee', 'b-1', fmtE(d5));
  insE.run(monitor.userId, 1, 'boundtest', '/v1/x', 'm', 200, 100, 10, 0, 0, 0, 7.00, 100, null, null, 'flat_fee', 'b-1', fmtE(d10));
  // Roll up each affected day + hour.
  for (const d of [d3, d5, d10]) { rollupHour(hourBucket(d)); rollupDay(dayBucket(d)); }

  const notionalFor = async (url: string): Promise<number> => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url, headers: { 'x-admin-key': 'test-admin-key' } });
    const j = res.json();
    await app.close();
    const bt = (j.providers || []).find((p: any) => p.provider === 'boundtest');
    return bt ? bt.cost.notional : 0;
  };

  test('custom range: to date is INCLUSIVE (no off-by-one)', async () => {
    // from=day5 to=day5 must capture exactly the $5 row (that single day).
    const from = dateStr(d5), to = dateStr(d5);
    const n = await notionalFor(`/admin/metrics/overview?range=custom&from=${from}&to=${to}`);
    assert.equal(n, 5, `single-day custom should be exactly $5, got ${n}`);
  });

  test('custom range: from..to spans inclusive endpoints', async () => {
    // from=day10 to=day3 must include all three rows ($7 + $5 + $3 = $15).
    const from = dateStr(d10), to = dateStr(d3);
    const n = await notionalFor(`/admin/metrics/overview?range=custom&from=${from}&to=${to}`);
    assert.equal(n, 15, `10..3 day span should sum $15, got ${n}`);
  });

  test('custom range: excludes the neighbouring days', async () => {
    // from=day5 to=day5 must EXCLUDE day3 ($3) and day10 ($7) — only $5.
    const from = dateStr(d5), to = dateStr(d5);
    const n = await notionalFor(`/admin/metrics/overview?range=custom&from=${from}&to=${to}`);
    assert.equal(n, 5, `neighbours must be excluded, got ${n}`);
  });

  test('custom range: from=day10 to=day5 includes 10 and 5 but not 3', async () => {
    // day10=$7, day5=$5 -> $12; day3=$3 excluded.
    const from = dateStr(d10), to = dateStr(d5);
    const n = await notionalFor(`/admin/metrics/overview?range=custom&from=${from}&to=${to}`);
    assert.equal(n, 12, `day10($7)+day5($5)=$12, excluding day3($3); got ${n}`);
  });

  test('2d preset resolves and excludes rows older than 48h', async () => {
    // The 3/5/10-day-old boundtest rows are all older than 48h, so 2d must be $0.
    const n = await notionalFor('/admin/metrics/overview?range=2d');
    assert.equal(n, 0, `2d must exclude all boundtest rows (>48h old), got ${n}`);
  });

  test('custom range rejects to < from', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/admin/metrics/overview?range=custom&from=${dateStr(d3)}&to=${dateStr(d10)}`, headers: { 'x-admin-key': 'test-admin-key' } });
    await app.close();
    assert.ok(res.statusCode >= 400, `to<from must be rejected, got ${res.statusCode}`);
  });

  test('custom range rejects missing dates', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/admin/metrics/overview?range=custom', headers: { 'x-admin-key': 'test-admin-key' } });
    await app.close();
    assert.ok(res.statusCode >= 400, `missing from/to must be rejected, got ${res.statusCode}`);
  });
}

// ─── retention fallback: last day from daily when hourly is pruned ───────────
// Simulates a long-lookback custom range: seed a full past day, roll up both
// hourly and daily, then DELETE the hourly rows (as retention would after
// monitorRetentionHourlyDays). A custom range covering that day must still
// return its totals from the kept-forever daily rollup — not silently zero.
{
  const dayAt = (daysAgo: number, hh: number) => { const d = new Date(); d.setUTCHours(hh, 0, 0, 0); d.setUTCDate(d.getUTCDate() - daysAgo); return d; };
  const fmtR = (x: Date) => x.toISOString().slice(0, 19).replace('T', ' ');
  const dstr = (x: Date) => x.toISOString().slice(0, 10);
  const insR = db.prepare(`
    INSERT INTO usage_events (user_id, token_id, provider, endpoint, model, status_code,
      input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_creation_tokens,
      estimated_cost_usd, latency_ms, ttft_ms, unit, billing_mode, provider_account_label, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  // 200 days ago (beyond 180-day hourly retention). The LAST day of a multi-day
  // custom window (>48h -> day interval) is what we prune, to prove the daily
  // fallback covers it. old = the window's last (most recent) day.
  const old = dayAt(200, 10);       // window end day
  const oldStart = dayAt(203, 10);  // window start day (3 days earlier)
  insR.run(monitor.userId, 1, 'prunetest', '/v1/x', 'm', 200, 100, 10, 0, 0, 0, 9.00, 100, null, null, 'flat_fee', 'p-1', fmtR(old));
  rollupHour(hourBucket(old));
  rollupDay(dayBucket(old));
  // Simulate retention pruning the hourly rollup for that old last day.
  db.prepare('DELETE FROM usage_rollup_hourly WHERE bucket = ?').run(hourBucket(old));

  test('custom range last day falls back to daily rollup when hourly pruned', async () => {
    const app = await buildApp();
    // Multi-day window (oldStart..old spans ~4 days) -> day interval, so the
    // last day (old) is composed from hourly and must fall back to daily.
    const res = await app.inject({ method: 'GET', url: `/admin/metrics/overview?range=custom&from=${dstr(oldStart)}&to=${dstr(old)}`, headers: { 'x-admin-key': 'test-admin-key' } });
    const j = res.json();
    await app.close();
    const pt = (j.providers || []).find((p: any) => p.provider === 'prunetest');
    assert.ok(pt, 'prunetest provider must survive hourly pruning via daily fallback');
    assert.equal(pt.cost.notional, 9, `expected $9 from daily fallback, got ${pt ? pt.cost.notional : 'none'}`);
  });

  test('in-progress today (day-interval) is served from hourly, not the daily fallback', async () => {
    // 7d uses the DAY interval, and its last day is the in-progress 'today'.
    // lastDayComplete is false, so the fallback must NOT fire — today comes from
    // hourly. The base fixture seeds anthropic in the current hour; a 7d range
    // must report exactly its 2 requests once (no double-count, no drop).
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/admin/metrics/overview?range=7d', headers: { 'x-admin-key': 'test-admin-key' } });
    const j = res.json();
    await app.close();
    const anth = j.providers.find((p: any) => p.provider === 'anthropic');
    assert.ok(anth, 'anthropic present in 7d');
    // 2 anthropic requests seeded in base fixture (one 200, one 429).
    assert.equal(anth.requests, 2, `anthropic requests should be exactly 2, got ${anth.requests}`);
  });
}

// ─── retention regressions: cache rollups + raw-only utilization ───────────
{
  const dayAt = (daysAgo: number, hh = 10) => { const d = new Date(); d.setUTCHours(hh, 0, 0, 0); d.setUTCDate(d.getUTCDate() - daysAgo); return d; };
  const dstr = (x: Date) => x.toISOString().slice(0, 10);
  const addDaily = (bucket: string, provider: string, model: string, input: number, read: number, write: number, saved: number, cacheable: number, hits: number) => {
    db.prepare(`
      INSERT INTO usage_rollup_daily (
        bucket, provider, model, user_id, billing_mode, requests,
        input_tokens, cache_read_tokens, cache_creation_tokens, cache_saved_usd,
        cacheable_requests, cache_hit_requests
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(bucket, provider, model, monitor.userId, 'flat_fee', cacheable, input, read, write, saved, cacheable, hits);
  };

  // Current window: old custom range whose last day has only the permanent daily
  // aggregate left. Previous equal-length trend window is also daily-only.
  const currentStart = dayAt(223);
  const currentEnd = dayAt(220);
  const prevLast = dayAt(224);
  addDaily(dstr(currentEnd), 'cacheprunetest', 'm-cache', 1_000, 3_000, 300, 1.25, 4, 3); // hitRate .75, per-request .75
  addDaily(dstr(prevLast), 'cacheprunetest', 'm-cache', 4_000, 1_000, 100, 0.50, 5, 1);   // hitRate .20, per-request .20
  db.prepare("DELETE FROM usage_rollup_hourly WHERE provider = 'cacheprunetest'").run();

  test('cache endpoint uses daily rollups when hourly retention pruned current and previous ranges', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/admin/metrics/cache?range=custom&from=${dstr(currentStart)}&to=${dstr(currentEnd)}`, headers: { 'x-admin-key': 'test-admin-key' } });
    assert.equal(res.statusCode, 200, res.body);
    const j = res.json();
    await app.close();
    const row = (j.rows || []).find((r: any) => r.provider === 'cacheprunetest');
    assert.ok(row, `cacheprunetest row expected, got ${JSON.stringify(j.rows)}`);
    assert.equal(row.cacheReadTokens, 3_000);
    assert.equal(row.cacheWriteTokens, 300);
    assert.equal(row.hitRate, 0.75);
    assert.equal(row.prevHitRate, 0.2);
    assert.equal(row.hitRatePerRequest, 0.75);
    assert.equal(row.prevHitRatePerRequest, 0.2);
  });

  test('utilization rejects ranges older than raw retention instead of returning incomplete per-account data', async () => {
    const prevEnabled = config.monitorRetentionEnabled;
    const prevRawDays = config.monitorRetentionRawDays;
    config.monitorRetentionEnabled = true;
    config.monitorRetentionRawDays = 30;
    try {
      const app = await buildApp();
      const res = await app.inject({ method: 'GET', url: `/admin/metrics/utilization?range=custom&from=${dstr(currentStart)}&to=${dstr(currentEnd)}`, headers: { 'x-admin-key': 'test-admin-key' } });
      await app.close();
      assert.equal(res.statusCode, 400, res.body);
      const j = res.json();
      assert.match(j.error, /Unsupported range/);
      assert.match(j.detail, /provider account labels/);
      assert.equal(j.rawRetentionDays, 30);
    } finally {
      config.monitorRetentionEnabled = prevEnabled;
      config.monitorRetentionRawDays = prevRawDays;
    }
  });
}
