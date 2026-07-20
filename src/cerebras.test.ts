import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';

process.env.DATABASE_PATH = path.join(os.tmpdir(), `nbmg-cerebras-${process.pid}.sqlite`);
process.env.DEV_ADMIN_KEY = 'test-admin-key';
process.env.CEREBRAS_UPSTREAM_URL = 'https://cerebras.test/v1';

const { getDb } = await import('./db/index.js');
const { migrate } = await import('./db/migrate.js');
const { sha256 } = await import('./utils/crypto.js');
const { selectCerebrasAccountForModel, recordCerebrasRequest, markCerebrasCooldown, cerebrasWindows } = await import('./providers/cerebras-pool.js');
const { registerCerebrasProxy } = await import('./proxy/cerebras.js');
const { registerSelfApi } = await import('./self-api.js');
const { registerAdminApi } = await import('./admin/admin-api.js');

function resetRuntimeTables() {
  const db = getDb();
  db.prepare('DELETE FROM request_logs').run();
  db.prepare('DELETE FROM provider_health_events').run();
  db.prepare('DELETE FROM cerebras_model_cooldowns').run();
  db.prepare('DELETE FROM cerebras_usage_buckets').run();
  db.prepare('DELETE FROM cerebras_limits').run();
  db.prepare('DELETE FROM usage_events').run();
  db.prepare('DELETE FROM api_tokens').run();
  db.prepare('DELETE FROM users WHERE email != ?').run('daxitm2112@gmail.com');
  db.prepare('DELETE FROM provider_accounts').run();
}

function seedUserAndToken(raw = 'nbmg_test_token') {
  const db = getDb();
  const userId = Number(db.prepare("INSERT INTO users (email,role,is_admin,enabled) VALUES ('dev@example.com','developer',0,1)").run().lastInsertRowid);
  db.prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(userId, 'cerebras', 'allow_all');
  const tokenId = Number(db.prepare('INSERT INTO api_tokens (user_id,label,token_hash,token_prefix,enabled) VALUES (?,?,?,?,1)').run(userId, 'dev-token', sha256(raw), raw.slice(0, 14)).lastInsertRowid);
  return { raw, userId, tokenId };
}

function seedCerebras(label: string, secret = 'csk_test') {
  return Number(getDb().prepare("INSERT INTO provider_accounts (provider,label,secret,status,enabled) VALUES ('cerebras',?,?, 'active',1)").run(label, secret).lastInsertRowid);
}

const CEREBRAS_FALLBACK_ALIAS = 'qwen-3-235b-a22b-instruct-2507';

