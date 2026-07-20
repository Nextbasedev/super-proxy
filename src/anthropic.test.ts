import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';

process.env.DATABASE_PATH = path.join(os.tmpdir(), `nbmg-anthropic-${process.pid}.sqlite`);
process.env.ANTHROPIC_UPSTREAM_URL = 'https://anthropic.test';

const { getDb } = await import('./db/index.js');
const { migrate } = await import('./db/migrate.js');
const { sha256 } = await import('./utils/crypto.js');
const { registerAnthropicProxy } = await import('./proxy/anthropic.js');
const { registerGlmProxy } = await import('./proxy/glm.js');
const { config } = await import('./config.js');
const { formatRefusalMessage, buildRefusalSseEvents, surfaceAnthropicErrorBlock } = await import('./proxy/anthropic.js');

function resetTables() {
  const db = getDb();
  db.prepare('DELETE FROM request_logs').run();
  db.prepare('DELETE FROM provider_health_events').run();
  db.prepare('DELETE FROM usage_events').run();
  db.prepare('DELETE FROM api_tokens').run();
  db.prepare('DELETE FROM users WHERE email != ?').run('admin@localhost');
  db.prepare('DELETE FROM provider_accounts').run();
}

function seedUserAndToken(raw = 'nbmg_anthropic_test_token') {
  const db = getDb();
  const userId = Number(db.prepare("INSERT INTO users (email,role,is_admin,enabled,full_body_logging) VALUES ('dev@example.com','developer',0,1,0)").run().lastInsertRowid);
  db.prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(userId, 'anthropic', 'allow_all');
  const tokenId = Number(db.prepare('INSERT INTO api_tokens (user_id,label,token_hash,token_prefix,enabled) VALUES (?,?,?,?,1)').run(userId, 'dev-token', sha256(raw), raw.slice(0, 14)).lastInsertRowid);
  return { raw, userId, tokenId };
}

function seedAnthropic(label: string, secret = 'sk-ant-test') {
  return Number(
    getDb()
      .prepare("INSERT INTO provider_accounts (provider,label,secret,status,enabled) VALUES ('anthropic',?,?, 'active',1)")
      .run(label, secret)
      .lastInsertRowid,
  );
}

function seedGlm(label = 'glm-fallback') {
  const db = getDb();
  db.prepare("INSERT INTO user_provider_access_modes (user_id,provider,mode) SELECT id,'glm','allow_all' FROM users WHERE email='dev@example.com'").run();
  return Number(db.prepare("INSERT INTO provider_accounts (provider,label,secret,status,enabled) VALUES ('glm',?,?, 'active',1)").run(label, 'sk-glm-test').lastInsertRowid);
}

async function buildApp(onRequest?: (req: any) => void) {
  const app = Fastify({ logger: false });
  if (onRequest) app.addHook('onRequest', (req, _reply, done) => { onRequest(req); done(); });
  registerAnthropicProxy(app);
  registerGlmProxy(app);
  await app.ready();
  return app;
}

// Migrate once for the whole file.
migrate();

test('formatRefusalMessage uses category + explanation', () => {
  const msg = formatRefusalMessage({ category: 'cyber', explanation: 'Blocked: cyber stuff.' });
  assert.match(msg, /category: cyber/);
  assert.match(msg, /Blocked: cyber stuff\./);
});

test('formatRefusalMessage falls back when stop_details missing', () => {
  const msg = formatRefusalMessage(undefined);
  assert.match(msg, /category: safety/);
  assert.match(msg, /Anthropic blocked this request/);
});

test('buildRefusalSseEvents uses provided index across all three events', () => {
  const sse = buildRefusalSseEvents('hello', 2);
  const startMatch = sse.match(/content_block_start[^\n]*\ndata: (\{.*\})/);
  const deltaMatch = sse.match(/content_block_delta[^\n]*\ndata: (\{.*\})/);
  const stopMatch = sse.match(/content_block_stop[^\n]*\ndata: (\{.*\})/);
  assert.ok(startMatch && deltaMatch && stopMatch);
  assert.equal(JSON.parse(startMatch![1]).index, 2);
  assert.equal(JSON.parse(deltaMatch![1]).index, 2);
  assert.equal(JSON.parse(stopMatch![1]).index, 2);
  assert.equal(JSON.parse(deltaMatch![1]).delta.text, 'hello');
});

