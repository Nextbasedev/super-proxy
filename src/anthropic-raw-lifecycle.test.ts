import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';

process.env.DATABASE_PATH = path.join(os.tmpdir(), `nbmg-anthropic-raw-lifecycle-${process.pid}.sqlite`);
process.env.ANTHROPIC_UPSTREAM_URL = 'https://anthropic.test';

const { getDb } = await import('./db/index.js');
const { migrate } = await import('./db/migrate.js');
const { sha256 } = await import('./utils/crypto.js');
const { registerAnthropicProxy } = await import('./proxy/anthropic.js');
const { registerBrowserCors } = await import('./http/cors.js');

const ORIGIN = 'https://browser.example';
const encoder = new TextEncoder();

migrate();

function resetAndSeed(raw: string, label: string) {
  const db = getDb();
  db.prepare('DELETE FROM request_logs').run();
  db.prepare('DELETE FROM provider_health_events').run();
  db.prepare('DELETE FROM usage_events').run();
  db.prepare('DELETE FROM api_tokens').run();
  db.prepare('DELETE FROM users WHERE email != ?').run('admin@localhost');
  db.prepare('DELETE FROM provider_accounts').run();
  const userId = Number(db.prepare("INSERT INTO users (email,role,is_admin,enabled,full_body_logging) VALUES ('raw-lifecycle@example.com','developer',0,1,0)").run().lastInsertRowid);
  db.prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(userId, 'anthropic', 'allow_all');
  db.prepare('INSERT INTO api_tokens (user_id,label,token_hash,token_prefix,enabled) VALUES (?,?,?,?,1)').run(userId, 'raw-lifecycle-token', sha256(raw), raw.slice(0, 14));
  db.prepare("INSERT INTO provider_accounts (provider,label,secret,status,enabled) VALUES ('anthropic',?,?, 'active',1)").run(label, 'sk-ant-oat-raw-lifecycle');
}

async function buildApp(withCors = false) {
  const app = Fastify({ logger: false });
  if (withCors) await registerBrowserCors(app);
  registerAnthropicProxy(app);
  await app.ready();
  return app;
}

function rawRequest(raw: string, stream = true, origin?: string) {
  return {
    method: 'POST' as const,
    url: '/v1/anthropic-raw/v1/messages',
    headers: { authorization: `Bearer ${raw}`, ...(origin ? { origin } : {}) },
    payload: { model: 'claude-opus-4-7', stream, messages: [{ role: 'user', content: 'raw lifecycle' }] },
  };
}