async function exerciseCerebrasAliasAuthorization(deniedModels: string[], expectedAllowed: boolean) {
  resetRuntimeTables();
  const token = seedUserAndToken(`nbmg_cerebras_alias_${deniedModels.join('_') || 'allowed'}`);
  for (const model of deniedModels) {
    getDb().prepare('INSERT INTO user_model_denies (user_id,provider,model) VALUES (?,?,?)')
      .run(token.userId, 'cerebras', model);
  }
  seedCerebras('alias-auth');
  const oldFetch = globalThis.fetch;
  let called = false;
  let upstreamModel: string | undefined;
  (globalThis as any).fetch = async (_url: string, init: RequestInit) => {
    called = true;
    upstreamModel = JSON.parse(String(init.body || '{}')).model;
    return new Response(JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const app = Fastify();
  registerSelfApi(app);
  registerCerebrasProxy(app);
  try {
    const models = await app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: `Bearer ${token.raw}` } });
    assert.equal(models.statusCode, 200, models.body);
    assert.equal(models.headers['cache-control'], 'private, no-store');
    const listed = models.json().data.some((model: any) => model.catalog_id === `cerebras/${CEREBRAS_FALLBACK_ALIAS}`);
    assert.equal(listed, expectedAllowed);

    const call = await app.inject({
      method: 'POST',
      url: '/v1/cerebras/chat/completions',
      headers: { authorization: `Bearer ${token.raw}` },
      payload: { model: CEREBRAS_FALLBACK_ALIAS, messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(call.statusCode, expectedAllowed ? 200 : 400, call.body);
    assert.equal(called, expectedAllowed, 'denied aliases must not call upstream');
    if (expectedAllowed) assert.equal(upstreamModel, 'gpt-oss-120b');
    else assert.equal(call.json().error.code, 'model_not_allowed_for_user');
  } finally {
    (globalThis as any).fetch = oldFetch;
    await app.close();
  }
}

test('migration rebuilds old provider_accounts CHECK, preserves rows, and adds Cerebras tables', () => {
  const db = getDb();
  db.exec(`
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
  db.prepare("INSERT INTO provider_accounts (provider,label,secret) VALUES ('anthropic','old','secret')").run();
  migrate();
  assert.equal((db.prepare("SELECT COUNT(*) n FROM provider_accounts WHERE label='old'").get() as any).n, 1);
  assert.doesNotThrow(() => db.prepare("INSERT INTO provider_accounts (provider,label,secret) VALUES ('cerebras','g','secret')").run());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cerebras_limits'").get());
  assert.ok(db.prepare('SELECT version FROM schema_migrations WHERE version=?').get(2026051501));
});

test('admin provider account create accepts provider=cerebras', async () => {
  resetRuntimeTables();
  const app = Fastify();
  registerAdminApi(app);
  const res = await app.inject({ method: 'POST', url: '/admin/provider-accounts', headers: { 'x-admin-key': 'test-admin-key' }, payload: { provider: 'cerebras', label: 'cerebras-1', secret: 'csk_x' } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal((getDb().prepare("SELECT provider FROM provider_accounts WHERE label='cerebras-1'").get() as any).provider, 'cerebras');
});

test('selectCerebrasAccountForModel skips active model cooldown', () => {
  resetRuntimeTables();
  const a = seedCerebras('cool');
  const b = seedCerebras('ok');
  markCerebrasCooldown(a, 'gpt-oss-120b', 60_000, 'test');
  const selected = selectCerebrasAccountForModel('gpt-oss-120b', 'sticky', 50);
  assert.equal(selected?.id, b);
});

test('recordCerebrasRequest keeps UTC minute/day buckets distinct across boundary', () => {
  resetRuntimeTables();
  const a = seedCerebras('bucket');
  const realDate = globalThis.Date;
  class FakeDate extends realDate {
    constructor(...args: any[]) { super(...(args.length ? args : ['2026-05-12T23:59:59.000Z']) as [any]); }
    static now() { return realDate.parse('2026-05-12T23:59:59.000Z'); }
  }
  (globalThis as any).Date = FakeDate;
  recordCerebrasRequest(a, 'm', 10, true);
  class FakeDate2 extends realDate {
    constructor(...args: any[]) { super(...(args.length ? args : ['2026-05-13T00:00:01.000Z']) as [any]); }
    static now() { return realDate.parse('2026-05-13T00:00:01.000Z'); }
  }
  (globalThis as any).Date = FakeDate2;
  recordCerebrasRequest(a, 'm', 20, true);
  (globalThis as any).Date = realDate;
  const rows = getDb().prepare('SELECT window_minute,window_day,requests,tokens FROM cerebras_usage_buckets WHERE account_id=? ORDER BY window_minute').all(a) as any[];
  assert.deepEqual(rows.map(r => [r.window_minute, r.window_day, r.requests, r.tokens]), [
    ['2026-05-12T23:59', '2026-05-12', 1, 10],
    ['2026-05-13T00:00', '2026-05-13', 1, 20],
  ]);
  assert.equal(cerebrasWindows(new Date('2026-05-13T00:00:01Z')).day, '2026-05-13');
});

test('unknown Cerebras model falls back, records zero-cost usage with token counts', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken();
  seedCerebras('g1');
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => new Response(JSON.stringify({ id: 'cmpl', choices: [], usage: { prompt_tokens: 7, completion_tokens: 5 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  const app = Fastify();
  registerCerebrasProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/cerebras/chat/completions', headers: { authorization: `Bearer ${token.raw}` }, payload: { model: 'unknown-model', messages: [{ role: 'user', content: 'hi' }] } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.headers['x-gateway-cerebras-fallback'], 'unknown-model');
  const ev = getDb().prepare("SELECT provider,model,input_tokens,output_tokens,estimated_cost_usd FROM usage_events WHERE provider='cerebras' ORDER BY id DESC LIMIT 1").get() as any;
  assert.equal(ev.model, 'gpt-oss-120b');
  assert.equal(ev.input_tokens, 7);
  assert.equal(ev.output_tokens, 5);
  assert.equal(ev.estimated_cost_usd, 0);
});

test('Cerebras fallback alias is hidden and denied when runtime model is denied', async () => {
  await exerciseCerebrasAliasAuthorization(['gpt-oss-120b'], false);
});

test('Cerebras fallback alias is hidden and denied when requested alias is denied', async () => {
  await exerciseCerebrasAliasAuthorization([CEREBRAS_FALLBACK_ALIAS], false);
});

test('Cerebras fallback alias is listed and callable only when alias and runtime model are allowed', async () => {
  await exerciseCerebrasAliasAuthorization([], true);
});

test('unknown Cerebras fallback still authorizes the resolved default model', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_unknown_fallback_denied');
  getDb().prepare('INSERT INTO user_model_denies (user_id,provider,model) VALUES (?,?,?)')
    .run(token.userId, 'cerebras', 'gpt-oss-120b');
  const oldFetch = globalThis.fetch;
  let called = false;
  (globalThis as any).fetch = async () => {
    called = true;
    return new Response('{}', { status: 200 });
  };
  const app = Fastify();
  registerCerebrasProxy(app);
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/cerebras/chat/completions',
      headers: { authorization: `Bearer ${token.raw}` },
      payload: { model: 'unknown-model', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error.code, 'model_not_allowed_for_user');
    assert.equal(called, false);
  } finally {
    (globalThis as any).fetch = oldFetch;
    await app.close();
  }
});

test('omitted Cerebras model cannot bypass provider deny_all', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_deny_all_token');
  getDb().prepare("UPDATE user_provider_access_modes SET mode='deny_all' WHERE user_id=? AND provider='cerebras'").run(token.userId);
  seedCerebras('deny-all');
  const oldFetch = globalThis.fetch;
  let called = false;
  (globalThis as any).fetch = async () => {
    called = true;
    return new Response('{}', { status: 200 });
  };
  const app = Fastify();
  registerCerebrasProxy(app);
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/cerebras/chat/completions',
      headers: { authorization: `Bearer ${token.raw}` },
      payload: { messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(res.json().error.code, 'model_not_allowed_for_user');
    assert.equal(called, false, 'upstream must not be selected or called');
  } finally {
    (globalThis as any).fetch = oldFetch;
    await app.close();
  }
});


test('Cerebras usage event has estimated_cost_usd=0 and token counts present', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_usage_token');
  seedCerebras('usage');
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => new Response(JSON.stringify({ id: 'cmpl', choices: [], usage: { prompt_tokens: 11, completion_tokens: 13, total_tokens: 24 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  const app = Fastify();
  registerCerebrasProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/cerebras/chat/completions', headers: { authorization: `Bearer ${token.raw}` }, payload: { model: 'gpt-oss-120b', messages: [{ role: 'user', content: 'hi' }] } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  const ev = getDb().prepare("SELECT provider,model,input_tokens,output_tokens,estimated_cost_usd FROM usage_events WHERE provider='cerebras' ORDER BY id DESC LIMIT 1").get() as any;
  assert.equal(ev.model, 'gpt-oss-120b');
  assert.equal(ev.input_tokens, 11);
  assert.equal(ev.output_tokens, 13);
  assert.equal(ev.estimated_cost_usd, 0);
});

test('Cerebras 429 with Retry-After cools down account-model and retries next account', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_retry_token');
  const a = seedCerebras('first');
  const b = seedCerebras('second');
  let calls = 0;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response('{"error":"rate"}', { status: 429, headers: { 'retry-after': '60', 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 4 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = Fastify();
  registerCerebrasProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/cerebras/chat/completions', headers: { authorization: `Bearer ${token.raw}`, 'x-conversation-id': 'retry' }, payload: { model: 'gpt-oss-120b', messages: [{ role: 'user', content: 'hi' }] } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(calls, 2);
  const cd = getDb().prepare('SELECT cooldown_until,reason FROM cerebras_model_cooldowns WHERE account_id=? AND model=?').get(a, 'gpt-oss-120b') as any;
  assert.ok(cd.cooldown_until > Date.now() + 55_000);
  assert.match(cd.reason, /rate limited/);
  const success = getDb().prepare("SELECT provider_account_id,status_code FROM usage_events WHERE provider='cerebras' AND status_code=200 ORDER BY id DESC LIMIT 1").get() as any;
  assert.equal(success.provider_account_id, b);
});

test('Cerebras content_filter is surfaced and force-logged', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_cerebras_filter');
  seedCerebras('filter');
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => new Response(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'content_filter' }], usage: { prompt_tokens: 5, completion_tokens: 0 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  const app = Fastify();
  registerCerebrasProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/cerebras/chat/completions', headers: { authorization: `Bearer ${token.raw}` }, payload: { model: 'gpt-oss-120b', messages: [{ role: 'user', content: 'blocked' }] } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().choices[0].message.content, '⛔ cerebras safety filter blocked this response (content_filter).');
  const log = getDb().prepare('SELECT request_json FROM request_logs ORDER BY id DESC LIMIT 1').get() as any;
  assert.equal(JSON.parse(log.request_json).forcedLogReason, 'cerebras_content_filter');
});

test('Cerebras length finish_reason appends truncation marker without force-log', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_cerebras_length');
  seedCerebras('length');
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => new Response(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'partial' }, finish_reason: 'length' }], usage: { prompt_tokens: 5, completion_tokens: 3 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  const app = Fastify();
  registerCerebrasProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/cerebras/chat/completions', headers: { authorization: `Bearer ${token.raw}` }, payload: { model: 'gpt-oss-120b', messages: [{ role: 'user', content: 'long' }] } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().choices[0].message.content, 'partial\n\n[truncated: length]');
  assert.equal((getDb().prepare('SELECT COUNT(*) n FROM request_logs').get() as any).n, 0);
});

test('Cerebras interrupted stream emits visible tail and force-logs', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_cerebras_interrupt');
  seedCerebras('interrupt');
  const sse = 'data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n';
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const app = Fastify();
  registerCerebrasProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/cerebras/chat/completions', headers: { authorization: `Bearer ${token.raw}` }, payload: { model: 'gpt-oss-120b', stream: true, messages: [{ role: 'user', content: 'hi' }] } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.match(res.body, /Stream interrupted; partial response above/);
  assert.match(res.body, /data: \[DONE\]/);
  const log = getDb().prepare('SELECT request_json FROM request_logs ORDER BY id DESC LIMIT 1').get() as any;
  assert.equal(JSON.parse(log.request_json).forcedLogReason, 'cerebras_stream_interrupted');
});