test('stream refusal: injects synthetic content_block_* with explanation and force-logs', async () => {
  resetTables();
  const { raw } = seedUserAndToken();
  seedAnthropic('test-acct');

  const upstreamSse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"model":"claude-opus-4-7","id":"msg_x","type":"message","role":"assistant","content":[],"usage":{"input_tokens":6,"output_tokens":4}}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"refusal","stop_details":{"type":"refusal","category":"cyber","explanation":"Triggered cyber safeguards."}},"usage":{"input_tokens":6,"output_tokens":4}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n');

  const originalFetch = global.fetch;
  global.fetch = (async () =>
    new Response(upstreamSse, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as any;

  const app = await buildApp();
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      payload: { model: 'claude-opus-4-7', stream: true, messages: [{ role: 'user', content: 'demo' }] },
    });
    assert.equal(res.statusCode, 200);
    const body = res.body;
    assert.match(body, /event: content_block_start/);
    assert.match(body, /event: content_block_delta/);
    assert.match(body, /Triggered cyber safeguards\./);
    assert.match(body, /category: cyber/);
    // Original message_delta (refusal) still forwarded.
    assert.match(body, /"stop_reason":"refusal"/);

    // Force-logged even though full_body_logging=0.
    const logs = getDb().prepare('SELECT request_json FROM request_logs').all() as any[];
    assert.equal(logs.length, 1);
    const reqJson = JSON.parse(logs[0].request_json);
    assert.equal(reqJson.forcedLogReason, 'anthropic_refusal');
    assert.equal(reqJson.refusal.category, 'cyber');
  } finally {
    await app.close();
    global.fetch = originalFetch;
  }
});

test('stream refusal indexes synthetic block AFTER prior content blocks', async () => {
  resetTables();
  const { raw } = seedUserAndToken();
  seedAnthropic('test-acct-2');

  const upstreamSse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"model":"claude-opus-4-7","id":"msg_y","type":"message","role":"assistant","content":[],"usage":{"input_tokens":1,"output_tokens":1}}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}',
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"refusal","stop_details":{"category":"cyber","explanation":"Mid-stream block."}},"usage":{"input_tokens":1,"output_tokens":2}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n');

  global.fetch = (async () =>
    new Response(upstreamSse, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as any;

  const app = await buildApp();
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      payload: { model: 'claude-opus-4-7', stream: true, messages: [{ role: 'user', content: 'demo' }] },
    });
    assert.equal(res.statusCode, 200);
    // Synthetic block should use index 1 (after the upstream index-0 block).
    const matches = [...res.body.matchAll(/event: content_block_start\ndata: (\{[^\n]*\})/g)];
    assert.equal(matches.length, 2);
    assert.equal(JSON.parse(matches[0][1]).index, 0);
    assert.equal(JSON.parse(matches[1][1]).index, 1);
  } finally {
    await app.close();
  }
});

test('non-stream refusal: rewrites content[] with formatted message and force-logs', async () => {
  resetTables();
  const { raw } = seedUserAndToken();
  seedAnthropic('test-acct-3');

  const upstreamJson = {
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-7',
    content: [],
    stop_reason: 'refusal',
    stop_details: { type: 'refusal', category: 'cyber', explanation: 'No-stream cyber block.' },
    usage: { input_tokens: 6, output_tokens: 4 },
  };
  global.fetch = (async () =>
    new Response(JSON.stringify(upstreamJson), { status: 200, headers: { 'content-type': 'application/json' } })) as any;

  const app = await buildApp();
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      payload: { model: 'claude-opus-4-7', stream: false, messages: [{ role: 'user', content: 'demo' }] },
    });
    assert.equal(res.statusCode, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.stop_reason, 'refusal');
    assert.equal(parsed.content.length, 1);
    assert.equal(parsed.content[0].type, 'text');
    assert.match(parsed.content[0].text, /No-stream cyber block\./);

    const logs = getDb().prepare('SELECT request_json FROM request_logs').all() as any[];
    assert.equal(logs.length, 1);
    const reqJson = JSON.parse(logs[0].request_json);
    assert.equal(reqJson.forcedLogReason, 'anthropic_refusal');
  } finally {
    await app.close();
  }
});

