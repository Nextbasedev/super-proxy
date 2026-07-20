import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import Fastify from 'fastify';

const dbPath = path.join(os.tmpdir(), `super-proxy-kimi-${process.pid}-${Date.now()}.sqlite`);
process.env.DATABASE_PATH = dbPath;
process.env.DEV_ADMIN_KEY = 'test-admin';
process.env.KIMI_UPSTREAM_URL = 'https://kimi.test/coding/v1';

function hashIndex(key: string, length: number): number {
  const digest = crypto.createHash('sha256').update(key).digest();
  return digest.readUInt32BE(0) % length;
}

function conversationForIndex(index: number, length: number, model = 'kimi-k2.6') {
  for (let i = 0; i < 1000; i++) {
    const conv = `conv-${i}`;
    const key = `dev@example.com:dev-token:${conv || model || '/chat/completions'}`;
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
const { registerKimiProxy } = await import('./proxy/kimi.js');
const { registerAdminApi } = await import('./admin/admin-api.js');
const kimiPool = await import('./providers/kimi-pool.js');

migrate();
const db = getDb();
const tok = createProxyToken();
const devUserId = Number(db.prepare("INSERT INTO users (email,role,is_admin,enabled) VALUES ('dev@example.com','developer',0,1)").run().lastInsertRowid);
db.prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(devUserId, 'kimi', 'allow_all');
db.prepare('INSERT INTO api_tokens (user_id,label,token_hash,token_prefix) VALUES (?,?,?,?)').run(devUserId, 'dev-token', tok.hash, tok.prefix);

function resetKimi() {
  db.prepare('DELETE FROM request_logs').run();
  db.prepare("DELETE FROM usage_events WHERE provider='kimi'").run();
  db.prepare("DELETE FROM provider_health_events").run();
  db.prepare("DELETE FROM provider_accounts WHERE provider='kimi'").run();
}

async function kimiApp() {
  const app = Fastify({ logger: false });
  registerKimiProxy(app);
  return app;
}

test('migration 2026051301 adds kimi to provider_accounts CHECK and preserves existing rows', () => {
  const kept = db.prepare("SELECT provider,label,secret FROM provider_accounts WHERE label='kept'").get() as any;
  assert.equal(kept.provider, 'anthropic');
  db.prepare("INSERT INTO provider_accounts (provider,label,secret) VALUES ('kimi','migration-kimi','sk-kimi')").run();
  const version = db.prepare('SELECT version FROM schema_migrations WHERE version=2026051301').get() as any;
  assert.equal(version.version, 2026051301);
});

test('admin provider account create accepts provider=kimi and defaults max_in_flight to 10', async () => {
  resetKimi();
  const app = Fastify({ logger: false });
  registerAdminApi(app);
  const res = await app.inject({ method: 'POST', url: '/admin/provider-accounts', headers: { 'x-admin-key': 'test-admin' }, payload: { provider: 'kimi', label: 'admin-kimi', secret: 'sk-kimi-admin' } });
  assert.equal(res.statusCode, 200, res.body);
  const row = db.prepare("SELECT provider,max_in_flight FROM provider_accounts WHERE label='admin-kimi'").get() as any;
  assert.equal(row.provider, 'kimi');
  assert.equal(row.max_in_flight, 10);
  await app.close();
});

test('selectKimiAccount skips active cooldown and enforces in-flight cap', () => {
  resetKimi();
  const coolingUntil = Date.now() + 60_000;
  db.prepare("INSERT INTO provider_accounts (provider,label,secret,cooldown_until,max_in_flight) VALUES ('kimi','cool','sk-cool',?,1)").run(coolingUntil);
  const activeId = Number(db.prepare("INSERT INTO provider_accounts (provider,label,secret,max_in_flight) VALUES ('kimi','active','sk-active',1)").run().lastInsertRowid);
  const selected = kimiPool.selectKimiAccount('sticky')!;
  assert.equal(selected.id, activeId);
  assert.equal(kimiPool.acquireKimiSlot(selected), true);
  assert.equal(kimiPool.selectKimiAccount('sticky'), null);
  kimiPool.releaseKimiSlot(selected);
  assert.equal(kimiPool.getKimiInFlightSnapshot()[activeId], 0);
});

test('unknown model fallback sets x-gateway-kimi-fallback and records notional token cost', async () => {
  resetKimi();
  db.prepare("INSERT INTO provider_accounts (provider,label,secret,max_in_flight) VALUES ('kimi','fallback','sk-kimi-fallback',10)").run();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, 'kimi-k2.6');
    return new Response(JSON.stringify({ id: 'cmpl', usage: { prompt_tokens: 11, completion_tokens: 7 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  const app = await kimiApp();
  const res = await app.inject({ method: 'POST', url: '/v1/kimi/chat/completions', headers: { authorization: `Bearer ${tok.raw}` }, payload: { model: 'unknown-kimi', messages: [{ role: 'user', content: 'hi' }] } });
  globalThis.fetch = originalFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.headers['x-gateway-kimi-fallback'], 'unknown-kimi');
  const usage = db.prepare("SELECT estimated_cost_usd,input_tokens,output_tokens FROM usage_events WHERE provider='kimi' ORDER BY id DESC LIMIT 1").get() as any;
  // Notional retail-equivalent cost: 11 in * $0.95/1M + 7 out * $4/1M, rounded 6dp.
  assert.ok(Math.abs(usage.estimated_cost_usd - (Math.round((11 * 0.95 / 1e6 + 7 * 4.0 / 1e6) * 1e6) / 1e6)) < 1e-9);
  assert.equal(usage.input_tokens, 11);
  assert.equal(usage.output_tokens, 7);
  await app.close();
});

test('K3 is a known direct Kimi Code runtime model and is forwarded unchanged', async () => {
  resetKimi();
  db.prepare("INSERT INTO provider_accounts (provider,label,secret,max_in_flight) VALUES ('kimi','k3','sk-k3',10)").run();
  const originalFetch = globalThis.fetch;
  let sentBody: any;
  globalThis.fetch = (async (_url: any, init: any) => {
    sentBody = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ id: 'cmpl-k3', usage: { prompt_tokens: 11, completion_tokens: 7 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as any;
  const app = await kimiApp();
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/kimi/chat/completions',
      headers: { authorization: `Bearer ${tok.raw}` },
      payload: {
        model: 'k3',
        // K3 defaults to Kimi's documented maximum reasoning effort.
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.headers['x-gateway-kimi-fallback'], undefined);
    assert.equal(sentBody.model, 'k3');
    assert.equal(sentBody.reasoning_effort, 'max');
    const usage = db.prepare("SELECT model FROM usage_events WHERE provider='kimi' ORDER BY id DESC LIMIT 1").get() as any;
    assert.equal(usage.model, 'k3');
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
  }
});

test('K3 defaults empty or whitespace reasoning_effort to max for Hermes compatibility', async () => {
  resetKimi();
  db.prepare("INSERT INTO provider_accounts (provider,label,secret,max_in_flight) VALUES ('kimi','k3-empty-effort','sk-k3-empty-effort',10)").run();
  const originalFetch = globalThis.fetch;
  const sentBodies: any[] = [];
  globalThis.fetch = (async (_url: any, init: any) => {
    sentBodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ id: 'cmpl-k3', usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as any;
  const app = await kimiApp();
  try {
    for (const reasoning_effort of ['', '   ']) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/kimi/chat/completions',
        headers: { authorization: `Bearer ${tok.raw}` },
        payload: { model: 'k3', reasoning_effort, messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.equal(res.statusCode, 200, res.body);
    }
    assert.deepEqual(sentBodies.map((body) => body.reasoning_effort), ['max', 'max']);
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
  }
});

test('K3 normalizes documented and Hermes reasoning aliases, rejects unsupported values, and preserves reasoning_content in tool history', async () => {
  resetKimi();
  db.prepare("INSERT INTO provider_accounts (provider,label,secret,max_in_flight) VALUES ('kimi','k3-controls','sk-k3-controls',10)").run();
  const originalFetch = globalThis.fetch;
  const sentBodies: any[] = [];
  globalThis.fetch = (async (_url: any, init: any) => {
    sentBodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ id: 'cmpl-k3', usage: { prompt_tokens: 2, completion_tokens: 1 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as any;
  const app = await kimiApp();
  try {
    const alias = await app.inject({
      method: 'POST',
      url: '/v1/kimi/chat/completions',
      headers: { authorization: `Bearer ${tok.raw}` },
      payload: {
        model: 'k3',
        reasoning_effort: 'xhigh',
        messages: [
          { role: 'assistant', reasoning_content: 'keep-this-reasoning', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'tool', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: 'call_1', content: 'result' },
        ],
      },
    });
    assert.equal(alias.statusCode, 200, alias.body);
    assert.equal(sentBodies[0].reasoning_effort, 'max');
    assert.equal(sentBodies[0].messages[0].reasoning_content, 'keep-this-reasoning');

    for (const reasoning_effort of ['high', 'low']) {
      const hermesAlias = await app.inject({
        method: 'POST',
        url: '/v1/kimi/chat/completions',
        headers: { authorization: `Bearer ${tok.raw}` },
        payload: { model: 'k3', reasoning_effort, messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.equal(hermesAlias.statusCode, 200, hermesAlias.body);
    }
    assert.deepEqual(sentBodies.slice(1).map((body) => body.reasoning_effort), ['max', 'max']);

    const unsupported = await app.inject({
      method: 'POST',
      url: '/v1/kimi/chat/completions',
      headers: { authorization: `Bearer ${tok.raw}` },
      payload: { model: 'k3', reasoning_effort: 'medium', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(unsupported.statusCode, 400, unsupported.body);
    assert.equal(unsupported.json().error.code, 'invalid_reasoning_effort');
    assert.equal(sentBodies.length, 3, 'unsupported efforts must not be sent upstream');
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
  }
});

test('omitted Kimi model cannot bypass provider deny_all', async () => {
  resetKimi();
  db.prepare("INSERT INTO provider_accounts (provider,label,secret,max_in_flight) VALUES ('kimi','deny-all','sk-deny-all',10)").run();
  db.prepare("UPDATE user_provider_access_modes SET mode='deny_all' WHERE user_id=? AND provider='kimi'").run(devUserId);
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response('{}', { status: 200 });
  }) as any;
  const app = await kimiApp();
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/kimi/chat/completions',
      headers: { authorization: `Bearer ${tok.raw}` },
      payload: { messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(res.json().error.code, 'model_not_allowed_for_user');
    assert.equal(called, false, 'upstream must not be selected or called');
  } finally {
    globalThis.fetch = originalFetch;
    db.prepare("UPDATE user_provider_access_modes SET mode='allow_all' WHERE user_id=? AND provider='kimi'").run(devUserId);
    await app.close();
  }
});

test('Kimi 429 with Retry-After cools account and retries next account', async () => {
  resetKimi();
  const first = Number(db.prepare("INSERT INTO provider_accounts (provider,label,secret,max_in_flight) VALUES ('kimi','first','sk-first',10)").run().lastInsertRowid);
  const second = Number(db.prepare("INSERT INTO provider_accounts (provider,label,secret,max_in_flight) VALUES ('kimi','second','sk-second',10)").run().lastInsertRowid);
  assert.ok(first < second);
  const conv = conversationForIndex(0, 2);
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (_url: any, init: any) => {
    calls.push(String((init.headers as Headers).get('authorization')));
    if (calls.length === 1) return new Response('too many', { status: 429, headers: { 'retry-after': '60' } });
    return new Response(JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 4 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  const app = await kimiApp();
  const res = await app.inject({ method: 'POST', url: '/v1/kimi/chat/completions', headers: { authorization: `Bearer ${tok.raw}`, 'x-conversation-id': conv }, payload: { model: 'kimi-k2.6', messages: [{ role: 'user', content: 'hi' }] } });
  globalThis.fetch = originalFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(calls.length, 2);
  assert.equal(calls[0], 'Bearer sk-first');
  assert.equal(calls[1], 'Bearer sk-second');
  const cooled = db.prepare('SELECT status,cooldown_until FROM provider_accounts WHERE id=?').get(first) as any;
  assert.equal(cooled.status, 'cooldown');
  assert.ok(cooled.cooldown_until > Date.now() + 55_000);
  await app.close();
});

test('releaseKimiSlot runs on upstream/network error', async () => {
  resetKimi();
  const id = Number(db.prepare("INSERT INTO provider_accounts (provider,label,secret,max_in_flight) VALUES ('kimi','error-release','sk-error',1)").run().lastInsertRowid);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('boom'); }) as any;
  const app = await kimiApp();
  const res = await app.inject({ method: 'POST', url: '/v1/kimi/chat/completions', headers: { authorization: `Bearer ${tok.raw}` }, payload: { model: 'kimi-k2.6', messages: [{ role: 'user', content: 'hi' }] } });
  globalThis.fetch = originalFetch;
  assert.equal(res.statusCode, 429);
  assert.equal(kimiPool.getKimiInFlightSnapshot()[id], 0);
  await app.close();
});

test('Anthropic-style Kimi route returns 200 and parses usage.input_tokens/output_tokens', async () => {
  resetKimi();
  db.prepare("INSERT INTO provider_accounts (provider,label,secret,max_in_flight) VALUES ('kimi','anthropic-style','sk-anthropic-style',10)").run();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any) => {
    assert.equal((init.headers as Headers).get('anthropic-version'), '2023-06-01');
    return new Response(JSON.stringify({ id: 'msg', usage: { input_tokens: 13, output_tokens: 5 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  const app = await kimiApp();
  const res = await app.inject({ method: 'POST', url: '/v1/kimi/messages', headers: { authorization: `Bearer ${tok.raw}` }, payload: { model: 'kimi-k2.6', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } });
  globalThis.fetch = originalFetch;
  assert.equal(res.statusCode, 200, res.body);
  const usage = db.prepare("SELECT input_tokens,output_tokens,estimated_cost_usd FROM usage_events WHERE provider='kimi' ORDER BY id DESC LIMIT 1").get() as any;
  assert.equal(usage.input_tokens, 13);
  assert.equal(usage.output_tokens, 5);
  // Notional retail-equivalent cost: 13 in * $0.95/1M + 5 out * $4/1M, rounded 6dp.
  assert.ok(Math.abs(usage.estimated_cost_usd - (Math.round((13 * 0.95 / 1e6 + 5 * 4.0 / 1e6) * 1e6) / 1e6)) < 1e-9);
  await app.close();
});

test('Kimi content_filter is surfaced and force-logged', async () => {
  resetKimi();
  db.prepare("INSERT INTO provider_accounts (provider,label,secret,max_in_flight) VALUES ('kimi','filter','sk-filter',10)").run();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'content_filter' }], usage: { prompt_tokens: 5, completion_tokens: 0 } }), { status: 200, headers: { 'content-type': 'application/json' } })) as any;
  const app = await kimiApp();
  const res = await app.inject({ method: 'POST', url: '/v1/kimi/chat/completions', headers: { authorization: `Bearer ${tok.raw}` }, payload: { model: 'kimi-k2.6', messages: [{ role: 'user', content: 'blocked' }] } });
  globalThis.fetch = originalFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().choices[0].message.content, '⛔ kimi safety filter blocked this response (content_filter).');
  const log = db.prepare('SELECT request_json FROM request_logs ORDER BY id DESC LIMIT 1').get() as any;
  assert.equal(JSON.parse(log.request_json).forcedLogReason, 'kimi_content_filter');
  await app.close();
});

test('Kimi length finish_reason appends truncation marker without force-log', async () => {
  resetKimi();
  db.prepare("INSERT INTO provider_accounts (provider,label,secret,max_in_flight) VALUES ('kimi','length','sk-length',10)").run();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'partial' }, finish_reason: 'length' }], usage: { prompt_tokens: 5, completion_tokens: 3 } }), { status: 200, headers: { 'content-type': 'application/json' } })) as any;
  const app = await kimiApp();
  const res = await app.inject({ method: 'POST', url: '/v1/kimi/chat/completions', headers: { authorization: `Bearer ${tok.raw}` }, payload: { model: 'kimi-k2.6', messages: [{ role: 'user', content: 'long' }] } });
  globalThis.fetch = originalFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().choices[0].message.content, 'partial\n\n[truncated: length]');
  assert.equal((db.prepare('SELECT COUNT(*) n FROM request_logs').get() as any).n, 0);
  await app.close();
});

test('Kimi interrupted stream emits visible tail and force-logs', async () => {
  resetKimi();
  db.prepare("INSERT INTO provider_accounts (provider,label,secret,max_in_flight) VALUES ('kimi','interrupt','sk-interrupt',10)").run();
  const sse = 'data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as any;
  const app = await kimiApp();
  const res = await app.inject({ method: 'POST', url: '/v1/kimi/chat/completions', headers: { authorization: `Bearer ${tok.raw}` }, payload: { model: 'kimi-k2.6', stream: true, messages: [{ role: 'user', content: 'hi' }] } });
  globalThis.fetch = originalFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.match(res.body, /Stream interrupted; partial response above/);
  assert.match(res.body, /data: \[DONE\]/);
  const log = db.prepare('SELECT request_json FROM request_logs ORDER BY id DESC LIMIT 1').get() as any;
  assert.equal(JSON.parse(log.request_json).forcedLogReason, 'kimi_stream_interrupted');
  await app.close();
});

test('Kimi 429 with insufficient_balance body gets long cooldown (not 60s)', async () => {
  resetKimi();
  const deadId = Number(db.prepare("INSERT INTO provider_accounts (provider,label,secret,status,enabled,max_in_flight) VALUES ('kimi','kimi-dead','sk-kimi-dead','active',1,10)").run().lastInsertRowid);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    error: { type: 'exceeded_current_quota_error', message: 'Your account is suspended due to insufficient balance, please recharge your account or check your plan and billing details' },
  }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '60' } })) as any;
  const app = await kimiApp();
  await app.inject({ method: 'POST', url: '/v1/kimi/chat/completions', headers: { authorization: `Bearer ${tok.raw}` }, payload: { model: 'kimi-k2.6', messages: [{ role: 'user', content: 'hi' }] } });
  globalThis.fetch = originalFetch;
  await app.close();
  const row = db.prepare('SELECT status, cooldown_until FROM provider_accounts WHERE id=?').get(deadId) as any;
  assert.equal(row.status, 'cooldown');
  // Long cooldown: >= 23h (not the 60s retry-after default)
  const remainingMs = row.cooldown_until - Date.now();
  assert.ok(remainingMs >= 23 * 60 * 60 * 1000, `expected >=23h cooldown, got ${Math.round(remainingMs/3600/1000)}h`);
  const evt = db.prepare("SELECT reason FROM provider_health_events WHERE provider_account_id=? ORDER BY id DESC LIMIT 1").get(deadId) as any;
  assert.match(String(evt?.reason || ''), /insufficient_balance/);
});

