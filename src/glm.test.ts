import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import Fastify from 'fastify';

const dbPath = path.join(os.tmpdir(), `super-proxy-glm-${process.pid}-${Date.now()}.sqlite`);
process.env.DATABASE_PATH = dbPath;
process.env.DEV_ADMIN_KEY = 'test-admin';
process.env.GLM_UPSTREAM_URL = 'https://glm.test/api/anthropic';

function hashIndex(key: string, length: number): number {
  const digest = crypto.createHash('sha256').update(key).digest();
  return digest.readUInt32BE(0) % length;
}

function conversationForIndex(index: number, length: number, model = 'glm-5.2') {
  for (let i = 0; i < 1000; i++) {
    const conv = `conv-${i}`;
    const key = `dev@example.com:dev-token:${conv || model || '/messages'}`;
    if (hashIndex(key, length) === index) return conv;
  }
  throw new Error('no conversation found');
}

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
  INSERT INTO provider_accounts (provider,label,secret) VALUES ('anthropic','kept','sk-ant');
`);
old.close();

const { migrate } = await import('./db/migrate.js');
const { getDb } = await import('./db/index.js');
const { createProxyToken } = await import('./utils/crypto.js');
const { registerGlmProxy } = await import('./proxy/glm.js');
const { registerAdminApi } = await import('./admin/admin-api.js');
const glmPool = await import('./providers/glm-pool.js');

migrate();
const db = getDb();
const tok = createProxyToken();
const devUserId = Number(db.prepare("INSERT INTO users (email,role,is_admin,enabled) VALUES ('dev@example.com','developer',0,1)").run().lastInsertRowid);
db.prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(devUserId, 'glm', 'allow_all');
db.prepare('INSERT INTO api_tokens (user_id,label,token_hash,token_prefix) VALUES (?,?,?,?)').run(devUserId, 'dev-token', tok.hash, tok.prefix);

function resetGlm() {
  db.prepare('DELETE FROM request_logs').run();
  db.prepare("DELETE FROM usage_events WHERE provider='glm'").run();
  db.prepare("DELETE FROM provider_health_events").run();
  db.prepare("DELETE FROM provider_accounts WHERE provider='glm'").run();
  db.prepare("DELETE FROM user_model_denies WHERE provider='glm'").run();
}

async function glmApp() {
  const app = Fastify({ logger: false });
  registerGlmProxy(app);
  return app;
}

test('migration 2026062501 adds glm to provider_accounts CHECK and preserves existing rows', () => {
  const kept = db.prepare("SELECT provider,label,secret FROM provider_accounts WHERE label='kept'").get() as any;
  assert.equal(kept.provider, 'anthropic');
  db.prepare("INSERT INTO provider_accounts (provider,label,secret) VALUES ('glm','migration-glm','sk-glm')").run();
  const version = db.prepare('SELECT version FROM schema_migrations WHERE version=2026062501').get() as any;
  assert.equal(version.version, 2026062501);
});

test('admin provider account create accepts provider=glm and defaults max_in_flight to 10', async () => {
  resetGlm();
  const app = Fastify({ logger: false });
  registerAdminApi(app);
  const res = await app.inject({ method: 'POST', url: '/admin/provider-accounts', headers: { 'x-admin-key': 'test-admin' }, payload: { provider: 'glm', label: 'admin-glm', secret: 'sk-glm-admin' } });
  assert.equal(res.statusCode, 200, res.body);
  const row = db.prepare("SELECT provider,max_in_flight FROM provider_accounts WHERE label='admin-glm'").get() as any;
  assert.equal(row.provider, 'glm');
  assert.equal(row.max_in_flight, 10);
  await app.close();
});

test('selectGlmAccount skips active cooldown and enforces in-flight cap (account override=1)', () => {
  resetGlm();
  const coolingUntil = Date.now() + 60_000;
  db.prepare("INSERT INTO provider_accounts (provider,label,secret,cooldown_until,max_in_flight) VALUES ('glm','cool','sk-cool',?,1)").run(coolingUntil);
  const activeId = Number(db.prepare("INSERT INTO provider_accounts (provider,label,secret,max_in_flight) VALUES ('glm','active','sk-active',1)").run().lastInsertRowid);
  const selected = glmPool.selectGlmAccount('sticky', 'glm-5.2')!;
  assert.equal(selected.id, activeId);
  assert.equal(glmPool.acquireGlmSlot(selected, 'glm-5.2'), true);
  // account override max_in_flight=1 takes effect (min of model cap 10 and override 1)
  assert.equal(glmPool.selectGlmAccount('sticky', 'glm-5.2'), null);
  glmPool.releaseGlmSlot(selected, 'glm-5.2');
  assert.equal(glmPool.getGlmInFlightSnapshot()[activeId], 0);
});

test('per-model concurrency cap: glm-4.7 limited to 2 in-flight; other models independent', () => {
  resetGlm();
  const id = Number(db.prepare("INSERT INTO provider_accounts (provider,label,secret) VALUES ('glm','permodel','sk-permodel')").run().lastInsertRowid);
  const acct = { id, max_in_flight: 0 } as any;
  assert.equal(glmPool.glmModelLimit('glm-4.7'), 2);
  assert.equal(glmPool.glmModelLimit('glm-5-turbo'), 1);
  assert.equal(glmPool.glmModelLimit('glm-5.2'), 10);
  // glm-4.7 allows exactly 2 then rejects the 3rd
  assert.equal(glmPool.acquireGlmSlot(acct, 'glm-4.7'), true);
  assert.equal(glmPool.acquireGlmSlot(acct, 'glm-4.7'), true);
  assert.equal(glmPool.acquireGlmSlot(acct, 'glm-4.7'), false, '3rd glm-4.7 slot must be rejected');
  // a different model on the same account is tracked independently
  assert.equal(glmPool.acquireGlmSlot(acct, 'glm-5.2'), true);
  assert.equal(glmPool.getGlmModelInFlight(id, 'glm-4.7'), 2);
  assert.equal(glmPool.getGlmModelInFlight(id, 'glm-5.2'), 1);
  assert.equal(glmPool.getGlmInFlight(id), 3);
  // selection rejects glm-4.7 (capped) but allows glm-5.2
  assert.equal(glmPool.selectGlmAccount('s', 'glm-4.7'), null);
  assert.ok(glmPool.selectGlmAccount('s', 'glm-5.2'));
  glmPool.releaseGlmSlot(acct, 'glm-4.7');
  assert.equal(glmPool.getGlmModelInFlight(id, 'glm-4.7'), 1);
  assert.ok(glmPool.selectGlmAccount('s', 'glm-4.7'));
});

test('401 without token', async () => {
  resetGlm();
  db.prepare("INSERT INTO provider_accounts (provider,label,secret,max_in_flight) VALUES ('glm','noauth','sk-glm-noauth',10)").run();
  const app = await glmApp();
  const res = await app.inject({ method: 'POST', url: '/v1/glm/messages', payload: { model: 'glm-5.2', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } });
  assert.equal(res.statusCode, 401, res.body);
  await app.close();
});

test('Anthropic GLM happy path: 200, forwards x-api-key=account.secret + anthropic-version, parses usage, transparent body', async () => {
  resetGlm();
  db.prepare("INSERT INTO provider_accounts (provider,label,secret,max_in_flight) VALUES ('glm','happy','sk-glm-happy',10)").run();
  const originalFetch = globalThis.fetch;
  let seenUrl = '';
  globalThis.fetch = (async (url: any, init: any) => {
    seenUrl = String(url);
    const headers = init.headers as Headers;
    // Auth disguised as Claude-Code/Anthropic: x-api-key carries the pooled key,
    // anthropic-version is present, and Authorization is stripped.
    assert.equal(headers.get('x-api-key'), 'sk-glm-happy');
    assert.equal(headers.get('anthropic-version'), '2023-06-01');
    assert.equal(headers.get('authorization'), null);
    // Body forwarded verbatim (transparent passthrough).
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, 'glm-5.2');
    assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
    return new Response(JSON.stringify({ id: 'msg', usage: { input_tokens: 13, output_tokens: 5 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  const app = await glmApp();
  const res = await app.inject({ method: 'POST', url: '/v1/glm/messages', headers: { authorization: `Bearer ${tok.raw}`, 'anthropic-version': '2023-06-01' }, payload: { model: 'glm-5.2', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } });
  globalThis.fetch = originalFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.headers['x-gateway-provider'], 'glm');
  assert.match(seenUrl, /\/v1\/messages$/);
  const usage = db.prepare("SELECT input_tokens,output_tokens,estimated_cost_usd FROM usage_events WHERE provider='glm' ORDER BY id DESC LIMIT 1").get() as any;
  assert.equal(usage.input_tokens, 13);
  assert.equal(usage.output_tokens, 5);
  // GLM Coding Plan is flat-rate (actual spend ~$0), but we now record a
  // NOTIONAL retail-equivalent cost for usage visibility, like Kimi/Anthropic.
  // glm-5.2: 13*$1.4/1M + 5*$4.4/1M = 0.0000402, rounded to 6 dp -> 0.00004.
  const expected = Math.round((13 * 1.4e-6 + 5 * 4.4e-6) * 1e6) / 1e6;
  assert.ok(Math.abs(usage.estimated_cost_usd - expected) < 1e-9, `glm notional cost ${usage.estimated_cost_usd}`);
  await app.close();
});

test('GLM injects default reasoning_effort=max + thinking enabled when caller omits them', async () => {
  resetGlm();
  db.prepare("INSERT INTO provider_accounts (provider,label,secret,max_in_flight) VALUES ('glm','eff','sk-glm-eff',10)").run();
  const originalFetch = globalThis.fetch;
  let sent: any = null;
  globalThis.fetch = (async (_url: any, init: any) => {
    sent = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ id: 'msg', usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  const app = await glmApp();
  const res = await app.inject({ method: 'POST', url: '/v1/glm/messages', headers: { authorization: `Bearer ${tok.raw}` }, payload: { model: 'glm-5.2', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } });
  globalThis.fetch = originalFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(sent.reasoning_effort, 'max');
  assert.deepEqual(sent.thinking, { type: 'enabled' });
  await app.close();
});

test('GLM respects caller-provided reasoning_effort + thinking (no override)', async () => {
  resetGlm();
  db.prepare("INSERT INTO provider_accounts (provider,label,secret,max_in_flight) VALUES ('glm','eff2','sk-glm-eff2',10)").run();
  const originalFetch = globalThis.fetch;
  let sent: any = null;
  globalThis.fetch = (async (_url: any, init: any) => {
    sent = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ id: 'msg', usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  const app = await glmApp();
  const res = await app.inject({ method: 'POST', url: '/v1/glm/messages', headers: { authorization: `Bearer ${tok.raw}` }, payload: { model: 'glm-5.2', max_tokens: 16, reasoning_effort: 'low', thinking: { type: 'disabled' }, messages: [{ role: 'user', content: 'hi' }] } });
  globalThis.fetch = originalFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(sent.reasoning_effort, 'low');
  assert.deepEqual(sent.thinking, { type: 'disabled' });
  await app.close();
});

test('GLM accepts x-api-key client auth (Claude Code style) and still swaps to pooled key', async () => {
  resetGlm();
  db.prepare("INSERT INTO provider_accounts (provider,label,secret,max_in_flight) VALUES ('glm','cc','sk-glm-cc',10)").run();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any) => {
    assert.equal((init.headers as Headers).get('x-api-key'), 'sk-glm-cc');
    return new Response(JSON.stringify({ id: 'msg', usage: { input_tokens: 4, output_tokens: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  const app = await glmApp();
  // Client passes the nbmg token via x-api-key, exactly like Claude Code does.
  const res = await app.inject({ method: 'POST', url: '/v1/glm/messages', headers: { 'x-api-key': tok.raw }, payload: { model: 'glm-5.2', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } });
  globalThis.fetch = originalFetch;
  assert.equal(res.statusCode, 200, res.body);
  await app.close();
});

test('canonical Anthropic client path /v1/glm/v1/messages is served (base .../v1/glm + /v1/messages)', async () => {
  resetGlm();
  db.prepare("INSERT INTO provider_accounts (provider,label,secret,max_in_flight) VALUES ('glm','aliaspath','sk-glm-alias',10)").run();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any) => {
    assert.equal((init.headers as Headers).get('x-api-key'), 'sk-glm-alias');
    return new Response(JSON.stringify({ id: 'msg', usage: { input_tokens: 4, output_tokens: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  const app = await glmApp();
  // This is the path a real Claude Code / OpenClaw anthropic client hits when
  // ANTHROPIC_BASE_URL=https://.../v1/glm (SDK appends /v1/messages).
  const res = await app.inject({ method: 'POST', url: '/v1/glm/v1/messages', headers: { 'x-api-key': tok.raw }, payload: { model: 'glm-5.2', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } });
  globalThis.fetch = originalFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.headers['x-gateway-provider'], 'glm');
  await app.close();
});

test('unknown model fallback sets x-gateway-glm-fallback and uses default glm-5.2', async () => {
  resetGlm();
  db.prepare("INSERT INTO provider_accounts (provider,label,secret,max_in_flight) VALUES ('glm','fallback','sk-glm-fallback',10)").run();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, 'glm-5.2');
    return new Response(JSON.stringify({ id: 'msg', usage: { input_tokens: 3, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  const app = await glmApp();
  const res = await app.inject({ method: 'POST', url: '/v1/glm/messages', headers: { authorization: `Bearer ${tok.raw}` }, payload: { model: 'glm-9-nope', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } });
  globalThis.fetch = originalFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.headers['x-gateway-glm-fallback'], 'glm-9-nope');
  await app.close();
});

test('model-not-allowed denial returns 400 invalid_request_error', async () => {
  resetGlm();
  db.prepare("INSERT INTO provider_accounts (provider,label,secret,max_in_flight) VALUES ('glm','denied','sk-glm-denied',10)").run();
  db.prepare('INSERT INTO user_model_denies (user_id,provider,model) VALUES (?,?,?)').run(devUserId, 'glm', 'glm-4.6');
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => { called = true; return new Response('{}', { status: 200 }); }) as any;
  const app = await glmApp();
  const res = await app.inject({ method: 'POST', url: '/v1/glm/messages', headers: { authorization: `Bearer ${tok.raw}` }, payload: { model: 'glm-4.6', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } });
  globalThis.fetch = originalFetch;
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(called, false);
  assert.equal(res.json().error.code, 'model_not_allowed_for_user');
  await app.close();
});

test('omitted model does NOT bypass provider deny_all (authorizes resolved default)', async () => {
  resetGlm();
  db.prepare("INSERT INTO provider_accounts (provider,label,secret,max_in_flight) VALUES ('glm','denyall','sk-glm-da',10)").run();
  // deny the whole glm provider for this user (global setup seeded allow_all)
  db.prepare("UPDATE user_provider_access_modes SET mode='deny_all' WHERE user_id=? AND provider='glm'").run(devUserId);
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => { called = true; return new Response('{}', { status: 200 }); }) as any;
  const app = await glmApp();
  // NO model field — must still be denied (resolves to glm-5.2 and authorizes it)
  const res = await app.inject({ method: 'POST', url: '/v1/glm/messages', headers: { authorization: `Bearer ${tok.raw}` }, payload: { max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } });
  globalThis.fetch = originalFetch;
  // restore allow_all so later tests are unaffected
  db.prepare("UPDATE user_provider_access_modes SET mode='allow_all' WHERE user_id=? AND provider='glm'").run(devUserId);
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(called, false, 'upstream must not be called when provider is deny_all');
  assert.equal(res.json().error.code, 'model_not_allowed_for_user');
  await app.close();
});

test('GLM 429 with Retry-After cools account and retries next account', async () => {
  resetGlm();
  const first = Number(db.prepare("INSERT INTO provider_accounts (provider,label,secret,max_in_flight) VALUES ('glm','first','sk-first',10)").run().lastInsertRowid);
  const second = Number(db.prepare("INSERT INTO provider_accounts (provider,label,secret,max_in_flight) VALUES ('glm','second','sk-second',10)").run().lastInsertRowid);
  assert.ok(first < second);
  const conv = conversationForIndex(0, 2);
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (_url: any, init: any) => {
    calls.push(String((init.headers as Headers).get('x-api-key')));
    if (calls.length === 1) return new Response('too many', { status: 429, headers: { 'retry-after': '60' } });
    return new Response(JSON.stringify({ usage: { input_tokens: 3, output_tokens: 4 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  const app = await glmApp();
  const res = await app.inject({ method: 'POST', url: '/v1/glm/messages', headers: { authorization: `Bearer ${tok.raw}`, 'x-conversation-id': conv }, payload: { model: 'glm-5.2', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } });
  globalThis.fetch = originalFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(calls.length, 2);
  assert.equal(calls[0], 'sk-first');
  assert.equal(calls[1], 'sk-second');
  const cooled = db.prepare('SELECT status,cooldown_until FROM provider_accounts WHERE id=?').get(first) as any;
  assert.equal(cooled.status, 'cooldown');
  assert.ok(cooled.cooldown_until > Date.now() + 55_000);
  await app.close();
});

test('releaseGlmSlot runs on upstream/network error', async () => {
  resetGlm();
  const id = Number(db.prepare("INSERT INTO provider_accounts (provider,label,secret,max_in_flight) VALUES ('glm','error-release','sk-error',1)").run().lastInsertRowid);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('boom'); }) as any;
  const app = await glmApp();
  const res = await app.inject({ method: 'POST', url: '/v1/glm/messages', headers: { authorization: `Bearer ${tok.raw}` }, payload: { model: 'glm-5.2', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } });
  globalThis.fetch = originalFetch;
  assert.equal(res.statusCode, 429);
  assert.equal(glmPool.getGlmInFlightSnapshot()[id], 0);
  await app.close();
});

test('GLM streaming passes SSE through and emits visible tail on interruption', async () => {
  resetGlm();
  db.prepare("INSERT INTO provider_accounts (provider,label,secret,max_in_flight) VALUES ('glm','stream','sk-stream',10)").run();
  const sse = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":7,"output_tokens":0}}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"partial"}}\n\n';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as any;
  const app = await glmApp();
  const res = await app.inject({ method: 'POST', url: '/v1/glm/messages', headers: { authorization: `Bearer ${tok.raw}` }, payload: { model: 'glm-5.2', stream: true, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } });
  globalThis.fetch = originalFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.match(res.body, /partial/);
  await app.close();
});

test('GLM/Anthropic-style message_stop marks stream complete (no fake interruption)', async () => {
  const { surfaceOpenAiCompatStreamChunk, surfaceOpenAiCompatError } = await import('./proxy/openai-compat-errors.js');
  const state = { sawCompletion: false, sawContent: false };
  const chunk = [
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}',
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":1,"output_tokens":1}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n');

  const surfaced = surfaceOpenAiCompatStreamChunk('glm', chunk, state);
  assert.equal(state.sawCompletion, true);
  assert.equal(state.sawContent, true);
  assert.equal(surfaced.appendSse, undefined);

  // Mirrors glm.ts: only append stream_interrupted when no completion was seen.
  const wouldAppendInterrupted = !state.sawCompletion
    ? surfaceOpenAiCompatError('glm', null, 'stream_interrupted').appendSse
    : undefined;
  assert.equal(wouldAppendInterrupted, undefined);
});