test('surfaceAnthropicErrorBlock emits a visible text block at the provided index', () => {
  const sse = surfaceAnthropicErrorBlock('visible error', 3);
  const events = [...sse.matchAll(/data: (\{[^\n]*\})/g)].map((m) => JSON.parse(m[1]));
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((e) => e.index), [3, 3, 3]);
  assert.equal(events[1].delta.text, 'visible error');
});

test('stream mid-stream error: injects visible block, cooldowns account, and force-logs', async () => {
  resetTables();
  const { raw } = seedUserAndToken();
  const accountId = seedAnthropic('mid-stream-error');

  const upstreamSse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"model":"claude-opus-4-7","id":"msg_err","type":"message","role":"assistant","content":[],"usage":{"input_tokens":3,"output_tokens":2}}}',
    '',
    'event: error',
    'data: {"type":"error","error":{"type":"overloaded_error","message":"server is overloaded"}}',
    '',
  ].join('\n');

  const originalFetch = global.fetch;
  global.fetch = (async () =>
    new Response(upstreamSse, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as any;

  const app = await buildApp();
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      payload: { model: 'claude-opus-4-7', stream: true, messages: [{ role: 'user', content: 'demo' }] },
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /Anthropic error mid-stream \(type: overloaded_error\): server is overloaded/);
    assert.match(res.body, /"stop_reason":"interrupted"/);

    const log = getDb().prepare('SELECT request_json,response_text FROM request_logs').get() as any;
    const reqJson = JSON.parse(log.request_json);
    assert.equal(reqJson.forcedLogReason, 'anthropic_mid_stream_error');
    assert.equal(reqJson.midStreamError.type, 'overloaded_error');
    assert.match(log.response_text, /server is overloaded/);

    const acct = getDb().prepare('SELECT status,cooldown_until FROM provider_accounts WHERE id=?').get(accountId) as any;
    assert.equal(acct.status, 'cooldown');
    assert.ok(acct.cooldown_until > Date.now());
  } finally {
    await app.close();
    global.fetch = originalFetch;
  }
});

test('stream interruption: closes open block, emits interrupted stop, and force-logs', async () => {
  resetTables();
  const { raw } = seedUserAndToken();
  seedAnthropic('interrupted');

  const upstreamSse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"model":"claude-opus-4-7","id":"msg_int","type":"message","role":"assistant","content":[],"usage":{"input_tokens":1,"output_tokens":5}}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}',
    '',
  ].join('\n');

  const originalFetch = global.fetch;
  global.fetch = (async () =>
    new Response(upstreamSse, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as any;

  const app = await buildApp();
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      payload: { model: 'claude-opus-4-7', stream: true, messages: [{ role: 'user', content: 'demo' }] },
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /"type":"content_block_stop","index":0/);
    assert.match(res.body, /"stop_reason":"interrupted"/);
    assert.match(res.body, /event: message_stop/);

    const log = getDb().prepare('SELECT request_json FROM request_logs').get() as any;
    assert.equal(JSON.parse(log.request_json).forcedLogReason, 'anthropic_stream_interrupted');
  } finally {
    await app.close();
    global.fetch = originalFetch;
  }
});

test('stream pause_turn: injects continuation hint without force-log and preserves stop_reason', async () => {
  resetTables();
  const { raw } = seedUserAndToken();
  seedAnthropic('pause-turn');

  const upstreamSse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"model":"claude-opus-4-7","id":"msg_pause","type":"message","role":"assistant","content":[],"usage":{"input_tokens":1,"output_tokens":7}}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"pause_turn"},"usage":{"input_tokens":1,"output_tokens":7}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n');

  const originalFetch = global.fetch;
  global.fetch = (async () =>
    new Response(upstreamSse, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as any;

  const app = await buildApp();
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      payload: { model: 'claude-opus-4-7', stream: true, messages: [{ role: 'user', content: 'demo' }] },
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /Claude paused this turn \(pause_turn\)/);
    assert.match(res.body, /"stop_reason":"pause_turn"/);
    const logs = getDb().prepare('SELECT request_json FROM request_logs').all() as any[];
    assert.equal(logs.length, 0);
  } finally {
    await app.close();
    global.fetch = originalFetch;
  }
});

