import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';

process.env.DATABASE_PATH = path.join(os.tmpdir(), `nbmg-openrouter-${process.pid}.sqlite`);
process.env.DEV_ADMIN_KEY = 'test-admin-key';
process.env.OPENROUTER_UPSTREAM_URL = 'https://openrouter.test/api/v1';

const { getDb } = await import('./db/index.js');
const { migrate } = await import('./db/migrate.js');
const { sha256 } = await import('./utils/crypto.js');
const { registerAdminApi } = await import('./admin/admin-api.js');
const { registerOpenRouterProxy } = await import('./proxy/openrouter.js');

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

function seedUserAndToken(raw = 'nbmg_openrouter_token') {
  const db = getDb();
  const userId = Number(db.prepare("INSERT INTO users (email,role,is_admin,enabled) VALUES ('dev@example.com','developer',0,1)").run().lastInsertRowid);
  const tokenId = Number(db.prepare('INSERT INTO api_tokens (user_id,label,token_hash,token_prefix,enabled) VALUES (?,?,?,?,1)').run(userId, 'dev-token', sha256(raw), raw.slice(0, 14)).lastInsertRowid);
  return { raw, userId, tokenId };
}

function seedOpenRouter(label = 'or1', secret = 'sk-or-test') {
  return Number(getDb().prepare("INSERT INTO provider_accounts (provider,label,secret,status,enabled) VALUES ('openrouter',?,?, 'active',1)").run(label, secret).lastInsertRowid);
}

test('migration allows provider=openrouter and admin can create account', async () => {
  resetRuntimeTables();
  assert.ok(getDb().prepare('SELECT version FROM schema_migrations WHERE version=?').get(2026051803));
  assert.doesNotThrow(() => seedOpenRouter('direct'));
  resetRuntimeTables();
  const app = Fastify();
  registerAdminApi(app);
  const res = await app.inject({ method: 'POST', url: '/admin/provider-accounts', headers: { 'x-admin-key': 'test-admin-key' }, payload: { provider: 'openrouter', label: 'openrouter-1', secret: 'sk-or-x' } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal((getDb().prepare("SELECT provider FROM provider_accounts WHERE label='openrouter-1'").get() as any).provider, 'openrouter');
});

test('OpenRouter route rejects unknown models before upstream', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken();
  seedOpenRouter();
  let calls = 0;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => { calls += 1; return new Response('{}', { status: 200 }); };
  const app = Fastify();
  registerOpenRouterProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/openrouter/chat/completions', headers: { authorization: `Bearer ${token.raw}` }, payload: { model: 'anthropic/claude-opus-4.5', messages: [{ role: 'user', content: 'hi' }] } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().error.code, 'model_not_allowed_for_user');
  assert.equal(calls, 0);
});

test('OpenRouter route forwards public HY3 free model and records zero cost', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_openrouter_allowed');
  seedOpenRouter('allowed');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'openrouter', 'allow_all');
  let seenBody: any;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (_url: string, init: any) => {
    seenBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ id: 'cmpl', choices: [], usage: { prompt_tokens: 10, completion_tokens: 20 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = Fastify();
  registerOpenRouterProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/openrouter/chat/completions', headers: { authorization: `Bearer ${token.raw}` }, payload: { model: 'tencent/hy3:free', messages: [{ role: 'user', content: 'hi' }] } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(seenBody.model, 'tencent/hy3:free');
  const ev = getDb().prepare("SELECT provider,model,input_tokens,output_tokens,estimated_cost_usd FROM usage_events WHERE provider='openrouter' ORDER BY id DESC LIMIT 1").get() as any;
  assert.equal(ev.model, 'tencent/hy3:free');
  assert.equal(ev.input_tokens, 10);
  assert.equal(ev.output_tokens, 20);
  assert.equal(ev.estimated_cost_usd, 0);
});

test('OpenRouter defaults omitted model to public HY3 free model', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_openrouter_default_hy3');
  seedOpenRouter('default-hy3');
  let seenBody: any;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (_url: string, init: any) => {
    seenBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ id: 'cmpl', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = Fastify();
  registerOpenRouterProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/openrouter/chat/completions', headers: { authorization: `Bearer ${token.raw}` }, payload: { messages: [{ role: 'user', content: 'hi' }] } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(seenBody.model, 'tencent/hy3:free');
});

test('OpenRouter deny_all blocks public HY3 model', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_openrouter_denied');
  seedOpenRouter('denied');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'openrouter', 'deny_all');
  const app = Fastify();
  registerOpenRouterProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/openrouter/chat/completions', headers: { authorization: `Bearer ${token.raw}` }, payload: { model: 'tencent/hy3:free', messages: [{ role: 'user', content: 'hi' }] } });
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().error.code, 'model_not_allowed_for_user');
});

