import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import Fastify from 'fastify';

const dbPath = path.join(os.tmpdir(), `super-proxy-runpod-${process.pid}-${Date.now()}.sqlite`);
process.env.DATABASE_PATH = dbPath;
process.env.DEV_ADMIN_KEY = 'test-admin';
process.env.RUNPOD_UPSTREAM_BASE_URL = 'https://runpod.test/v2';

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
const { createProxyToken } = await import('./utils/crypto.js');
const { registerRunpodProxy } = await import('./proxy/runpod.js');
const { registerAdminApi } = await import('./admin/admin-api.js');
const runpodPool = await import('./providers/runpod-pool.js');

migrate();
const db = getDb();
const tok = createProxyToken();
const devUserId = Number(db.prepare("INSERT INTO users (email,role,is_admin,enabled) VALUES ('dev@example.com','developer',0,1)").run().lastInsertRowid);
db.prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(devUserId, 'runpod', 'allow_all');
db.prepare('INSERT INTO api_tokens (user_id,label,token_hash,token_prefix) VALUES (?,?,?,?)').run(devUserId, 'dev-token', tok.hash, tok.prefix);

function resetRunpod() {
  db.prepare('DELETE FROM request_logs').run();
  db.prepare("DELETE FROM usage_events WHERE provider='runpod'").run();
  db.prepare("DELETE FROM provider_health_events").run();
  db.prepare("DELETE FROM provider_accounts WHERE provider='runpod'").run();
  db.prepare("DELETE FROM user_model_denies WHERE user_id=? AND provider='runpod'").run(devUserId);
}

function insertAccount(label: string, secret: string, endpointId = 'ep-test', maxInFlight = 4): number {
  return Number(db.prepare("INSERT INTO provider_accounts (provider,label,secret,account_id,max_in_flight) VALUES ('runpod',?,?,?,?)").run(label, secret, endpointId, maxInFlight).lastInsertRowid);
}

async function runpodApp() {
  const app = Fastify({ logger: false });
  registerRunpodProxy(app);
  return app;
}

test('migration 2026052801 adds runpod to provider_accounts CHECK', () => {
  db.prepare("INSERT INTO provider_accounts (provider,label,secret,account_id) VALUES ('runpod','migration-runpod','sk-runpod','ep-migration')").run();
  const version = db.prepare('SELECT version FROM schema_migrations WHERE version=2026052801').get() as any;
  assert.equal(version.version, 2026052801);
  resetRunpod();
});

test('admin provider account create accepts provider=runpod and defaults max_in_flight', async () => {
  resetRunpod();
  const app = Fastify({ logger: false });
  registerAdminApi(app);
  const res = await app.inject({ method: 'POST', url: '/admin/provider-accounts', headers: { 'x-admin-key': 'test-admin' }, payload: { provider: 'runpod', label: 'admin-runpod', secret: 'rpa_test', accountId: 'ep-admin' } });
  assert.equal(res.statusCode, 200, res.body);
  const row = db.prepare("SELECT provider,max_in_flight,account_id FROM provider_accounts WHERE label='admin-runpod'").get() as any;
  assert.equal(row.provider, 'runpod');
  assert.equal(row.account_id, 'ep-admin');
  assert.ok(row.max_in_flight >= 1);
  await app.close();
});