test('stream max_tokens: appends truncation marker without force-log and preserves stop_reason', async () => {
  resetTables();
  const { raw } = seedUserAndToken();
  seedAnthropic('max-tokens');

  const upstreamSse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"model":"claude-opus-4-7","id":"msg_max","type":"message","role":"assistant","content":[],"usage":{"input_tokens":1,"output_tokens":12}}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"input_tokens":1,"output_tokens":12}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n');

  const originalFetch = global.fetch;
  global.fetch = (async () =>
    new Response(upstreamSse, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as any;

  const app = await buildApp();
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      payload: { model: 'claude-opus-4-7', stream: true, messages: [{ role: 'user', content: 'demo' }] },
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /\[truncated: max_tokens reached at 12 output tokens\]/);
    assert.match(res.body, /"stop_reason":"max_tokens"/);
    const logs = getDb().prepare('SELECT request_json FROM request_logs').all() as any[];
    assert.equal(logs.length, 0);
  } finally {
    await app.close();
    global.fetch = originalFetch;
  }
});

test('non-stream pause_turn and max_tokens: appends visible markers and preserves stop_reason', async () => {
  resetTables();
  const { raw } = seedUserAndToken();
  seedAnthropic('non-stream-stops');
  const originalFetch = global.fetch;
  const upstreamBodies = [
    {
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-7',
      content: [],
      stop_reason: 'pause_turn',
      usage: { input_tokens: 1, output_tokens: 3 },
    },
    {
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-7',
      content: [{ type: 'text', text: 'hello' }],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 1, output_tokens: 44 },
    },
  ];
  let calls = 0;
  global.fetch = (async () =>
    new Response(JSON.stringify(upstreamBodies[calls++]), { status: 200, headers: { 'content-type': 'application/json' } })) as any;

  const app = await buildApp();
  try {
    const pauseRes = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      payload: { model: 'claude-opus-4-7', stream: false, messages: [{ role: 'user', content: 'demo' }] },
    });
    assert.equal(pauseRes.statusCode, 200);
    const pause = JSON.parse(pauseRes.body);
    assert.equal(pause.stop_reason, 'pause_turn');
    assert.match(pause.content.at(-1).text, /Claude paused this turn/);

    const maxRes = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      payload: { model: 'claude-opus-4-7', stream: false, messages: [{ role: 'user', content: 'demo' }] },
    });
    assert.equal(maxRes.statusCode, 200);
    const max = JSON.parse(maxRes.body);
    assert.equal(max.stop_reason, 'max_tokens');
    assert.match(max.content.at(-1).text, /max_tokens reached at 44 output tokens/);
  } finally {
    await app.close();
    global.fetch = originalFetch;
  }
});

test('HTTP 403 suspended Claude Code subscription marks account dead as oauth_suspended', async () => {
  resetTables();
  const { raw } = seedUserAndToken();
  const accountId = seedAnthropic('suspended', 'sk-ant-oat-suspended');

  const originalFetch = global.fetch;
  global.fetch = (async () =>
    new Response('{"type":"error","error":{"message":"Claude Code subscription disabled"}}', { status: 403, headers: { 'content-type': 'application/json' } })) as any;

  const app = await buildApp();
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      payload: { model: 'claude-opus-4-7', stream: false, messages: [{ role: 'user', content: 'demo' }] },
    });
    assert.equal(res.statusCode, 503);
    const acct = getDb().prepare('SELECT status,enabled FROM provider_accounts WHERE id=?').get(accountId) as any;
    assert.equal(acct.status, 'dead');
    assert.equal(acct.enabled, 0);
    const event = getDb().prepare('SELECT status,reason FROM provider_health_events WHERE provider_account_id=?').get(accountId) as any;
    assert.equal(event.status, 'dead');
    assert.equal(event.reason, 'oauth_suspended');
  } finally {
    await app.close();
    global.fetch = originalFetch;
  }
});

test('HTTP 400 prompt too long returns clear deterministic error without retrying', async () => {
  resetTables();
  const { raw } = seedUserAndToken();
  seedAnthropic('too-long-1');
  seedAnthropic('too-long-2');
  let calls = 0;

  const originalFetch = global.fetch;
  global.fetch = (async () => {
    calls += 1;
    return new Response('{"type":"error","error":{"message":"prompt is too long"}}', { status: 400, headers: { 'content-type': 'application/json' } });
  }) as any;

  const app = await buildApp();
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      payload: { model: 'claude-opus-4-7', stream: false, messages: [{ role: 'user', content: 'demo' }] },
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /Prompt too long for Anthropic context window/);
    assert.match(res.body, /cache_control/);
    assert.equal(calls, 1);
  } finally {
    await app.close();
    global.fetch = originalFetch;
  }
});

