import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DATABASE_PATH = path.join(os.tmpdir(), `model-gateway-codexbucket-${process.pid}-${Date.now()}.sqlite`);
process.env.DEV_ADMIN_KEY = 'test-admin';

const { migrate } = await import('./db/migrate.js');
const { getDb } = await import('./db/index.js');
const pool = await import('./providers/codex-pool.js');

migrate();
const db = getDb();

function resetRuntimeTables() {
  db.prepare('DELETE FROM codex_bucket_cooldowns').run();
  db.prepare('DELETE FROM codex_account_reservations').run();
  db.prepare('DELETE FROM provider_health_events').run();
  db.prepare('DELETE FROM provider_accounts').run();
}

function seedCodex(label: string, email?: string) {
  const future = Date.now() + 3600_000;
  const id = Number(db.prepare(`
    INSERT INTO provider_accounts (provider,label,secret,refresh_secret,account_id,enabled,status,max_in_flight,expires_at)
    VALUES ('openai_codex',?,?,?,?,1,'active',50,?)
  `).run(label, `sec-${label}`, `ref-${label}`, `acc-${label}`, future).lastInsertRowid);
  if (email) db.prepare('INSERT INTO codex_account_reservations (account_id,email) VALUES (?,?)').run(id, email);
  return id;
}

function account(id: number) {
  return db.prepare('SELECT id,provider,label,secret,refresh_secret,account_id,expires_at,max_in_flight,status,cooldown_until,last_used_at FROM provider_accounts WHERE id=?').get(id) as any;
}

function sortIds(ids: number[]) {
  return ids.sort((a, b) => a - b);
}

test('migration creates Codex bucket cooldown table and records latest version', () => {
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='codex_bucket_cooldowns'").get());
  assert.ok(db.prepare('SELECT version FROM schema_migrations WHERE version=?').get(2026060101));
});

test('spark usage-limit cooldown excludes only the spark bucket on that account', () => {
  resetRuntimeTables();
  const a = seedCodex('a');
  const b = seedCodex('b');

  pool.markCodexBucketRateLimited(account(a), 'gpt-5.3-codex-spark', 60_000, 'spark usage limit', Math.floor(Date.now() / 1000) + 60);

  assert.deepEqual(pool.selectCodexAccounts([], undefined, 'gpt-5.3-codex-spark').map((x) => x.id), [b]);
  assert.deepEqual(sortIds(pool.selectCodexAccounts([], undefined, 'gpt-5.5').map((x) => x.id)), [a, b]);
  assert.deepEqual(sortIds(pool.selectCodexAccounts([], undefined, 'gpt-5.4-mini').map((x) => x.id)), [a, b]);

  const row = db.prepare('SELECT bucket,reason,resets_at FROM codex_bucket_cooldowns WHERE account_id=?').get(a) as any;
  assert.equal(row.bucket, 'spark');
  assert.equal(row.reason, 'spark usage limit');
  assert.equal((db.prepare('SELECT status,cooldown_until FROM provider_accounts WHERE id=?').get(a) as any).status, 'active');
});

test('legacy account-level rate_limited status does not over-cool Codex buckets', () => {
  resetRuntimeTables();
  const a = seedCodex('a');
  const b = seedCodex('b');
  db.prepare("UPDATE provider_accounts SET status='rate_limited', cooldown_until=? WHERE id=?").run(Date.now() + 3600_000, a);

  assert.deepEqual(sortIds(pool.selectCodexAccounts([], undefined, 'gpt-5.5').map((x) => x.id)), [a, b]);
  assert.deepEqual(sortIds(pool.selectCodexAccounts([], undefined, 'gpt-5.3-codex-spark').map((x) => x.id)), [a, b]);
});

test('main-model cooldown excludes all main models on that account but leaves spark flowing', () => {
  resetRuntimeTables();
  const a = seedCodex('a');
  const b = seedCodex('b');

  pool.markCodexBucketRateLimited(account(a), 'gpt-5.5', 60_000, 'main usage limit');

  assert.deepEqual(pool.selectCodexAccounts([], undefined, 'gpt-5.5').map((x) => x.id), [b]);
  assert.deepEqual(pool.selectCodexAccounts([], undefined, 'gpt-5.4-mini').map((x) => x.id), [b]);
  assert.deepEqual(pool.selectCodexAccounts([], undefined, 'gpt-5.3-codex').map((x) => x.id), [b]);
  assert.deepEqual(sortIds(pool.selectCodexAccounts([], undefined, 'gpt-5.3-codex-spark').map((x) => x.id)), [a, b]);
});

test('resets_in_seconds and resets_at are honored and clamped to 1s-6h', () => {
  const now = 1_780_000_000_000;
  const seconds = pool.classifyCodexUpstreamError(429, JSON.stringify({ error: { type: 'usage_limit_reached', resets_in_seconds: 15100 } }), now);
  assert.equal(seconds.kind, 'rate_limit');
  assert.equal(seconds.quotaExhausted, true);
  assert.equal(seconds.cooldownMs, 15_100_000);
  assert.equal(seconds.resetsAt, Math.floor((now + 15_100_000) / 1000));

  const at = pool.classifyCodexUpstreamError(429, JSON.stringify({ error: { type: 'usage_limit_reached', resets_at: (now / 1000) + 10 } }), now);
  assert.equal(at.cooldownMs, 10_000);
  assert.equal(at.resetsAt, (now / 1000) + 10);

  const max = pool.classifyCodexUpstreamError(429, JSON.stringify({ error: { type: 'usage_limit_reached', resets_in_seconds: 999999 } }), now);
  assert.equal(max.cooldownMs, 6 * 60 * 60 * 1000);

  const min = pool.classifyCodexUpstreamError(429, JSON.stringify({ error: { type: 'usage_limit_reached', resets_at: (now / 1000) - 10 } }), now);
  assert.equal(min.cooldownMs, 1_000);
});

