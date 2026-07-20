import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';

process.env.DATABASE_PATH = path.join(os.tmpdir(), `nbmg-grants-${process.pid}.sqlite`);
process.env.DEV_ADMIN_KEY = 'test-admin-key';
process.env.GROQ_UPSTREAM_URL = 'https://groq.test/openai/v1';
process.env.ANTHROPIC_UPSTREAM_URL = 'https://anthropic.test';

const { getDb } = await import('./db/index.js');
const { migrate } = await import('./db/migrate.js');
const { sha256 } = await import('./utils/crypto.js');
const { registerAdminApi } = await import('./admin/admin-api.js');
const { registerGroqProxy } = await import('./proxy/groq.js');
const { registerAnthropicProxy } = await import('./proxy/anthropic.js');
const { checkLooseLimit, findActiveGrant } = await import('./proxy/policy.js');

migrate();

function reset() {
  const db = getDb();
  db.exec('DELETE FROM user_grants');
  db.exec('DELETE FROM request_logs');
  db.exec('DELETE FROM provider_health_events');
  db.exec('DELETE FROM groq_model_cooldowns');
  db.exec('DELETE FROM groq_usage_buckets');
  db.exec('DELETE FROM groq_limits');
  db.exec('DELETE FROM usage_events');
  db.exec('DELETE FROM user_limits');
  db.exec('DELETE FROM role_limits');
  db.exec('DELETE FROM api_tokens');
  db.exec("DELETE FROM users WHERE email != 'daxitm2112@gmail.com'");
  db.exec('DELETE FROM provider_accounts');
}

function seedUser(email = 'cap@example.com', role: 'admin' | 'founder' | 'developer' | 'member' = 'developer') {
  return Number(getDb().prepare('INSERT INTO users (email,role,is_admin,enabled) VALUES (?,?,0,1)').run(email, role).lastInsertRowid);
}

function seedToken(userId: number, raw = 'nbmg_grant_test_token', label = 'g', capUsdDaily: number | null = null) {
  const tokenId = Number(
    getDb()
      .prepare('INSERT INTO api_tokens (user_id,label,token_hash,token_prefix,enabled,cap_usd_daily) VALUES (?,?,?,?,1,?)')
      .run(userId, label, sha256(raw), raw.slice(0, 14), capUsdDaily)
      .lastInsertRowid,
  );
  return { tokenId, raw };
}

function seedProviderAccount(provider: string, label: string, secret = 'sk_test_' + provider) {
  return Number(
    getDb()
      .prepare("INSERT INTO provider_accounts (provider,label,secret,status,enabled) VALUES (?,?,?, 'active',1)")
      .run(provider, label, secret).lastInsertRowid,
  );
}

test('migration adds user_grants table and active index', () => {
  const row = getDb().prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='user_grants'").get() as any;
  assert.ok(row, 'user_grants table missing');
  assert.match(row.sql, /valid_from/);
  assert.match(row.sql, /valid_until/);
  const idx = getDb().prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_user_grants_active'").get() as any;
  assert.ok(idx, 'idx_user_grants_active missing');
  assert.ok(getDb().prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(2026051502), 'migration row missing');
});