test('HTTP 400 thinking.type.disabled unsupported is fatal and does not cooldown Anthropic accounts', async () => {
  resetTables();
  const { raw } = seedUserAndToken();
  const accountId = seedAnthropic('fable-thinking-disabled-1');
  seedAnthropic('fable-thinking-disabled-2');
  let calls = 0;

  const errorBody = '{"type":"error","error":{"type":"invalid_request_error","message":"\\"thinking.type.disabled\\" is not supported for this model. Thinking defaults to adaptive mode when not specified; use \\"thinking.type.enabled\\" with budget_tokens instead."}}';
  const originalFetch = global.fetch;
  global.fetch = (async () => {
    calls += 1;
    return new Response(errorBody, { status: 400, headers: { 'content-type': 'application/json' } });
  }) as any;

  const app = await buildApp();
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      payload: { model: 'claude-fable-5', stream: false, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: 'demo' }] },
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /thinking\.type\.disabled/);
    assert.equal(calls, 1);
    const acct = getDb().prepare('SELECT status,cooldown_until FROM provider_accounts WHERE id=?').get(accountId) as any;
    assert.equal(acct.status, 'active');
    assert.equal(acct.cooldown_until, 0);
    const events = getDb().prepare('SELECT COUNT(*) AS c FROM provider_health_events WHERE provider_account_id=? AND status=?').get(accountId, 'cooldown') as any;
    assert.equal(events.c, 0);
  } finally {
    await app.close();
    global.fetch = originalFetch;
  }
});

test('Anthropic upstream HTTP 400 is body-logged when full body logging is enabled', async () => {
  resetTables();
  const { raw, userId } = seedUserAndToken();
  getDb().prepare('UPDATE users SET full_body_logging=1 WHERE id=?').run(userId);
  seedAnthropic('body-log-400');

  const errorBody = '{"type":"error","error":{"type":"invalid_request_error","message":"bad request example"}}';
  const originalFetch = global.fetch;
  global.fetch = (async () =>
    new Response(errorBody, { status: 400, headers: { 'content-type': 'application/json' } })) as any;

  const app = await buildApp();
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      payload: { model: 'claude-opus-4-8', stream: false, messages: [{ role: 'user', content: 'please fail' }] },
    });
    assert.equal(res.statusCode, 400);
    const row = getDb().prepare('SELECT request_json,response_text FROM request_logs ORDER BY id DESC LIMIT 1').get() as any;
    assert.ok(row, 'request log row should exist');
    assert.match(row.response_text, /bad request example/);
    const reqJson = JSON.parse(row.request_json);
    assert.equal(reqJson.model, 'claude-opus-4-8');
    assert.equal(reqJson.messages[0].content, 'please fail');
  } finally {
    await app.close();
    global.fetch = originalFetch;
  }
});

test('HTTP 529 overloaded is treated as rate_limit cooldown and surfaces pool overload after retry exhaustion', async () => {
  resetTables();
  const { raw } = seedUserAndToken();
  const accountId = seedAnthropic('overloaded');

  const originalFetch = global.fetch;
  global.fetch = (async () =>
    new Response('{"type":"error","error":{"type":"overloaded_error","message":"overloaded"}}', { status: 529, headers: { 'content-type': 'application/json' } })) as any;

  const app = await buildApp();
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      payload: { model: 'claude-opus-4-7', stream: false, messages: [{ role: 'user', content: 'demo' }] },
    });
    assert.equal(res.statusCode, 503);
    assert.match(res.body, /Anthropic overloaded across pool; retrying/);
    const event = getDb().prepare('SELECT status,reason FROM provider_health_events WHERE provider_account_id=?').get(accountId) as any;
    assert.equal(event.status, 'cooldown');
    assert.equal(event.reason, 'rate_limit');
  } finally {
    await app.close();
    global.fetch = originalFetch;
  }
});

