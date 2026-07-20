import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';

process.env.DATABASE_PATH = path.join(os.tmpdir(), `nbmg-deepgram-${process.pid}.sqlite`);
process.env.DEV_ADMIN_KEY = 'test-admin-key';
process.env.DEEPGRAM_UPSTREAM_URL = 'https://deepgram.test/v1';

const { getDb } = await import('./db/index.js');
const { migrate } = await import('./db/migrate.js');
const { sha256 } = await import('./utils/crypto.js');
const { registerAdminApi } = await import('./admin/admin-api.js');
const { registerDeepgramProxy } = await import('./proxy/deepgram.js');

migrate();

function resetRuntimeTables() {
  const db = getDb();
  db.prepare('DELETE FROM request_logs').run();
  db.prepare('DELETE FROM provider_health_events').run();
  db.prepare('DELETE FROM usage_events').run();
  db.prepare('DELETE FROM user_provider_access_modes').run();
  db.prepare('DELETE FROM user_model_denies').run();
  db.prepare('DELETE FROM user_grants').run();
  db.prepare('DELETE FROM api_tokens').run();
  db.prepare('DELETE FROM users WHERE email != ?').run('admin@localhost');
  db.prepare('DELETE FROM provider_accounts').run();
}

function seedUserAndToken(raw = 'nbmg_deepgram_token') {
  const db = getDb();
  const userId = Number(db.prepare("INSERT INTO users (email,role,is_admin,enabled) VALUES ('dev@example.com','developer',0,1)").run().lastInsertRowid);
  const tokenId = Number(db.prepare('INSERT INTO api_tokens (user_id,label,token_hash,token_prefix,enabled) VALUES (?,?,?,?,1)').run(userId, 'dev-token', sha256(raw), raw.slice(0, 14)).lastInsertRowid);
  return { raw, userId, tokenId };
}

function seedDeepgram(label = 'dg1', secret = 'dg_test') {
  return Number(getDb().prepare("INSERT INTO provider_accounts (provider,label,secret,status,enabled) VALUES ('deepgram',?,?, 'active',1)").run(label, secret).lastInsertRowid);
}

test('migration allows provider=deepgram and admin can create account', async () => {
  resetRuntimeTables();
  assert.ok(getDb().prepare('SELECT version FROM schema_migrations WHERE version=?').get(2026051804));
  assert.doesNotThrow(() => seedDeepgram('direct'));
  resetRuntimeTables();
  const app = Fastify();
  registerAdminApi(app);
  const res = await app.inject({ method: 'POST', url: '/admin/provider-accounts', headers: { 'x-admin-key': 'test-admin-key' }, payload: { provider: 'deepgram', label: 'deepgram-1', secret: 'dg_x' } });
  assert.equal(res.statusCode, 200, res.body);
  const row = getDb().prepare("SELECT provider,max_in_flight FROM provider_accounts WHERE label='deepgram-1'").get() as any;
  assert.equal(row.provider, 'deepgram');
  assert.equal(row.max_in_flight, 45);
});

test('Deepgram route rejects unknown models before upstream', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken();
  seedDeepgram();
  let calls = 0;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => { calls += 1; return new Response('{}', { status: 200 }); };
  const app = Fastify();
  registerDeepgramProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/deepgram/listen?model=expensive-unknown', headers: { authorization: `Bearer ${token.raw}`, 'content-type': 'application/json' }, payload: { url: 'https://example.com/a.wav' } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().error.code, 'model_not_allowed_for_user');
  assert.equal(calls, 0);
});

test('Deepgram route forwards allowed URL transcription and records duration seconds', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_deepgram_allowed');
  seedDeepgram('allowed');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'deepgram', 'allow_all');
  let seenUrl = '';
  let seenAuth = '';
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: string, init: any) => {
    seenUrl = String(url);
    seenAuth = init.headers.authorization;
    return new Response(JSON.stringify({ metadata: { duration: 12.4 }, results: { channels: [{ alternatives: [{ transcript: 'hello world' }] }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = Fastify();
  registerDeepgramProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/deepgram/listen?model=nova-3', headers: { authorization: `Bearer ${token.raw}`, 'content-type': 'application/json' }, payload: { url: 'https://example.com/a.wav' } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.match(seenUrl, /model=nova-3/);
  assert.match(seenUrl, /smart_format=true/);
  assert.match(seenAuth, /^Token /);
  const ev = getDb().prepare("SELECT provider,model,input_tokens,output_tokens,estimated_cost_usd FROM usage_events WHERE provider='deepgram' ORDER BY id DESC LIMIT 1").get() as any;
  assert.equal(ev.model, 'nova-3');
  assert.equal(ev.input_tokens, 13);
  assert.equal(ev.output_tokens, 0);
  assert.equal(ev.estimated_cost_usd, 0);
});

test('Deepgram deny_all blocks allowed models', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_deepgram_denied');
  seedDeepgram('denied');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'deepgram', 'deny_all');
  const app = Fastify();
  registerDeepgramProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/deepgram/listen?model=nova-3', headers: { authorization: `Bearer ${token.raw}`, 'content-type': 'application/json' }, payload: { url: 'https://example.com/a.wav' } });
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().error.code, 'model_not_allowed_for_user');
});