test('forwards Authorization bearer and uses per-account endpoint id', async () => {
  resetRunpod();
  insertAccount('alpha', 'rpa-alpha', 'ep-alpha');
  const originalFetch = globalThis.fetch;
  let seenUrl = '';
  let seenAuth = '';
  let seenCookie: string | null = null;
  let seenAdminKey: string | null = null;
  globalThis.fetch = (async (url: any, init: any) => {
    seenUrl = String(url);
    seenAuth = String((init.headers as Headers).get('authorization'));
    seenCookie = (init.headers as Headers).get('cookie');
    seenAdminKey = (init.headers as Headers).get('x-admin-key');
    return new Response(JSON.stringify({ usage: { prompt_tokens: 4, completion_tokens: 6 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  const app = await runpodApp();
  const res = await app.inject({ method: 'POST', url: '/v1/runpod/chat/completions', headers: { authorization: `Bearer ${tok.raw}`, cookie: 'session=secret', 'x-admin-key': 'do-not-forward' }, payload: { model: 'qwen36-27b', messages: [{ role: 'user', content: 'hi' }] } });
  globalThis.fetch = originalFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(seenAuth, 'Bearer rpa-alpha');
  assert.equal(seenCookie, null);
  assert.equal(seenAdminKey, null);
  assert.equal(seenUrl, 'https://runpod.test/v2/ep-alpha/openai/v1/chat/completions');
  const usage = db.prepare("SELECT estimated_cost_usd,input_tokens,output_tokens FROM usage_events WHERE provider='runpod' ORDER BY id DESC LIMIT 1").get() as any;
  assert.equal(usage.estimated_cost_usd, 0);
  assert.equal(usage.input_tokens, 4);
  assert.equal(usage.output_tokens, 6);
  await app.close();
});

test('non-admin runpod access is denied by default when model is omitted', async () => {
  resetRunpod();
  insertAccount('default-off', 'rpa-default-off');
  db.prepare("DELETE FROM user_provider_access_modes WHERE user_id=? AND provider='runpod'").run(devUserId);
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { calls += 1; return new Response('{}', { status: 200 }); }) as any;
  const app = await runpodApp();
  const res = await app.inject({ method: 'POST', url: '/v1/runpod/chat/completions', headers: { authorization: `Bearer ${tok.raw}` }, payload: { messages: [{ role: 'user', content: 'hi' }] } });
  globalThis.fetch = originalFetch;
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().error.code, 'model_not_allowed_for_user');
  assert.equal(calls, 0);
  db.prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(devUserId, 'runpod', 'allow_all');
  await app.close();
});

test('allowed runpod user can omit model and receives default virtual model', async () => {
  resetRunpod();
  insertAccount('default-model', 'rpa-default-model');
  const originalFetch = globalThis.fetch;
  let sentBody: any = null;
  globalThis.fetch = (async (_url: any, init: any) => {
    sentBody = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ usage: { prompt_tokens: 2, completion_tokens: 3 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  const app = await runpodApp();
  const res = await app.inject({ method: 'POST', url: '/v1/runpod/chat/completions', headers: { authorization: `Bearer ${tok.raw}` }, payload: { messages: [{ role: 'user', content: 'hi' }] } });
  globalThis.fetch = originalFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(sentBody.model, 'qwen36-27b');
  const ev = db.prepare("SELECT model FROM usage_events WHERE provider='runpod' ORDER BY id DESC LIMIT 1").get() as any;
  assert.equal(ev.model, 'qwen36-27b');
  await app.close();
});

test('qwen36-27b-fast rewrites model and injects chat_template_kwargs.enable_thinking=false', async () => {
  resetRunpod();
  insertAccount('fast', 'rpa-fast');
  const originalFetch = globalThis.fetch;
  let sentBody: any = null;
  globalThis.fetch = (async (_url: any, init: any) => {
    sentBody = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  const app = await runpodApp();
  const res = await app.inject({ method: 'POST', url: '/v1/runpod/chat/completions', headers: { authorization: `Bearer ${tok.raw}` }, payload: { model: 'qwen36-27b-fast', messages: [{ role: 'user', content: 'hi' }] } });
  globalThis.fetch = originalFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(sentBody.model, 'qwen36-27b');
  assert.equal(sentBody.chat_template_kwargs.enable_thinking, false);
  // The usage event is recorded under the virtual model id, not the upstream.
  const ev = db.prepare("SELECT model FROM usage_events WHERE provider='runpod' ORDER BY id DESC LIMIT 1").get() as any;
  assert.equal(ev.model, 'qwen36-27b-fast');
  await app.close();
});

test('qwen36-27b-fast requires authorization for rewritten runtime model', async () => {
  resetRunpod();
  insertAccount('fast-runtime-denied', 'rpa-fast-runtime-denied');
  db.prepare('INSERT INTO user_model_denies (user_id,provider,model) VALUES (?,?,?)')
    .run(devUserId, 'runpod', 'qwen36-27b');
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response('{}', { status: 200 });
  }) as any;
  const app = await runpodApp();
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/runpod/chat/completions',
      headers: { authorization: `Bearer ${tok.raw}` },
      payload: { model: 'qwen36-27b-fast', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(res.json().error.code, 'model_not_allowed_for_user');
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
  }
});

test('qwen36-27b-fast preserves caller-provided enable_thinking', async () => {
  resetRunpod();
  insertAccount('explicit', 'rpa-explicit');
  const originalFetch = globalThis.fetch;
  let sentBody: any = null;
  globalThis.fetch = (async (_url: any, init: any) => {
    sentBody = JSON.parse(String(init.body));
    return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  const app = await runpodApp();
  await app.inject({ method: 'POST', url: '/v1/runpod/chat/completions', headers: { authorization: `Bearer ${tok.raw}` }, payload: { model: 'qwen36-27b-fast', chat_template_kwargs: { enable_thinking: true }, messages: [{ role: 'user', content: 'hi' }] } });
  globalThis.fetch = originalFetch;
  assert.equal(sentBody.model, 'qwen36-27b');
  assert.equal(sentBody.chat_template_kwargs.enable_thinking, true);
  await app.close();
});

test('Runpod 429 with Retry-After cools account and retries next account', async () => {
  resetRunpod();
  const first = insertAccount('first', 'rpa-first', 'ep-first');
  const second = insertAccount('second', 'rpa-second', 'ep-second');
  assert.ok(first < second);
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (_url: any, init: any) => {
    calls.push(String((init.headers as Headers).get('authorization')));
    if (calls.length === 1) return new Response('too many', { status: 429, headers: { 'retry-after': '60' } });
    return new Response(JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 4 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  const app = await runpodApp();
  const res = await app.inject({ method: 'POST', url: '/v1/runpod/chat/completions', headers: { authorization: `Bearer ${tok.raw}` }, payload: { model: 'qwen36-27b', messages: [{ role: 'user', content: 'hi' }] } });
  globalThis.fetch = originalFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(calls.length, 2);
  const cooled = db.prepare('SELECT status,cooldown_until FROM provider_accounts WHERE cooldown_until > ? AND provider=?').get(Date.now() + 55_000, 'runpod') as any;
  assert.ok(cooled, 'expected one runpod account to be cooled');
  assert.equal(cooled.status, 'cooldown');
  await app.close();
});

test('Streaming SSE passes through and records final usage', async () => {
  resetRunpod();
  insertAccount('stream', 'rpa-stream');
  const sse = [
    'data: {"choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":2}}',
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as any;
  const app = await runpodApp();
  const res = await app.inject({ method: 'POST', url: '/v1/runpod/chat/completions', headers: { authorization: `Bearer ${tok.raw}` }, payload: { model: 'qwen36-27b', stream: true, messages: [{ role: 'user', content: 'hi' }] } });
  globalThis.fetch = originalFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.match(res.body, /"content":"hello"/);
  assert.match(res.body, /data: \[DONE\]/);
  const usage = db.prepare("SELECT input_tokens,output_tokens FROM usage_events WHERE provider='runpod' ORDER BY id DESC LIMIT 1").get() as any;
  assert.equal(usage.input_tokens, 7);
  assert.equal(usage.output_tokens, 2);
  await app.close();
});

test('GET /v1/runpod/models synthesizes both virtual model ids', async () => {
  // Route moved from registerRunpodProxy to the catalog-derived
  // provider-models module (see src/api/provider-models.ts); same ids, now
  // policy-filtered (this test user has runpod allow_all).
  resetRunpod();
  insertAccount('models', 'rpa-models');
  const app = await runpodApp();
  const { registerProviderModelsRoutes } = await import('./api/provider-models.js');
  registerProviderModelsRoutes(app);
  const res = await app.inject({ method: 'GET', url: '/v1/runpod/models', headers: { authorization: `Bearer ${tok.raw}` } });
  assert.equal(res.statusCode, 200, res.body);
  const ids = (res.json().data as any[]).map((m) => m.id).sort();
  assert.deepEqual(ids, ['qwen36-27b', 'qwen36-27b-fast']);
  await app.close();
});
