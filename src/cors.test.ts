import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';

process.env.DATABASE_PATH = path.join(os.tmpdir(), `nbmg-cors-${process.pid}.sqlite`);
process.env.ANTHROPIC_UPSTREAM_URL = 'https://anthropic.cors.test';

const { getDb } = await import('./db/index.js');
const { migrate } = await import('./db/migrate.js');
const { sha256 } = await import('./utils/crypto.js');
const { registerAnthropicProxy } = await import('./proxy/anthropic.js');
const { registerBrowserCors } = await import('./http/cors.js');

const ORIGIN = 'https://browser.example';
const REQUESTED_HEADERS = [
  'Authorization',
  'Content-Type',
  'x-api-key',
  'api-key',
  'apikey',
  'anthropic-version',
  'anthropic-beta',
  'x-conversation-id',
];

function assertActualCors(headers: Record<string, unknown>) {
  assert.equal(headers['access-control-allow-origin'], ORIGIN);
  assert.notEqual(headers['access-control-allow-origin'], '*');
  assert.equal(headers['access-control-allow-credentials'], 'true');
  assert.match(String(headers.vary), /(?:^|,\s*)Origin(?:,|$)/i);
}

function resetAndSeed() {
  const db = getDb();
  db.prepare('DELETE FROM request_logs').run();
  db.prepare('DELETE FROM provider_health_events').run();
  db.prepare('DELETE FROM usage_events').run();
  db.prepare('DELETE FROM api_tokens').run();
  db.prepare('DELETE FROM user_provider_access_modes').run();
  db.prepare('DELETE FROM users WHERE email != ?').run('daxitm2112@gmail.com');
  db.prepare('DELETE FROM provider_accounts').run();

  const raw = 'nbmg_cors_browser_test_token';
  const userId = Number(db.prepare("INSERT INTO users (email,role,is_admin,enabled,full_body_logging) VALUES ('cors@example.com','developer',0,1,0)").run().lastInsertRowid);
  db.prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(userId, 'anthropic', 'allow_all');
  db.prepare('INSERT INTO api_tokens (user_id,label,token_hash,token_prefix,enabled) VALUES (?,?,?,?,1)').run(userId, 'cors-token', sha256(raw), raw.slice(0, 14));
  db.prepare("INSERT INTO provider_accounts (provider,label,secret,status,enabled) VALUES ('anthropic','cors-anthropic','sk-ant-cors','active',1)").run();
  return raw;
}

migrate();

test('browser CORS covers preflight, JSON, SSE, and auth errors on a real proxy route', async (t) => {
  const raw = resetAndSeed();
  const originalFetch = global.fetch;
  global.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}'));
    if (body.stream) {
      return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    return new Response(JSON.stringify({
      id: 'msg_cors',
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  const app = Fastify({ logger: false });
  await registerBrowserCors(app);
  registerAnthropicProxy(app);
  await app.ready();

  try {
    await t.test('OPTIONS preflight echoes the credentialed origin and allows browser headers', async () => {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/v1/messages',
        headers: {
          origin: ORIGIN,
          'access-control-request-method': 'POST',
          'access-control-request-headers': REQUESTED_HEADERS.join(', '),
        },
      });
      assert.equal(res.statusCode, 204, res.body);
      assertActualCors(res.headers);
      const allowed = String(res.headers['access-control-allow-headers']).toLowerCase().split(',').map((value) => value.trim());
      for (const header of REQUESTED_HEADERS) assert.ok(allowed.includes(header.toLowerCase()), `missing allowed header: ${header}`);
    });

    await t.test('successful non-stream JSON response includes CORS headers', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/messages',
        headers: { origin: ORIGIN, authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
        payload: { model: 'claude-cors-test', stream: false, messages: [{ role: 'user', content: 'hello' }] },
      });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json().content[0].text, 'ok');
      assertActualCors(res.headers);
    });

    await t.test('successful SSE response includes CORS headers', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/messages',
        headers: { origin: ORIGIN, authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
        payload: { model: 'claude-cors-test', stream: true, messages: [{ role: 'user', content: 'hello' }] },
      });
      assert.equal(res.statusCode, 200, res.body);
      assert.match(String(res.headers['content-type']), /^text\/event-stream/);
      assert.match(res.body, /event: message_stop/);
      assertActualCors(res.headers);
    });

    await t.test('authentication error includes CORS headers', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/messages',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        payload: { model: 'claude-cors-test', stream: false, messages: [] },
      });
      assert.equal(res.statusCode, 401, res.body);
      assertActualCors(res.headers);
    });
  } finally {
    await app.close();
    global.fetch = originalFetch;
  }
});