test('cross-provider fallback is default-off and unmapped capacity failures preserve Anthropic response', async () => {
  resetTables();
  const { raw } = seedUserAndToken();
  seedAnthropic('fallback-disabled');
  seedGlm();
  const originalFetch = global.fetch;
  const originalEnabled = config.crossProviderFallbackEnabled;
  const originalModel = config.crossProviderFallbackAnthropicToGlmModel;
  let glmCalls = 0;
  config.crossProviderFallbackEnabled = false;
  config.crossProviderFallbackAnthropicToGlmModel = '';
  global.fetch = (async (url: string) => {
    if (url.includes('glm.test')) { glmCalls++; return new Response('{}', { status: 200 }); }
    return new Response('{"error":"overloaded"}', { status: 529 });
  }) as any;
  const app = await buildApp();
  try {
    const res = await app.inject({ method: 'POST', url: '/v1/messages', headers: { authorization: `Bearer ${raw}` }, payload: { model: 'claude-opus-4-7', messages: [] } });
    assert.equal(res.statusCode, 503);
    assert.equal(glmCalls, 0);
  } finally {
    config.crossProviderFallbackEnabled = originalEnabled;
    config.crossProviderFallbackAnthropicToGlmModel = originalModel;
    global.fetch = originalFetch;
    await app.close();
  }
});

test('cross-provider fallback relays an eligible non-streaming Anthropic capacity failure through GLM policy', async () => {
  resetTables();
  const { raw } = seedUserAndToken();
  seedAnthropic('fallback-source');
  seedGlm('fallback-target');
  const originalFetch = global.fetch;
  const originalEnabled = config.crossProviderFallbackEnabled;
  const originalModel = config.crossProviderFallbackAnthropicToGlmModel;
  const originalGlmUpstreamUrl = config.glmUpstreamUrl;
  const calls: string[] = [];
  const glmUpstreamHeaders: Headers[] = [];
  const injectedGlmHeaders: Record<string, any>[] = [];
  config.crossProviderFallbackEnabled = true;
  config.crossProviderFallbackAnthropicToGlmModel = 'glm-5.2';
  config.glmUpstreamUrl = 'https://glm.test/api/anthropic';
  global.fetch = (async (url: string, init?: RequestInit) => {
    calls.push(url);
    if (url.includes('glm.test')) {
      glmUpstreamHeaders.push(new Headers(init?.headers));
      return new Response('{"type":"message","model":"glm-5.2","content":[{"type":"text","text":"fallback ok"}],"usage":{"input_tokens":1,"output_tokens":1}}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{"error":"overloaded"}', { status: 529 });
  }) as any;
  const app = await buildApp((req) => {
    if (req.url === '/v1/glm/v1/messages') injectedGlmHeaders.push(req.headers);
  });
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: {
        authorization: 'Basic Zm9vOmJhcg==',
        'x-api-key': raw,
        'api-key': 'client-api-key',
        apikey: 'client-apikey',
        connection: 'x-leaked-hop-header',
        'x-leaked-hop-header': 'should-not-forward',
        'anthropic-beta': 'prompt-caching-2024-07-31',
        'x-stainless-lang': 'typescript',
      },
      payload: { model: 'claude-opus-4-7', messages: [] },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.match(res.body, /fallback ok/);
    assert.equal(res.headers['x-gateway-provider'], 'glm');
    assert.equal(res.headers['x-gateway-account'], 'fallback-target');
    assert.equal(res.headers['x-gateway-attempt'], '1');
    assert.equal(res.headers['x-gateway-fallback-from'], 'anthropic');
    assert.equal(calls.filter((url) => url.includes('glm.test')).length, 1);
    assert.equal(injectedGlmHeaders.length, 1);
    assert.equal(injectedGlmHeaders[0].authorization, `Bearer ${raw}`);
    assert.equal(injectedGlmHeaders[0]['x-api-key'], undefined);
    assert.equal(injectedGlmHeaders[0]['api-key'], undefined);
    assert.equal(injectedGlmHeaders[0].apikey, undefined);
    assert.equal(glmUpstreamHeaders[0].get('anthropic-beta'), 'prompt-caching-2024-07-31');
    assert.equal(glmUpstreamHeaders[0].get('x-stainless-lang'), 'typescript');
    assert.equal(glmUpstreamHeaders[0].get('connection'), null);
    assert.equal(glmUpstreamHeaders[0].get('x-leaked-hop-header'), null);
    assert.equal(glmUpstreamHeaders[0].get('authorization'), null);
    assert.equal(glmUpstreamHeaders[0].get('x-api-key'), 'sk-glm-test');
  } finally {
    config.crossProviderFallbackEnabled = originalEnabled;
    config.crossProviderFallbackAnthropicToGlmModel = originalModel;
    config.glmUpstreamUrl = originalGlmUpstreamUrl;
    global.fetch = originalFetch;
    await app.close();
  }
});