// ─── context caching: prompt_cache_key forwarding + top-level cached_tokens ───

test('Kimi chat route forwards prompt_cache_key from x-conversation-id (Code Plan cache)', async () => {
  resetKimi();
  db.prepare("INSERT INTO provider_accounts (provider,label,secret,max_in_flight) VALUES ('kimi','cache-key','sk-cache-key',10)").run();
  const originalFetch = globalThis.fetch;
  let sentBody: any;
  globalThis.fetch = (async (_url: any, init: any) => {
    sentBody = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ id: 'cmpl', usage: { prompt_tokens: 100, completion_tokens: 5, cached_tokens: 90 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  const app = await kimiApp();
  const res = await app.inject({ method: 'POST', url: '/v1/kimi/chat/completions', headers: { authorization: `Bearer ${tok.raw}`, 'x-conversation-id': 'sess-abc-123' }, payload: { model: 'kimi-k2.6', messages: [{ role: 'user', content: 'hi' }] } });
  globalThis.fetch = originalFetch;
  assert.equal(res.statusCode, 200, res.body);
  // The documented Kimi Code Plan cache key MUST be forwarded upstream.
  assert.equal(sentBody.prompt_cache_key, 'sess-abc-123');
  // Billing/usage mapping unchanged: top-level usage.cached_tokens -> cache_read_tokens.
  const usage = db.prepare("SELECT input_tokens,output_tokens,cache_read_tokens FROM usage_events WHERE provider='kimi' ORDER BY id DESC LIMIT 1").get() as any;
  assert.equal(usage.input_tokens, 100);
  assert.equal(usage.output_tokens, 5);
  assert.equal(usage.cache_read_tokens, 90);
  await app.close();
});

test('Kimi chat route does NOT override a client-supplied prompt_cache_key', async () => {
  resetKimi();
  db.prepare("INSERT INTO provider_accounts (provider,label,secret,max_in_flight) VALUES ('kimi','cache-key2','sk-cache-key2',10)").run();
  const originalFetch = globalThis.fetch;
  let sentBody: any;
  globalThis.fetch = (async (_url: any, init: any) => {
    sentBody = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ id: 'cmpl', usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  const app = await kimiApp();
  const res = await app.inject({ method: 'POST', url: '/v1/kimi/chat/completions', headers: { authorization: `Bearer ${tok.raw}`, 'x-conversation-id': 'sess-ignored' }, payload: { model: 'kimi-k2.6', prompt_cache_key: 'client-key', messages: [{ role: 'user', content: 'hi' }] } });
  globalThis.fetch = originalFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(sentBody.prompt_cache_key, 'client-key');
  await app.close();
});

test('Kimi Anthropic /messages route does NOT inject prompt_cache_key', async () => {
  resetKimi();
  db.prepare("INSERT INTO provider_accounts (provider,label,secret,max_in_flight) VALUES ('kimi','no-key-anthropic','sk-no-key',10)").run();
  const originalFetch = globalThis.fetch;
  let sentBody: any;
  globalThis.fetch = (async (_url: any, init: any) => {
    sentBody = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ id: 'msg', usage: { input_tokens: 13, output_tokens: 5 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  const app = await kimiApp();
  const res = await app.inject({ method: 'POST', url: '/v1/kimi/messages', headers: { authorization: `Bearer ${tok.raw}`, 'x-conversation-id': 'sess-xyz' }, payload: { model: 'kimi-k2.6', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } });
  globalThis.fetch = originalFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(sentBody.prompt_cache_key, undefined);
  await app.close();
});
