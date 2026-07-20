import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const dbPath = path.join(os.tmpdir(), `model-gateway-codexres-${process.pid}-${Date.now()}.sqlite`);
process.env.DATABASE_PATH = dbPath;
process.env.DEV_ADMIN_KEY = 'test-admin';

const old = new Database(dbPath);
old.exec(`
  CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE provider_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL CHECK(provider IN ('anthropic','openai_codex','openai')),
    label TEXT NOT NULL,
    owner_email TEXT,
    secret TEXT NOT NULL,
    refresh_secret TEXT,
    account_id TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'active',
    max_in_flight INTEGER,
    cooldown_until INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL DEFAULT 0,
    last_used_at INTEGER NOT NULL DEFAULT 0,
    last_refresh_at INTEGER NOT NULL DEFAULT 0,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    risk_notes TEXT,
    quota_notes TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);
old.close();

const { migrate } = await import('./db/migrate.js');
const { getDb } = await import('./db/index.js');
const pool = await import('./providers/codex-pool.js');

migrate();
const db = getDb();

// Three codex accounts: 18 shared, 21 shared, 33 reserved.
const future = Date.now() + 3600_000;
const ins = db.prepare(`INSERT INTO provider_accounts (id,provider,label,secret,refresh_secret,account_id,enabled,status,max_in_flight,expires_at) VALUES (?,?,?,?,?,?,1,'active',50,?)`);
ins.run(18, 'openai_codex', 'shared-a', 'sec18', 'ref18', 'acc18', future);
ins.run(21, 'openai_codex', 'shared-b', 'sec21', 'ref21', 'acc21', future);
ins.run(33, 'openai_codex', 'yourdev.mail@gmail.com', 'sec33', 'ref33', 'acc33', future);

const reserved = ['reserved-user@example.com', 'teammate@example.com', 'partner@example.com'];
const insRes = db.prepare('INSERT INTO codex_account_reservations (account_id,email) VALUES (?,?)');
for (const e of reserved) insRes.run(33, e);

test('reserved account 33 is excluded for non-reserved users', () => {
  const ids = pool.selectCodexAccounts([], 'random@example.com').map((a) => a.id).sort();
  assert.deepEqual(ids, [18, 21]);
});

test('reserved account 33 is eligible only for reserved users', () => {
  for (const e of reserved) {
    const ids = pool.selectCodexAccounts([], e).map((a) => a.id).sort();
    assert.deepEqual(ids, [18, 21, 33], `expected ${e} to see 33`);
  }
});

test('reserved user gets account 33 as sticky primary (soft priority)', () => {
  for (const e of reserved) {
    const stickyKey = `${e}:tok:conv-1`;
    const ordered = pool.selectStickyCodexAccounts(stickyKey, [], e);
    assert.equal(ordered[0].id, 33, `expected ${e} primary to be 33`);
    // Fallback pool still includes the shared accounts.
    assert.deepEqual(ordered.map((a) => a.id).slice(1).sort(), [18, 21]);
  }
});

test('non-reserved user never gets 33 as primary or fallback', () => {
  const ordered = pool.selectStickyCodexAccounts('random@example.com:tok:conv-1', [], 'random@example.com');
  const ids = ordered.map((a) => a.id);
  assert.ok(!ids.includes(33), 'non-reserved must not see 33');
  assert.deepEqual([...ids].sort(), [18, 21]);
});

test('reserved user falls back to shared pool when 33 is cooled', () => {
  // Cool down 33.
  db.prepare("UPDATE provider_accounts SET status='cooldown', cooldown_until=? WHERE id=33").run(Date.now() + 3600_000);
  try {
    const ordered = pool.selectStickyCodexAccounts('reserved-user@example.com:tok:conv-2', [], 'reserved-user@example.com');
    const ids = ordered.map((a) => a.id).sort();
    assert.deepEqual(ids, [18, 21], 'should fall back to shared pool, 33 unavailable');
  } finally {
    db.prepare("UPDATE provider_accounts SET status='active', cooldown_until=0 WHERE id=33").run();
  }
});

test('email matching is case-insensitive and trimmed', () => {
  const ids = pool.selectCodexAccounts([], '  RESERVED-USER@example.com  ').map((a) => a.id).sort();
  assert.deepEqual(ids, [18, 21, 33]);
});

test('blank reservation row does not turn an account into dead weight', () => {
  // A fat-fingered empty reservation must be ignored: account 21 stays shared.
  db.prepare('INSERT INTO codex_account_reservations (account_id,email) VALUES (?,?)').run(21, '   ');
  try {
    const idsOther = pool.selectCodexAccounts([], 'random@example.com').map((a) => a.id).sort();
    assert.deepEqual(idsOther, [18, 21], 'blank row must not exclude 21 for everyone');
    const idsReserved = pool.selectCodexAccounts([], 'reserved-user@example.com').map((a) => a.id).sort();
    assert.deepEqual(idsReserved, [18, 21, 33]);
  } finally {
    db.prepare("DELETE FROM codex_account_reservations WHERE account_id=21 AND TRIM(email)=''").run();
  }
});