test('admin API: POST /admin/grants creates a grant; GET lists it; PATCH and DELETE work', async () => {
  reset();
  const userId = seedUser('grants-crud@example.com');
  const app = Fastify();
  registerAdminApi(app);

  const validUntil = Date.now() + 3600_000;
  const create = await app.inject({
    method: 'POST',
    url: '/admin/grants',
    headers: { 'x-admin-key': 'test-admin-key' },
    payload: { userId, provider: 'groq', modelPattern: '*', validUntil, reason: 'pilot' },
  });
  assert.equal(create.statusCode, 200, create.body);
  const created = JSON.parse(create.body);
  assert.ok(created.id);
  assert.equal(created.grant.status, 'active');

  const list = await app.inject({ method: 'GET', url: `/admin/grants?userId=${userId}`, headers: { 'x-admin-key': 'test-admin-key' } });
  assert.equal(list.statusCode, 200);
  const listed = JSON.parse(list.body).grants;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].active, true);
  assert.equal(listed[0].email, 'grants-crud@example.com');
  assert.equal(listed[0].provider, 'groq');

  const patched = await app.inject({
    method: 'PATCH',
    url: `/admin/grants/${created.id}`,
    headers: { 'x-admin-key': 'test-admin-key' },
    payload: { dailyUsd: 5, reason: 'tightened' },
  });
  assert.equal(patched.statusCode, 200, patched.body);
  assert.equal(JSON.parse(patched.body).grant.daily_usd, 5);

  // validUntil rejection: in the past
  const badPatch = await app.inject({
    method: 'PATCH', url: `/admin/grants/${created.id}`,
    headers: { 'x-admin-key': 'test-admin-key' },
    payload: { validUntil: Date.now() - 1000 },
  });
  assert.equal(badPatch.statusCode, 400);

  // validUntil rejection on create: must be in future
  const badCreate = await app.inject({
    method: 'POST', url: '/admin/grants',
    headers: { 'x-admin-key': 'test-admin-key' },
    payload: { userId, provider: 'groq', validUntil: Date.now() - 1000 },
  });
  assert.equal(badCreate.statusCode, 400);

  // > 30d rejected
  const tooLong = await app.inject({
    method: 'POST', url: '/admin/grants',
    headers: { 'x-admin-key': 'test-admin-key' },
    payload: { userId, provider: 'groq', validUntil: Date.now() + 40 * 24 * 3600 * 1000 },
  });
  assert.equal(tooLong.statusCode, 400);

  const del = await app.inject({ method: 'DELETE', url: `/admin/grants/${created.id}`, headers: { 'x-admin-key': 'test-admin-key' } });
  assert.equal(del.statusCode, 200);
  const after = await app.inject({ method: 'GET', url: '/admin/grants', headers: { 'x-admin-key': 'test-admin-key' } });
  assert.equal(JSON.parse(after.body).grants.length, 0);
});