test('cross-provider fallback replaces stale Anthropic attribution when GLM policy rejects the request', async () => {
  resetTables();
  const { raw, userId } = seedUserAndToken('fallback-glm-policy-denied');
  seedAnthropic('fallback-policy-source');
  seedGlm('fallback-policy-target');
  getDb().prepare("UPDATE user_provider_access_modes SET mode='deny_all' WHERE user_id=? AND provider='glm'").run(userId);
  const originalFetch = global.fetch;
  const originalEnabled = config.crossProviderFallbackEnabled;
  const originalModel = config.crossProviderFallbackAnthropicToGlmModel;
  config.crossProviderFallbackEnabled = true;
  config.crossProviderFallbackAnthropicToGlmModel = 'glm-5.2';
  global.fetch = (async () => new Response('{"error":"overloaded"}', { status: 529 })) as any;
  const app = await buildApp();
  try {
    const res = await app.inject({ method: 'POST', url: '/v1/messages', headers: { authorization: `Bearer ${raw}` }, payload: { model: 'claude-opus-4-7', messages: [] } });
    assert.equal(res.statusCode, 400, res.body);
    assert.match(res.body, /model_not_allowed_for_user/);
    assert.equal(res.headers['x-gateway-provider'], 'glm');
    assert.equal(res.headers['x-gateway-account'], undefined);
    assert.equal(res.headers['x-gateway-attempt'], undefined);
    assert.equal(res.headers['x-gateway-fallback-from'], 'anthropic');
  } finally {
    config.crossProviderFallbackEnabled = originalEnabled;
    config.crossProviderFallbackAnthropicToGlmModel = originalModel;
    global.fetch = originalFetch;
    await app.close();
  }
});

test('cross-provider fallback never runs for client/auth/policy errors or truthy stream requests', async () => {
  for (const [status, stream] of [[400, false], [401, false], [403, false], [529, true], [529, 'false']] as const) {
    resetTables();
    const { raw } = seedUserAndToken(`fallback-no-${status}-${stream}`);
    seedAnthropic(`fallback-no-${status}-${stream}`);
    seedGlm(`fallback-glm-${status}-${stream}`);
    const originalFetch = global.fetch;
    const originalEnabled = config.crossProviderFallbackEnabled;
    const originalModel = config.crossProviderFallbackAnthropicToGlmModel;
    const originalGlmUpstreamUrl = config.glmUpstreamUrl;
    let glmCalls = 0;
    config.crossProviderFallbackEnabled = true;
    config.crossProviderFallbackAnthropicToGlmModel = 'glm-5.2';
    config.glmUpstreamUrl = 'https://glm.test/api/anthropic';
    global.fetch = (async (url: string) => {
      if (url.includes('glm.test')) glmCalls++;
      return new Response('{"error":"upstream"}', { status });
    }) as any;
    const app = await buildApp();
    try {
      await app.inject({ method: 'POST', url: '/v1/messages', headers: { authorization: `Bearer ${raw}` }, payload: { model: 'claude-opus-4-7', stream, messages: [] } });
      assert.equal(glmCalls, 0, `GLM must not be called for ${status} stream=${stream}`);
    } finally {
      config.crossProviderFallbackEnabled = originalEnabled;
      config.crossProviderFallbackAnthropicToGlmModel = originalModel;
      config.glmUpstreamUrl = originalGlmUpstreamUrl;
      global.fetch = originalFetch;
      await app.close();
    }
  }
});

