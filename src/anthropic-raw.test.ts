import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';

process.env.DATABASE_PATH = path.join(os.tmpdir(), `nbmg-anthropic-raw-${process.pid}.sqlite`);
process.env.ANTHROPIC_UPSTREAM_URL = 'https://anthropic.test';

const { getDb } = await import('./db/index.js');
const { migrate } = await import('./db/migrate.js');
const { sha256 } = await import('./utils/crypto.js');
const { registerAnthropicProxy } = await import('./proxy/anthropic.js');

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
  const userId = Number(db.prepare("INSERT INTO users (email,role,is_admin,enabled,full_body_logging) VALUES ('raw@example.com','developer',0,1,0)").run().lastInsertRowid);
  db.prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(userId, 'anthropic', 'allow_all');
  db.prepare('INSERT INTO api_tokens (user_id,label,token_hash,token_prefix,enabled) VALUES (?,?,?,?,1)').run(userId, 'raw-token', sha256(raw), raw.slice(0, 14));
  db.prepare("INSERT INTO provider_accounts (provider,label,secret,status,enabled) VALUES ('anthropic',?,?, 'active',1)").run(label, secret);
}

async function buildApp() {
  const app = Fastify({ logger: false });
  registerAnthropicProxy(app);
  await app.ready();
  return app;
}

test('raw Anthropic route bypasses OAuth request and non-stream response patches', async () => {
  resetTables();
  const raw = 'anthropic_raw_passthrough_token';
  seed(raw, 'raw-oauth', 'sk-ant-oat-raw-test');
  const payload = {
    model: 'claude-opus-4-7',
    stream: false,
    max_tokens: 32,
    system: 'Keep this system prompt unchanged.',
    messages: [{ role: 'user', content: 'Mention OCPlatform and HEARTBEAT_OK exactly.' }],
    tools: [{ name: 'mcp_bash', description: 'unchanged', input_schema: { type: 'object', properties: {} } }],
  };
  const upstreamBody = {
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-7',
    content: [],
    stop_reason: 'refusal',
    stop_details: { category: 'test', explanation: 'Preserve this raw refusal.' },
    usage: { input_tokens: 7, output_tokens: 0 },
  };
  let capturedBody: any;
  let capturedHeaders: Headers | undefined;
  const originalFetch = global.fetch;
  global.fetch = (async (_url: string, init: any) => {
    capturedBody = JSON.parse(String(init.body));
    capturedHeaders = new Headers(init.headers);
    return new Response(JSON.stringify(upstreamBody), { status: 200, headers: {
      'content-type': 'application/json',
      'request-id': 'req_raw_success',
      'anthropic-ratelimit-requests-remaining': '9',
      'x-gateway-provider': 'must-not-override',
      'set-cookie': 'must-not-leak=1',
    } });
  }) as any;
  const app = await buildApp();
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/anthropic-raw/v1/messages',
      headers: {
        authorization: `Bearer ${raw}`,
        'content-type': 'application/json',
        'user-agent': 'claude-cli/raw-test',
        'anthropic-beta': 'client-beta',
      },
      payload,
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(capturedBody, payload);
    assert.equal(capturedHeaders?.get('user-agent'), 'claude-cli/raw-test');
    assert.equal(capturedHeaders?.get('anthropic-beta'), 'client-beta');
    assert.equal(capturedHeaders?.get('x-app'), null);
    assert.deepEqual(res.json(), upstreamBody);
    assert.equal(res.headers['request-id'], 'req_raw_success');
    assert.equal(res.headers['anthropic-ratelimit-requests-remaining'], '9');
    assert.equal(res.headers['x-gateway-provider'], 'anthropic');
    assert.equal(res.headers['set-cookie'], undefined);
    const usage = getDb().prepare('SELECT endpoint FROM usage_events ORDER BY id DESC LIMIT 1').get() as any;
    assert.equal(usage.endpoint, '/v1/anthropic-raw/v1/messages');
  } finally {
    global.fetch = originalFetch;
    await app.close();
  }
});

test('raw Anthropic route preserves upstream SSE and HTTP errors without synthesis or fallback', async () => {
  resetTables();
  const raw = 'anthropic_raw_stream_token';
  seed(raw, 'raw-stream-oauth', 'sk-ant-oat-raw-stream');
  const rawSse = 'event: message_start\r\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\r\n\r\nevent: message_delta\r\ndata: {"type":"message_delta","delta":{"stop_reason":"refusal","stop_details":{"category":"raw"}}}\r\n\r\n';
  const originalFetch = global.fetch;
  let mode: 'stream' | 'error' = 'stream';
  global.fetch = (async () => mode === 'stream'
    ? new Response(rawSse, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_raw_stream' } })
    : new Response('{"type":"error","error":{"type":"overloaded_error","message":"raw overload"}}', { status: 529, headers: { 'content-type': 'application/json', 'retry-after': '17', 'request-id': 'req_raw_error' } })) as any;
  const app = await buildApp();
  try {
    const streamRes = await app.inject({
      method: 'POST',
      url: '/v1/anthropic-raw/v1/messages',
      headers: { authorization: `Bearer ${raw}` },
      payload: { model: 'claude-opus-4-7', stream: true, messages: [{ role: 'user', content: 'stream' }] },
    });
    assert.equal(streamRes.statusCode, 200, streamRes.body);
    assert.equal(streamRes.body, rawSse);
    assert.equal(streamRes.headers['request-id'], 'req_raw_stream');
    assert.doesNotMatch(streamRes.body, /content_block_start|"stop_reason":"interrupted"/);

    mode = 'error';
    const errorRes = await app.inject({
      method: 'POST',
      url: '/v1/anthropic-raw/v1/messages',
      headers: { authorization: `Bearer ${raw}` },
      payload: { model: 'claude-opus-4-7', stream: false, messages: [{ role: 'user', content: 'error' }] },
    });
    assert.equal(errorRes.statusCode, 529);
    assert.equal(errorRes.json().error.message, 'raw overload');
    assert.equal(errorRes.headers['retry-after'], '17');
    assert.equal(errorRes.headers['request-id'], 'req_raw_error');
    const health = getDb().prepare("SELECT status,reason FROM provider_health_events ORDER BY id DESC LIMIT 1").get() as any;
    assert.equal(health.status, 'cooldown');
    assert.equal(health.reason, 'rate_limit');
  } finally {
    global.fetch = originalFetch;
    await app.close();
  }
});