test('raw stream read failure after first chunk terminates safely without retrying', async () => {
  const raw = 'anthropic_raw_abrupt_stream_token';
  resetAndSeed(raw, 'raw-abrupt-stream');
  const firstChunk = 'event: message_start\r\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\r\n\r\n';
  let pulls = 0;
  let fetchCalls = 0;
  const originalFetch = global.fetch;
  global.fetch = (async () => {
    fetchCalls += 1;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(encoder.encode(firstChunk));
        else controller.error(new Error('simulated upstream reader failure'));
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as any;
  const app = await buildApp();
  try {
    const res = await app.inject(rawRequest(raw));
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.body, firstChunk);
    assert.equal(fetchCalls, 1);
    const usage = getDb().prepare('SELECT status_code,error FROM usage_events ORDER BY id DESC LIMIT 1').get() as any;
    assert.equal(usage.status_code, 502);
    assert.match(usage.error, /simulated upstream reader failure/);
    assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM usage_events').get() as any).n, 1);
    const health = getDb().prepare('SELECT status,reason FROM provider_health_events ORDER BY id DESC LIMIT 1').get() as any;
    assert.equal(health.status, 'cooldown');
    assert.equal(health.reason, 'anthropic_stream_read_error');
  } finally {
    global.fetch = originalFetch;
    await app.close();
  }
});

test('raw downstream write failure terminates without retrying or cooling the upstream account', async () => {
  const raw = 'anthropic_raw_downstream_write_token';
  resetAndSeed(raw, 'raw-downstream-write');
  let fetchCalls = 0;
  const originalFetch = global.fetch;
  global.fetch = (async () => {
    fetchCalls += 1;
    return new Response('event: message_stop\r\ndata: {"type":"message_stop"}\r\n\r\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as any;
  const app = Fastify({ logger: false });
  app.addHook('onRequest', (req, reply, done) => {
    if (req.url.startsWith('/v1/anthropic-raw/')) {
      reply.raw.write = (() => { throw new Error('simulated downstream write failure'); }) as any;
    }
    done();
  });
  registerAnthropicProxy(app);
  await app.ready();
  try {
    const res = await app.inject(rawRequest(raw));
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(fetchCalls, 1);
    const usage = getDb().prepare('SELECT status_code,error FROM usage_events ORDER BY id DESC LIMIT 1').get() as any;
    assert.equal(usage.status_code, 200);
    assert.match(usage.error, /simulated downstream write failure/);
    assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM usage_events').get() as any).n, 1);
    assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM provider_health_events').get() as any).n, 0);
    const account = getDb().prepare("SELECT status FROM provider_accounts WHERE label='raw-downstream-write'").get() as any;
    assert.equal(account.status, 'active');
  } finally {
    global.fetch = originalFetch;
    await app.close();
  }
});

test('raw split CRLF SSE error remains byte-identical and cools down the account', async () => {
  const raw = 'anthropic_raw_sse_error_token';
  resetAndSeed(raw, 'raw-sse-error');
  const event = 'event: error\r\ndata: {"type":"error","error":{"type":"overloaded_error","message":"raw stream overload"}}\r\n\r\n';
  const bytes = encoder.encode(event);
  const originalFetch = global.fetch;
  global.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, 17));
      controller.enqueue(bytes.slice(17, 61));
      controller.enqueue(bytes.slice(61));
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })) as any;
  const app = await buildApp();
  try {
    const res = await app.inject(rawRequest(raw));
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.body, event);
    const health = getDb().prepare('SELECT status,reason FROM provider_health_events ORDER BY id DESC LIMIT 1').get() as any;
    assert.equal(health.status, 'cooldown');
    assert.equal(health.reason, 'anthropic_mid_stream_error');
    const usage = getDb().prepare('SELECT error FROM usage_events ORDER BY id DESC LIMIT 1').get() as any;
    assert.equal(usage.error, 'raw stream overload');
  } finally {
    global.fetch = originalFetch;
    await app.close();
  }
});

test('raw JSON and SSE keep gateway CORS and reject upstream hop-by-hop overrides', async () => {
  const raw = 'anthropic_raw_cors_token';
  resetAndSeed(raw, 'raw-cors');
  const originalFetch = global.fetch;
  global.fetch = (async (_url: string, init: any) => {
    const body = JSON.parse(String(init.body));
    const headers = {
      'content-type': body.stream ? 'text/event-stream' : 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-credentials': 'false',
      'cross-origin-opener-policy': 'unsafe-none',
      vary: '*',
      'proxy-connection': 'x-ratelimit-limit',
      'x-ratelimit-limit': '10',
      'request-id': body.stream ? 'req_raw_cors_stream' : 'req_raw_cors_json',
    };
    if (body.stream) return new Response('event: message_stop\r\ndata: {"type":"message_stop"}\r\n\r\n', { status: 200, headers });
    return new Response('{"type":"message","content":[],"usage":{"input_tokens":1,"output_tokens":0}}', { status: 200, headers });
  }) as any;
  const app = await buildApp(true);
  try {
    for (const stream of [false, true]) {
      const res = await app.inject(rawRequest(raw, stream, ORIGIN));
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.headers['access-control-allow-origin'], ORIGIN);
      assert.equal(res.headers['access-control-allow-credentials'], 'true');
      assert.match(String(res.headers.vary), /(?:^|,\s*)Origin(?:,|$)/i);
      assert.equal(res.headers['cross-origin-opener-policy'], undefined);
      assert.equal(res.headers['proxy-connection'], undefined);
      assert.equal(res.headers['x-ratelimit-limit'], undefined);
      assert.equal(res.headers['request-id'], stream ? 'req_raw_cors_stream' : 'req_raw_cors_json');
    }
  } finally {
    global.fetch = originalFetch;
    await app.close();
  }
});