test('policy: active unlimited grant lets capped user through (groq end-to-end)', async () => {
  reset();
  const userId = seedUser('grantee@example.com', 'developer');
  const { raw } = seedToken(userId);
  seedProviderAccount('groq', 'g-test');
  // Hard cap the role at $0/day so without a grant the request is blocked.
  getDb().prepare('INSERT INTO role_limits (role,provider,daily_usd) VALUES (?,?,?)').run('developer', 'groq', 0.0001);
  // Seed a usage event to push usage > cap (so cap is actively triggered).
  getDb().prepare(`INSERT INTO usage_events (user_id,token_id,provider,endpoint,model,estimated_cost_usd,input_tokens) VALUES (?,?,?,?,?,?,?)`)
    .run(userId, null, 'groq', '/v1/groq/chat/completions', 'openai/gpt-oss-120b', 5.0, 100);

  // Without grant: blocked
  const blocked = checkLooseLimit({ id: userId, role: 'developer' }, 'groq');
  assert.equal(blocked.ok, false);

  // Now add an unlimited grant.
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(userId, 'groq', 'allow_all');
  getDb().prepare(`INSERT INTO user_grants (user_id, provider, model_pattern, daily_usd, daily_tokens, valid_from, valid_until)
                  VALUES (?,?,?,?,?,?,?)`).run(userId, 'groq', '*', null, null, Date.now() - 1000, Date.now() + 3600_000);

  // With grant: through
  const ok = checkLooseLimit({ id: userId, role: 'developer' }, 'groq', undefined, 'openai/gpt-oss-120b');
  assert.equal(ok.ok, true);

  // End-to-end through groq proxy.
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => new Response(JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  const app = Fastify();
  registerGroqProxy(app);
  const res = await app.inject({
    method: 'POST',
    url: '/v1/groq/chat/completions',
    headers: { authorization: `Bearer ${raw}` },
    payload: { model: 'openai/gpt-oss-120b', messages: [{ role: 'user', content: 'hi' }] },
  });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
});

test('policy: no active grant means capped user is still rejected', () => {
  reset();
  const userId = seedUser('still-capped@example.com', 'developer');
  getDb().prepare('INSERT INTO role_limits (role,provider,daily_usd) VALUES (?,?,?)').run('developer', 'anthropic', 0.0001);
  getDb().prepare(`INSERT INTO usage_events (user_id,provider,endpoint,model,estimated_cost_usd) VALUES (?,?,?,?,?)`)
    .run(userId, 'anthropic', '/v1/messages', 'claude-haiku', 1.0);
  const decision = checkLooseLimit({ id: userId, role: 'developer' }, 'anthropic', undefined, 'claude-haiku');
  assert.equal(decision.ok, false);
});

test('policy: expired grant does not bypass the cap', () => {
  reset();
  const userId = seedUser('expired@example.com', 'developer');
  getDb().prepare('INSERT INTO role_limits (role,provider,daily_usd) VALUES (?,?,?)').run('developer', 'anthropic', 0.0001);
  getDb().prepare(`INSERT INTO usage_events (user_id,provider,endpoint,model,estimated_cost_usd) VALUES (?,?,?,?,?)`)
    .run(userId, 'anthropic', '/v1/messages', 'claude-opus-4-7', 1.0);
  // Grant expired 1 hour ago.
  getDb().prepare(`INSERT INTO user_grants (user_id, provider, model_pattern, valid_from, valid_until)
                  VALUES (?,?,?,?,?)`).run(userId, 'anthropic', '*', Date.now() - 7200_000, Date.now() - 3600_000);
  assert.equal(findActiveGrant(userId, 'anthropic', 'claude-opus-4-7'), null);
  const decision = checkLooseLimit({ id: userId, role: 'developer' }, 'anthropic', undefined, 'claude-opus-4-7');
  assert.equal(decision.ok, false);
});

test('policy: exact model_pattern grant allows that model only', () => {
  reset();
  const userId = seedUser('exact@example.com', 'developer');
  getDb().prepare('INSERT INTO role_limits (role,provider,daily_usd) VALUES (?,?,?)').run('developer', 'anthropic', 0.0001);
  getDb().prepare(`INSERT INTO usage_events (user_id,provider,endpoint,model,estimated_cost_usd) VALUES (?,?,?,?,?)`)
    .run(userId, 'anthropic', '/v1/messages', 'claude-opus-4-7', 1.0);
  getDb().prepare(`INSERT INTO user_grants (user_id, provider, model_pattern, valid_from, valid_until)
                  VALUES (?,?,?,?,?)`).run(userId, 'anthropic', 'claude-opus-4-7', Date.now() - 1000, Date.now() + 3600_000);

  const opus = checkLooseLimit({ id: userId, role: 'developer' }, 'anthropic', undefined, 'claude-opus-4-7');
  assert.equal(opus.ok, true);

  const haiku = checkLooseLimit({ id: userId, role: 'developer' }, 'anthropic', undefined, 'claude-haiku-4');
  assert.equal(haiku.ok, false, 'haiku must still be blocked when only opus is granted');
});

test('policy: token-level cap still wins over a generous grant (explicit guardrail)', () => {
  reset();
  const userId = seedUser('token-cap@example.com', 'developer');
  const { tokenId } = seedToken(userId, 'nbmg_tcap_overrides_grant', 'tcap', /*capUsdDaily*/ 0.0001);
  // Spend already over the token cap.
  getDb().prepare(`INSERT INTO usage_events (user_id,token_id,provider,endpoint,model,estimated_cost_usd) VALUES (?,?,?,?,?,?)`)
    .run(userId, tokenId, 'kimi', '/v1/kimi/chat/completions', 'kimi-k2.6', 5.0);
  // Generous unlimited grant.
  getDb().prepare(`INSERT INTO user_grants (user_id, provider, model_pattern, valid_from, valid_until)
                  VALUES (?,?,?,?,?)`).run(userId, 'kimi', '*', Date.now() - 1000, Date.now() + 3600_000);

  const decision = checkLooseLimit({ id: userId, role: 'developer' }, 'kimi', { id: tokenId }, 'kimi-k2.6');
  assert.equal(decision.ok, false, 'token cap should win even with a grant in place');
  assert.match((decision as any).message, /Token-level/);
});

test('admin /admin/users surfaces activeGrantCount per user', async () => {
  reset();
  const userId = seedUser('badge@example.com', 'developer');
  getDb().prepare(`INSERT INTO user_grants (user_id, provider, model_pattern, valid_from, valid_until)
                  VALUES (?,?,?,?,?)`).run(userId, 'anthropic', '*', Date.now() - 1000, Date.now() + 3600_000);
  getDb().prepare(`INSERT INTO user_grants (user_id, provider, model_pattern, valid_from, valid_until)
                  VALUES (?,?,?,?,?)`).run(userId, 'groq', 'openai/gpt-oss-120b', Date.now() - 1000, Date.now() + 3600_000);
  // Expired one — should not count.
  getDb().prepare(`INSERT INTO user_grants (user_id, provider, model_pattern, valid_from, valid_until)
                  VALUES (?,?,?,?,?)`).run(userId, 'kimi', '*', Date.now() - 7200_000, Date.now() - 3600_000);

  const app = Fastify();
  registerAdminApi(app);
  const res = await app.inject({ method: 'GET', url: '/admin/users', headers: { 'x-admin-key': 'test-admin-key' } });
  assert.equal(res.statusCode, 200);
  const u = JSON.parse(res.body).users.find((x: any) => x.email === 'badge@example.com');
  assert.equal(u.activeGrantCount, 2);
});