test('burst 429 without reset fields uses short cooldown on requested bucket only', () => {
  resetRuntimeTables();
  const a = seedCodex('a');
  const b = seedCodex('b');
  const cls = pool.classifyCodexUpstreamError(429, '{"error":{"message":"Too many requests"}}');
  assert.equal(cls.cooldownMs, 45_000);
  assert.equal(cls.resetsAt, undefined);

  pool.markCodexBucketRateLimited(account(a), 'gpt-5.3-codex-spark', cls.cooldownMs!, 'burst 429', cls.resetsAt);
  assert.deepEqual(pool.selectCodexAccounts([], undefined, 'gpt-5.3-codex-spark').map((x) => x.id), [b]);
  assert.deepEqual(sortIds(pool.selectCodexAccounts([], undefined, 'gpt-5.5').map((x) => x.id)), [a, b]);
});

test('reservation filtering and sticky priority still work with bucket cooldowns', () => {
  resetRuntimeTables();
  const sharedA = seedCodex('shared-a');
  const sharedB = seedCodex('shared-b');
  const reserved = seedCodex('reserved', 'dev@example.com');

  pool.markCodexBucketRateLimited(account(reserved), 'gpt-5.3-codex-spark', 60_000, 'spark only');
  assert.equal(pool.selectStickyCodexAccounts('dev@example.com:tok:conv', [], 'dev@example.com', 'gpt-5.5')[0].id, reserved);
  assert.deepEqual(sortIds(pool.selectStickyCodexAccounts('dev@example.com:tok:conv', [], 'dev@example.com', 'gpt-5.3-codex-spark').map((x) => x.id)), [sharedA, sharedB]);

  pool.markCodexBucketRateLimited(account(reserved), 'gpt-5.5', 60_000, 'main too');
  assert.deepEqual(sortIds(pool.selectStickyCodexAccounts('dev@example.com:tok:conv', [], 'dev@example.com', 'gpt-5.4-mini').map((x) => x.id)), [sharedA, sharedB]);
  assert.deepEqual(sortIds(pool.selectStickyCodexAccounts('other@example.com:tok:conv', [], 'other@example.com', 'gpt-5.5').map((x) => x.id)), [sharedA, sharedB]);
});

test('Codex bucket cooldowns do not mutate non-Codex provider account cooldowns', () => {
  resetRuntimeTables();
  const codex = seedCodex('codex');
  const openai = Number(db.prepare("INSERT INTO provider_accounts (provider,label,secret,status,enabled,cooldown_until) VALUES ('openai','api-key','sk','active',1,0)").run().lastInsertRowid);

  pool.markCodexBucketRateLimited(account(codex), 'gpt-5.5', 60_000, 'codex only');

  const nonCodex = db.prepare('SELECT status,cooldown_until,consecutive_failures FROM provider_accounts WHERE id=?').get(openai) as any;
  assert.deepEqual(nonCodex, { status: 'active', cooldown_until: 0, consecutive_failures: 0 });
});

test('getCodexBucketCooldownSnapshot returns active cooldowns grouped by account', () => {
  resetRuntimeTables();
  const a = seedCodex('a');
  const b = seedCodex('b');
  // Active main cooldown on a; expired cooldown on b should be excluded.
  pool.markCodexBucketRateLimited(account(a), 'gpt-5.5', 60_000, 'main usage limit', Math.floor(Date.now() / 1000) + 60);
  db.prepare('INSERT INTO codex_bucket_cooldowns (account_id,bucket,cooldown_until,reason,resets_at) VALUES (?,?,?,?,?)')
    .run(b, 'main', Date.now() - 1000, 'expired', null);

  const snap = pool.getCodexBucketCooldownSnapshot();
  assert.ok(snap[a] && snap[a].length === 1);
  assert.equal(snap[a][0].bucket, 'main');
  assert.equal(snap[a][0].reason, 'main usage limit');
  assert.equal(snap[b], undefined);
});

test('clearCodexCooldowns removes bucket cooldowns and reactivates the account', () => {
  resetRuntimeTables();
  const a = seedCodex('a');
  pool.markCodexBucketRateLimited(account(a), 'gpt-5.5', 60_000, 'main usage limit');
  pool.markCodexBucketRateLimited(account(a), 'gpt-5.3-codex-spark', 60_000, 'spark usage limit');
  assert.equal((db.prepare('SELECT COUNT(*) n FROM codex_bucket_cooldowns WHERE account_id=?').get(a) as any).n, 2);

  const cleared = pool.clearCodexCooldowns(a);
  assert.equal(cleared, 2);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM codex_bucket_cooldowns WHERE account_id=?').get(a) as any).n, 0);
  // Account is selectable again for any bucket.
  assert.deepEqual(pool.selectCodexAccounts([], undefined, 'gpt-5.5').map((x) => x.id), [a]);
  const row = db.prepare('SELECT cooldown_until,consecutive_failures FROM provider_accounts WHERE id=?').get(a) as any;
  assert.equal(row.cooldown_until, 0);
  assert.equal(row.consecutive_failures, 0);
});
