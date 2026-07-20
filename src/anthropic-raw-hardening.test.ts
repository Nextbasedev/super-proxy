import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';

process.env.DATABASE_PATH = path.join(os.tmpdir(), `nbmg-anthropic-raw-hardening-${process.pid}.sqlite`);
process.env.ANTHROPIC_UPSTREAM_URL = 'https://anthropic.test';

const { getDb } = await import('./db/index.js');
const { migrate } = await import('./db/migrate.js');
const { sha256 } = await import('./utils/crypto.js');
const { registerAnthropicProxy } = await import('./proxy/anthropic.js');
const { registerCompressionMiddleware } = await import('./proxy/compress.js');
const { config } = await import('./config.js');
const { registerBrowserCors } = await import('./http/cors.js');

migrate();

function resetTables() {
  const db = getDb();
  db.prepare('DELETE FROM request_logs').run();
  db.prepare('DELETE FROM provider_health_events').run();
  db.prepare('DELETE FROM usage_events').run();
  db.prepare('DELETE FROM api_tokens').run();
  db.prepare('DELETE FROM users WHERE email != ?').run('admin@localhost');
  db.prepare('DELETE FROM provider_accounts').run();
}

function seed(raw: string, label: string, secret: string) {
  const db = getDb();
  const userId = Number(db.prepare("INSERT INTO users (email,role,is_admin,enabled,full_body_logging) VALUES ('raw-hardening@example.com','developer',0,1,0)").run().lastInsertRowid);
  db.prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(userId, 'anthropic', 'allow_all');
  db.prepare('INSERT INTO api_tokens (user_id,label,token_hash,token_prefix,enabled) VALUES (?,?,?,?,1)').run(userId, 'raw-hardening-token', sha256(raw), raw.slice(0, 14));
  db.prepare("INSERT INTO provider_accounts (provider,label,secret,status,enabled) VALUES ('anthropic',?,?, 'active',1)").run(label, secret);
}

async function buildApp(withCompression = false, withCors = false) {
  const app = Fastify({ logger: false });
  if (withCors) await registerBrowserCors(app);
  registerAnthropicProxy(app);
  if (withCompression) registerCompressionMiddleware(app);
  await app.ready();
  return app;
}

test('raw Anthropic route strips every gateway credential alias and hop-by-hop header', async () => {
  resetTables();
  const raw = 'anthropic_raw_header_token';
  const upstreamSecret = 'sk-ant-oat-raw-headers';
  seed(raw, 'raw-header-oauth', upstreamSecret);
  const captured: Headers[] = [];
  const originalFetch = global.fetch;
  global.fetch = (async (_url: string, init: any) => {
    captured.push(new Headers(init.headers));
    return new Response('{"type":"message","content":[],"usage":{"input_tokens":1,"output_tokens":0}}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  const app = await buildApp();
  const authCases = [
    { name: 'authorization', value: `Bearer ${raw}` },
    { name: 'authorization', value: raw },
    { name: 'x-api-key', value: raw },
    { name: 'api-key', value: raw },
    { name: 'apikey', value: raw },
  ];
  try {
    for (const auth of authCases) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/anthropic-raw/v1/messages',
        headers: {
          [auth.name]: auth.value,
          connection: 'x-hop-secret',
          'proxy-connection': 'x-proxy-hop-secret',
          'x-hop-secret': 'must-not-leak',
          'x-proxy-hop-secret': 'must-not-leak',
          cookie: 'gateway-session=must-not-leak',
        },
        payload: { model: 'claude-opus-4-7', stream: false, messages: [{ role: 'user', content: 'headers' }] },
      });
      assert.equal(res.statusCode, 200, `${auth.name}: ${res.body}`);
    }
    assert.equal(captured.length, authCases.length);
    for (const headers of captured) {
      assert.equal(headers.get('authorization'), `Bearer ${upstreamSecret}`);
      assert.equal(headers.get('x-api-key'), null);
      assert.equal(headers.get('api-key'), null);
      assert.equal(headers.get('apikey'), null);
      assert.equal(headers.get('connection'), null);
      assert.equal(headers.get('proxy-connection'), null);
      assert.equal(headers.get('x-hop-secret'), null);
      assert.equal(headers.get('x-proxy-hop-secret'), null);
      assert.equal(headers.get('cookie'), null);
    }
  } finally {
    global.fetch = originalFetch;
    await app.close();
  }
});

test('production compression middleware cannot mutate the raw Anthropic route', async () => {
  resetTables();
  const raw = 'anthropic_raw_compression_token';
  seed(raw, 'raw-compression-oauth', 'sk-ant-oat-fixture');
  const payload = {
    model: 'claude-opus-4-7',
    stream: false,
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: `ORIGINAL-${'x'.repeat(12000)}` }] }],
  };
  const originalFetch = global.fetch;
  const originalEnabled = config.headroomEnabled;
  const originalEnv = process.env.HEADROOM_ENABLED;
  let headroomCalls = 0;
  let capturedBody: any;
  config.headroomEnabled = true;
  process.env.HEADROOM_ENABLED = 'true';
  global.fetch = (async (url: string, init: any) => {
    if (String(url).includes(config.headroomUrl)) {
      headroomCalls += 1;
      return new Response(JSON.stringify({ messages: [{ role: 'user', content: 'COMPRESSED' }], tokens_before: 3000, tokens_after: 1, tokens_saved: 2999 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    capturedBody = JSON.parse(String(init.body));
    return new Response('{"type":"message","content":[],"usage":{"input_tokens":1,"output_tokens":0}}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  const app = await buildApp(true);
  try {
    const res = await app.inject({ method: 'POST', url: '/v1/anthropic-raw/v1/messages', headers: { authorization: `Bearer ${raw}` }, payload });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(headroomCalls, 0);
    assert.deepEqual(capturedBody, payload);
  } finally {
    global.fetch = originalFetch;
    config.headroomEnabled = originalEnabled;
    if (originalEnv === undefined) delete process.env.HEADROOM_ENABLED;
    else process.env.HEADROOM_ENABLED = originalEnv;
    await app.close();
  }
});