test('cross-provider fallback uses x-api-key when Authorization is Basic', async () => {
  resetTables();
  const { raw } = seedUserAndToken('fallback-basic-x-api-key');
  seedAnthropic('fallback-basic-source');
  seedGlm('fallback-basic-target');
  const originalFetch = global.fetch;
  const originalEnabled = config.crossProviderFallbackEnabled;
  const originalModel = config.crossProviderFallbackAnthropicToGlmModel;
  const originalGlmUpstreamUrl = config.glmUpstreamUrl;
  let glmCalls = 0;
  config.crossProviderFallbackEnabled = true;
  config.crossProviderFallbackAnthropicToGlmModel = 'glm-5.2';
  config.glmUpstreamUrl = 'https://glm.test/api/anthropic';
  global.fetch = (async (url: string) => {
    if (url.includes('glm.test')) {
      glmCalls++;
      return new Response('{"type":"message","model":"glm-5.2","content":[{"type":"text","text":"fallback via x-api-key"}],"usage":{"input_tokens":1,"output_tokens":1}}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{"error":"overloaded"}', { status: 529 });
  }) as any;
  const app = await buildApp();
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: 'Basic Zm9vOmJhcg==', 'x-api-key': raw },
      payload: { model: 'claude-opus-4-7', messages: [] },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.match(res.body, /fallback via x-api-key/);
    assert.equal(glmCalls, 1);
  } finally {
    config.crossProviderFallbackEnabled = originalEnabled;
    config.crossProviderFallbackAnthropicToGlmModel = originalModel;
    config.glmUpstreamUrl = originalGlmUpstreamUrl;
    global.fetch = originalFetch;
    await app.close();
  }
});

test('cross-provider fallback rejects unknown or whitespace GLM targets without invoking GLM', async () => {
  for (const target of [' unknown-glm ', '   ']) {
    resetTables();
    const label = target.trim() || 'blank';
    const { raw } = seedUserAndToken(`fallback-invalid-target-${label}`);
    seedAnthropic(`fallback-invalid-target-${label}`);
    seedGlm(`fallback-invalid-target-glm-${label}`);
    const originalFetch = global.fetch;
    const originalEnabled = config.crossProviderFallbackEnabled;
    const originalModel = config.crossProviderFallbackAnthropicToGlmModel;
    const originalGlmUpstreamUrl = config.glmUpstreamUrl;
    let glmCalls = 0;
    config.crossProviderFallbackEnabled = true;
    config.crossProviderFallbackAnthropicToGlmModel = target;
    config.glmUpstreamUrl = 'https://glm.test/api/anthropic';
    global.fetch = (async (url: string) => {
      if (url.includes('glm.test')) glmCalls++;
      return new Response('{"error":"overloaded"}', { status: 529 });
    }) as any;
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'POST', url: '/v1/messages', headers: { authorization: `Bearer ${raw}` }, payload: { model: 'claude-opus-4-7', messages: [] } });
      assert.equal(res.statusCode, 503);
      assert.match(res.body, /Anthropic capacity unavailable/);
      assert.equal(glmCalls, 0, `GLM must not be called for target ${JSON.stringify(target)}`);
    } finally {
      config.crossProviderFallbackEnabled = originalEnabled;
      config.crossProviderFallbackAnthropicToGlmModel = originalModel;
      config.glmUpstreamUrl = originalGlmUpstreamUrl;
      global.fetch = originalFetch;
      await app.close();
    }
  }
});

test('cross-provider fallback hop marker prevents relay loops', async () => {
  resetTables();
  const { raw } = seedUserAndToken('fallback-loop');
  seedAnthropic('fallback-loop');
  seedGlm('fallback-loop-glm');
  const originalFetch = global.fetch;
  const originalEnabled = config.crossProviderFallbackEnabled;
  const originalModel = config.crossProviderFallbackAnthropicToGlmModel;
  let glmCalls = 0;
  config.crossProviderFallbackEnabled = true;
  config.crossProviderFallbackAnthropicToGlmModel = 'glm-5.2';
  global.fetch = (async (url: string) => {
    if (url.includes('glm.test')) glmCalls++;
    return new Response('{"error":"overloaded"}', { status: 529 });
  }) as any;
  const app = await buildApp();
  try {
    const res = await app.inject({ method: 'POST', url: '/v1/messages', headers: { authorization: `Bearer ${raw}`, 'x-cross-provider-fallback-hop': 'already-relayed' }, payload: { model: 'claude-opus-4-7', messages: [] } });
    assert.equal(res.statusCode, 503);
    assert.equal(glmCalls, 0);
  } finally {
    config.crossProviderFallbackEnabled = originalEnabled;
    config.crossProviderFallbackAnthropicToGlmModel = originalModel;
    global.fetch = originalFetch;
    await app.close();
  }
});