test('OpenRouter content_filter is surfaced and force-logged', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_openrouter_filter');
  seedOpenRouter('filter');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'openrouter', 'allow_all');
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => new Response(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'content_filter' }], usage: { prompt_tokens: 5, completion_tokens: 0 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  const app = Fastify();
  registerOpenRouterProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/openrouter/chat/completions', headers: { authorization: `Bearer ${token.raw}` }, payload: { model: 'tencent/hy3:free', messages: [{ role: 'user', content: 'blocked' }] } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().choices[0].message.content, '⛔ openrouter safety filter blocked this response (content_filter).');
  const log = getDb().prepare('SELECT request_json FROM request_logs ORDER BY id DESC LIMIT 1').get() as any;
  assert.equal(JSON.parse(log.request_json).forcedLogReason, 'openrouter_content_filter');
});

test('OpenRouter length finish_reason appends truncation marker without force-log', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_openrouter_length');
  seedOpenRouter('length');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'openrouter', 'allow_all');
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => new Response(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'partial' }, finish_reason: 'length' }], usage: { prompt_tokens: 5, completion_tokens: 3 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  const app = Fastify();
  registerOpenRouterProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/openrouter/chat/completions', headers: { authorization: `Bearer ${token.raw}` }, payload: { model: 'tencent/hy3:free', messages: [{ role: 'user', content: 'long' }] } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().choices[0].message.content, 'partial\n\n[truncated: length]');
  assert.equal((getDb().prepare('SELECT COUNT(*) n FROM request_logs').get() as any).n, 0);
});

test('OpenRouter interrupted stream emits visible tail and force-logs', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_openrouter_interrupt');
  seedOpenRouter('interrupt');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'openrouter', 'allow_all');
  const sse = 'data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n';
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const app = Fastify();
  registerOpenRouterProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/openrouter/chat/completions', headers: { authorization: `Bearer ${token.raw}` }, payload: { model: 'tencent/hy3:free', stream: true, messages: [{ role: 'user', content: 'hi' }] } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.match(res.body, /Stream interrupted; partial response above/);
  assert.match(res.body, /data: \[DONE\]/);
  const log = getDb().prepare('SELECT request_json FROM request_logs ORDER BY id DESC LIMIT 1').get() as any;
  assert.equal(JSON.parse(log.request_json).forcedLogReason, 'openrouter_stream_interrupted');
});

test('OpenRouter 402 insufficient credits cools account and retries pool', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_or_402');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'openrouter', 'allow_all');
  const dead = seedOpenRouter('or-dead', 'sk-or-dead');
  const live = seedOpenRouter('or-live', 'sk-or-live');
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (_url: any, init: any) => {
    const bearer = String((init.headers as any)?.authorization || '');
    if (bearer.includes('sk-or-dead')) {
      return new Response(JSON.stringify({ error: { code: 402, message: 'Insufficient credits' } }), { status: 402, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = Fastify();
  registerOpenRouterProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/openrouter/chat/completions', headers: { authorization: `Bearer ${token.raw}` }, payload: { model: 'tencent/hy3:free', messages: [{ role: 'user', content: 'hi' }] } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  const deadRow = getDb().prepare('SELECT status, cooldown_until FROM provider_accounts WHERE id=?').get(dead) as any;
  assert.equal(deadRow.status, 'cooldown');
  assert.ok(deadRow.cooldown_until > Date.now());
  const liveRow = getDb().prepare('SELECT status FROM provider_accounts WHERE id=?').get(live) as any;
  assert.notEqual(liveRow.status, 'cooldown');
  const evt = getDb().prepare("SELECT reason FROM provider_health_events WHERE provider_account_id=? ORDER BY id DESC LIMIT 1").get(dead) as any;
  assert.match(String(evt?.reason || ''), /insufficient_credits/);
});
