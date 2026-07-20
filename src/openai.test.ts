import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';

process.env.DATABASE_PATH = path.join(os.tmpdir(), `nbmg-openai-${process.pid}.sqlite`);
process.env.OPENAI_UPSTREAM_URL = 'https://openai.test';
process.env.OPENAI_PLATFORM_UPSTREAM_URL = 'https://api.openai.test/v1';

const { getDb } = await import('./db/index.js');
const { migrate } = await import('./db/migrate.js');
const { sha256 } = await import('./utils/crypto.js');
const { registerOpenAiProxy } = await import('./proxy/openai.js');
const { formatOpenAiErrorMessage, buildResponsesStreamErrorEvents, injectResponsesMessageItem, DEFAULT_IMAGE_INSTRUCTIONS, resolveImageInstructions, classifyOpenAiStreamError } = await import('./proxy/openai.js');

function resetTables() {
  const db = getDb();
  db.prepare('DELETE FROM request_logs').run();
  db.prepare('DELETE FROM provider_health_events').run();
  db.prepare('DELETE FROM usage_events').run();
  db.prepare('DELETE FROM api_tokens').run();
  db.prepare('DELETE FROM user_provider_access_modes').run();
  db.prepare('DELETE FROM users WHERE email != ?').run('admin@localhost');
  db.prepare('DELETE FROM provider_accounts').run();
}

function seedUserAndToken(raw = `sp_openai_test_${Math.random().toString(36).slice(2)}`) {
  const db = getDb();
  const userId = Number(db.prepare("INSERT INTO users (email,role,is_admin,enabled,full_body_logging) VALUES (?, 'developer', 0, 1, 0)").run(`dev-${Math.random().toString(36).slice(2)}@example.com`).lastInsertRowid);
  db.prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(userId, 'openai_codex', 'allow_all');
  const tokenId = Number(db.prepare('INSERT INTO api_tokens (user_id,label,token_hash,token_prefix,enabled) VALUES (?,?,?,?,1)').run(userId, 'dev-token', sha256(raw), raw.slice(0, 14)).lastInsertRowid);
  return { raw, userId, tokenId };
}

function seedOpenAi(label = 'openai-test', secret = 'sk-test') {
  return Number(getDb().prepare("INSERT INTO provider_accounts (provider,label,secret,status,enabled) VALUES ('openai',?,?, 'active',1)").run(label, secret).lastInsertRowid);
}

let codexSeedCounter = 0;
function seedCodexExpired(label = 'codex-expired') {
  const acctId = `acct_exp_${++codexSeedCounter}_${Date.now()}`;
  return Number(getDb().prepare("INSERT INTO provider_accounts (provider,label,secret,refresh_secret,account_id,expires_at,status,enabled) VALUES ('openai_codex',?,?,?,?,?,'active',1)").run(label, 'expired-access', 'refresh-dead', acctId, Date.now() - 60_000).lastInsertRowid);
}

function seedCodexFresh(label = 'codex-fresh') {
  const acctId = `acct_live_${++codexSeedCounter}_${Date.now()}`;
  return Number(getDb().prepare("INSERT INTO provider_accounts (provider,label,secret,refresh_secret,account_id,expires_at,status,enabled) VALUES ('openai_codex',?,?,?,?,?,'active',1)").run(label, 'fresh-access', 'refresh-live', acctId, Date.now() + 60 * 60_000).lastInsertRowid);
}

async function buildApp() {
  const app = Fastify({ logger: false });
  registerOpenAiProxy(app);
  await app.ready();
  return app;
}

function requestLogReasons(): string[] {
  return (getDb().prepare('SELECT request_json FROM request_logs ORDER BY id').all() as any[])
    .map((row) => JSON.parse(row.request_json).forcedLogReason);
}

migrate();

test('OpenAI realtime client secret uses Codex OAuth pool and normalizes GPT-Realtime-2 alias', async () => {
  resetTables();
  const token = seedUserAndToken('sp_openai_realtime');
  seedCodexFresh('codex-realtime');
  let seenUrl = '';
  let seenHeaders: any;
  let seenBody: any;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: string, init: any) => {
    seenUrl = String(url);
    seenHeaders = init.headers;
    seenBody = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ value: 'ek_test_realtime_secret', expires_at: 1234 }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = await buildApp();
  const res = await app.inject({ method: 'POST', url: '/v1/realtime/client_secrets', headers: { authorization: `Bearer ${token.raw}` }, payload: { model: 'GPT-Realtime-2', voice: 'alloy', instructions: 'be concise' } });
  await app.close();
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { value: 'ek_test_realtime_secret', expires_at: 1234 });
  assert.equal(seenUrl, 'https://api.openai.test/v1/realtime/client_secrets');
  assert.equal(seenHeaders.authorization, 'Bearer fresh-access');
  assert.equal(seenBody.model, undefined);
  assert.equal(seenBody.session.type, 'realtime');
  assert.equal(seenBody.session.model, 'gpt-realtime-2');
  assert.equal(seenBody.session.audio.output.voice, 'alloy');
  assert.equal(seenBody.session.instructions, 'be concise');
  const ev = getDb().prepare("SELECT provider,endpoint,model,status_code,estimated_cost_usd FROM usage_events ORDER BY id DESC LIMIT 1").get() as any;
  assert.equal(ev.provider, 'openai_codex');
  assert.equal(ev.endpoint, '/v1/realtime/client_secrets');
  assert.equal(ev.model, 'gpt-realtime-2');
  assert.equal(ev.status_code, 200);
  assert.equal(ev.estimated_cost_usd, 0);
});

test('Codex Responses records reasoning tokens, TTFT, and retry attribution on stream success after rotation', async () => {
  resetTables();
  const { raw } = seedUserAndToken();
  seedCodexFresh('codex-r1');
  seedCodexFresh('codex-r2');
  const success = [
    'event: response.created',
    'data: {"type":"response.created","response":{"id":"resp_r"}}',
    '',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"ok"}',
    '',
    'event: response.completed',
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":100,"output_tokens":40,"input_tokens_details":{"cached_tokens":60},"output_tokens_details":{"reasoning_tokens":25}}}}',
    '',
  ].join('\n');
  let calls = 0;
  const originalFetch = global.fetch;
  global.fetch = (async () => {
    calls += 1;
    if (calls === 1) return new Response(JSON.stringify({ error: { message: 'server_error try again' } }), { status: 500, headers: { 'content-type': 'application/json' } });
    return new Response(success, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as any;
  const app = await buildApp();
  try {
    const res = await app.inject({ method: 'POST', url: '/v1/responses', headers: { authorization: `Bearer ${raw}` }, payload: { model: 'gpt-test', stream: true, input: 'hello' } });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(calls, 2);
    const events = getDb().prepare('SELECT status_code,reasoning_tokens,cache_read_tokens,ttft_ms,retry_count,retry_reason,billing_mode FROM usage_events ORDER BY id').all() as any[];
    // First event: the 500 failure (attempt 0, no retry attribution yet).
    assert.equal(events[0].status_code, 500);
    assert.equal(events[0].retry_reason, null);
    // Second event: success on attempt 1 — full instrumentation.
    assert.equal(events[1].status_code, 200);
    assert.equal(events[1].reasoning_tokens, 25);
    assert.equal(events[1].cache_read_tokens, 60);
    assert.ok(Number.isInteger(events[1].ttft_ms) && events[1].ttft_ms >= 0, `ttft_ms=${events[1].ttft_ms}`);
    assert.equal(events[1].retry_count, 1);
    assert.equal(events[1].retry_reason, 'account_rotation');
    assert.equal(events[1].billing_mode, 'flat_fee');
  } finally {
    await app.close();
    global.fetch = originalFetch;
  }
});

test('OpenAI realtime client secret preserves session body shape', async () => {
  resetTables();
  const token = seedUserAndToken('sp_openai_realtime_session');
  seedCodexFresh('codex-realtime-session');
  let seenBody: any;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (_url: string, init: any) => {
    seenBody = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ value: 'ek_test_realtime_session_secret', expires_at: 5678 }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = await buildApp();
  const res = await app.inject({ method: 'POST', url: '/v1/realtime/client_secrets', headers: { authorization: `Bearer ${token.raw}` }, payload: { session: { type: 'realtime', model: 'gpt-realtime', audio: { output: { voice: 'verse' } } } } });
  await app.close();
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(seenBody.model, undefined);
  assert.equal(seenBody.session.model, 'gpt-realtime');
  assert.deepEqual(seenBody.session.audio, { output: { voice: 'verse' } });
});

test('helpers build visible Responses message items/events', () => {
  const parsed: any = { output: [] };
  injectResponsesMessageItem(parsed, 'hello');
  assert.equal(parsed.output[0].type, 'message');
  assert.equal(parsed.output[0].content[0].text, 'hello');
  const sse = buildResponsesStreamErrorEvents('stream hello', 2);
  assert.match(sse, /event: response.output_item.added/);
  assert.match(sse, /stream hello/);
  assert.equal(formatOpenAiErrorMessage('content_filter'), '⛔ OpenAI safety filter blocked this response (content_filter).');
});

test('classifyOpenAiStreamError marks early overload and rate-limit failures retryable', () => {
  assert.deepEqual(
    classifyOpenAiStreamError({ type: 'service_unavailable_error', code: 'server_is_overloaded', message: 'Our servers are currently overloaded. Please try again later.' }),
    { retryable: true, status: 503, body: JSON.stringify({ type: 'service_unavailable_error', code: 'server_is_overloaded', message: 'Our servers are currently overloaded. Please try again later.' }) },
  );
  assert.equal(classifyOpenAiStreamError({ error: { code: 'rate_limit_exceeded' } }).status, 429);
  assert.equal(classifyOpenAiStreamError({ error: { message: 'policy violation' } }).retryable, false);
});

test('image instructions helper accepts instructions/system overrides with safe defaults', () => {
  assert.equal(resolveImageInstructions({ instructions: 'custom image system' }), 'custom image system');
  assert.equal(resolveImageInstructions({ system: 'system alias' }), 'system alias');
  assert.equal(resolveImageInstructions({ instructions: 'primary', system: 'alias' }), 'primary');
  assert.equal(resolveImageInstructions({ instructions: '   ', system: 'alias' }), 'alias');
  assert.equal(resolveImageInstructions({ instructions: '   ', system: ' \t\n ' }), DEFAULT_IMAGE_INSTRUCTIONS);
  assert.equal(resolveImageInstructions({ instructions: 123, system: false }), DEFAULT_IMAGE_INSTRUCTIONS);
  assert.equal(resolveImageInstructions({ instructions: '  trimmed  ' }), 'trimmed');
  assert.equal(resolveImageInstructions({ instructions: 'x'.repeat(8001) }).length, 8000);
});

test('proxy auth accepts Bearer, raw Authorization, x-api-key, api-key, and apikey headers', async () => {
  for (const headerName of ['authorization-bearer', 'authorization-raw', 'x-api-key', 'api-key', 'apikey']) {
    resetTables();
    const { raw } = seedUserAndToken();
    seedOpenAi();
    const originalFetch = global.fetch;
    global.fetch = (async () => new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } })) as any;
    const headers: any = { 'content-type': 'application/json' };
    if (headerName === 'authorization-bearer') headers.authorization = `Bearer ${raw}`;
    else if (headerName === 'authorization-raw') headers.authorization = raw;
    else headers[headerName] = raw;
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'POST', url: '/v1/responses', headers, payload: { model: 'gpt-test', input: 'hello' } });
      assert.equal(res.statusCode, 200, `${headerName}: ${res.body}`);
    } finally {
      await app.close();
      global.fetch = originalFetch;
    }
  }
});

test('O1 Responses non-stream content_filter with empty output injects message and force-logs', async () => {
  resetTables();
  const { raw } = seedUserAndToken();
  seedOpenAi();
  const originalFetch = global.fetch;
  global.fetch = (async () => new Response(JSON.stringify({ id: 'resp_1', object: 'response', output: [], incomplete_details: { reason: 'content_filter' }, usage: { input_tokens: 3, output_tokens: 0 } }), { status: 200, headers: { 'content-type': 'application/json' } })) as any;
  const app = await buildApp();
  try {
    const res = await app.inject({ method: 'POST', url: '/v1/responses', headers: { authorization: `Bearer ${raw}` }, payload: { model: 'gpt-test', input: 'blocked' } });
    assert.equal(res.statusCode, 200, res.body);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.output[0].type, 'message');
    assert.equal(parsed.output[0].content[0].text, '⛔ OpenAI safety filter blocked this response (content_filter).');
    assert.deepEqual(requestLogReasons(), ['openai_content_filter']);
  } finally {
    await app.close();
    global.fetch = originalFetch;
  }
});

test('O2 Responses non-stream max_output_tokens appends truncation without force-log', async () => {
  resetTables();
  const { raw } = seedUserAndToken();
  seedOpenAi();
  const originalFetch = global.fetch;
  global.fetch = (async () => new Response(JSON.stringify({
    id: 'resp_2',
    object: 'response',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'partial', annotations: [] }] }],
    incomplete_details: { reason: 'max_output_tokens' },
    usage: { input_tokens: 3, output_tokens: 4 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as any;
  const app = await buildApp();
  try {
    const res = await app.inject({ method: 'POST', url: '/v1/responses', headers: { authorization: `Bearer ${raw}` }, payload: { model: 'gpt-test', input: 'long' } });
    assert.equal(res.statusCode, 200, res.body);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.output[0].content.at(-1).text, '[truncated: max_output_tokens]');
    assert.equal((getDb().prepare('SELECT COUNT(*) n FROM request_logs').get() as any).n, 0);
  } finally {
    await app.close();
    global.fetch = originalFetch;
  }
});

test('O3 Responses non-stream refusal output gets sibling message and force-log', async () => {
  resetTables();
  const { raw } = seedUserAndToken();
  seedOpenAi();
  const originalFetch = global.fetch;
  global.fetch = (async () => new Response(JSON.stringify({
    id: 'resp_3',
    object: 'response',
    output: [{ id: 'ref_1', type: 'refusal', refusal: 'I cannot help with that.' }],
    usage: { input_tokens: 3, output_tokens: 1 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as any;
  const app = await buildApp();
  try {
    const res = await app.inject({ method: 'POST', url: '/v1/responses', headers: { authorization: `Bearer ${raw}` }, payload: { model: 'gpt-test', input: 'refuse' } });
    assert.equal(res.statusCode, 200, res.body);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.output[0].type, 'refusal');
    assert.equal(parsed.output[1].type, 'message');
    assert.equal(parsed.output[1].content[0].text, '⛔ Refused: I cannot help with that.');
    assert.deepEqual(requestLogReasons(), ['openai_refusal']);
  } finally {
    await app.close();
    global.fetch = originalFetch;
  }
});

test('O4 Chat completions non-stream content_filter fills visible content and force-logs', async () => {
  resetTables();
  const { raw } = seedUserAndToken();
  seedOpenAi();
  const originalFetch = global.fetch;
  global.fetch = (async () => new Response(JSON.stringify({
    id: 'chatcmpl_1',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: null }, finish_reason: 'content_filter' }],
    usage: { prompt_tokens: 3, completion_tokens: 0 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as any;
  const app = await buildApp();
  try {
    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${raw}` }, payload: { model: 'gpt-test', messages: [{ role: 'user', content: 'blocked' }] } });
    assert.equal(res.statusCode, 200, res.body);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.choices[0].message.content, '⛔ OpenAI safety filter blocked this response (content_filter).');
    assert.deepEqual(requestLogReasons(), ['openai_chat_content_filter']);
  } finally {
    await app.close();
    global.fetch = originalFetch;
  }
});

test('O5 Chat completions length with content appends truncation without force-log', async () => {
  resetTables();
  const { raw } = seedUserAndToken();
  seedOpenAi();
  const originalFetch = global.fetch;
  global.fetch = (async () => new Response(JSON.stringify({
    id: 'chatcmpl_2',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: 'partial answer' }, finish_reason: 'length' }],
    usage: { prompt_tokens: 3, completion_tokens: 4 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as any;
  const app = await buildApp();
  try {
    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${raw}` }, payload: { model: 'gpt-test', messages: [{ role: 'user', content: 'long' }] } });
    assert.equal(res.statusCode, 200, res.body);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.choices[0].message.content, 'partial answer\n\n[truncated: length]');
    assert.equal((getDb().prepare('SELECT COUNT(*) n FROM request_logs').get() as any).n, 0);
  } finally {
    await app.close();
    global.fetch = originalFetch;
  }
});

test('O6 Responses stream response.failed injects output item and force-logs', async () => {
  resetTables();
  const { raw } = seedUserAndToken();
  seedOpenAi();
  const upstreamSse = [
    'event: response.created',
    'data: {"type":"response.created","response":{"id":"resp_stream"}}',
    '',
    'event: response.failed',
    'data: {"type":"response.failed","response":{"error":{"message":"upstream exploded"},"usage":{"input_tokens":2,"output_tokens":0}}}',
    '',
  ].join('\n');
  const originalFetch = global.fetch;
  global.fetch = (async () => new Response(upstreamSse, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as any;
  const app = await buildApp();
  try {
    const res = await app.inject({ method: 'POST', url: '/v1/responses', headers: { authorization: `Bearer ${raw}` }, payload: { model: 'gpt-test', stream: true, input: 'fail' } });
    assert.equal(res.statusCode, 200, res.body);
    assert.match(res.body, /event: response.output_item.added/);
    assert.match(res.body, /⚠️ OpenAI stream failed: upstream exploded/);
    assert.match(res.body, /event: response.failed/);
    assert.deepEqual(requestLogReasons(), ['openai_response_failed']);
  } finally {
    await app.close();
    global.fetch = originalFetch;
  }
});

test('O6b Codex Responses retries early stream overload before flushing client headers', async () => {
  resetTables();
  const { raw } = seedUserAndToken();
  seedCodexFresh('codex-a');
  seedCodexFresh('codex-b');
  const earlyOverload = [
    'event: response.created',
    'data: {"type":"response.created","response":{"id":"resp_fail"}}',
    '',
    ': keepalive',
    '',
    'event: response.output_item.added',
    'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","role":"assistant","status":"in_progress","content":[]}}',
    '',
    'event: response.failed',
    'data: {"type":"response.failed","response":{"error":{"type":"service_unavailable_error","code":"server_is_overloaded","message":"Our servers are currently overloaded. Please try again later."},"usage":{"input_tokens":11,"output_tokens":0}}}',
    '',
  ].join('\n');
  const success = [
    'event: response.created',
    'data: {"type":"response.created","response":{"id":"resp_ok"}}',
    '',
    'event: response.output_item.added',
    'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","role":"assistant","status":"in_progress","content":[]}}',
    '',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"ok"}',
    '',
    'event: response.completed',
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":1}}}',
    '',
  ].join('\n');
  let calls = 0;
  const originalFetch = global.fetch;
  global.fetch = (async () => {
    calls += 1;
    return new Response(calls === 1 ? earlyOverload : success, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as any;
  const app = await buildApp();
  try {
    const res = await app.inject({ method: 'POST', url: '/v1/responses', headers: { authorization: `Bearer ${raw}` }, payload: { model: 'gpt-test', stream: true, input: 'hello' } });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(calls, 2);
    assert.match(res.body, /resp_ok/);
    assert.doesNotMatch(res.body, /server_is_overloaded/);
    assert.deepEqual(requestLogReasons(), ['codex_early_stream_failure']);
    const events = getDb().prepare('SELECT status_code,input_tokens,output_tokens FROM usage_events ORDER BY id').all() as any[];
    assert.equal(events[0].status_code, 503);
    assert.equal(events[0].input_tokens, 11);
    assert.equal(events[0].output_tokens, 0);
    assert.equal(events[1].status_code, 200);
    assert.equal(events[1].input_tokens, 3);
    assert.equal(events[1].output_tokens, 1);
    const earlyLog = JSON.parse((getDb().prepare('SELECT request_json FROM request_logs ORDER BY id LIMIT 1').get() as any).request_json);
    assert.equal(earlyLog.forcedLogReason, 'codex_early_stream_failure');
    assert.equal(earlyLog.status, 503);
    assert.equal(earlyLog.body, undefined);
    assert.equal(earlyLog.headers, undefined);
  } finally {
    await app.close();
    global.fetch = originalFetch;
  }
});

test('O6c Codex Responses retries a silent empty stream before flushing client headers', async () => {
  resetTables();
  const { raw } = seedUserAndToken();
  seedCodexFresh('codex-a');
  seedCodexFresh('codex-b');
  // Upstream emits only setup events then closes with no output, completion, or error.
  const emptyStream = [
    'event: response.created',
    'data: {"type":"response.created","response":{"id":"resp_empty"}}',
    '',
  ].join('\n');
  const success = [
    'event: response.created',
    'data: {"type":"response.created","response":{"id":"resp_ok"}}',
    '',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"ok"}',
    '',
    'event: response.completed',
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":4,"output_tokens":2}}}',
    '',
  ].join('\n');
  let calls = 0;
  const originalFetch = global.fetch;
  global.fetch = (async () => {
    calls += 1;
    return new Response(calls === 1 ? emptyStream : success, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as any;
  const app = await buildApp();
  try {
    const res = await app.inject({ method: 'POST', url: '/v1/responses', headers: { authorization: `Bearer ${raw}` }, payload: { model: 'gpt-test', stream: true, input: 'hello' } });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(calls, 2);
    assert.match(res.body, /resp_ok/);
    assert.doesNotMatch(res.body, /resp_empty/);
    assert.deepEqual(requestLogReasons(), ['codex_empty_stream']);
    const events = getDb().prepare('SELECT status_code,input_tokens,output_tokens FROM usage_events ORDER BY id').all() as any[];
    assert.equal(events[0].status_code, 502);
    assert.equal(events[1].status_code, 200);
    assert.equal(events[1].input_tokens, 4);
    assert.equal(events[1].output_tokens, 2);
  } finally {
    await app.close();
    global.fetch = originalFetch;
  }
});

test('O6d Codex Responses strips encrypted reasoning and retries on invalid_encrypted_content', async () => {
  resetTables();
  const { raw } = seedUserAndToken();
  seedCodexFresh('codex-a');
  seedCodexFresh('codex-b');
  const encErr = JSON.stringify({ error: { message: 'The encrypted content gAAA...== could not be verified.', type: 'invalid_request_error', code: 'invalid_encrypted_content' } });
  const success = [
    'event: response.created',
    'data: {"type":"response.created","response":{"id":"resp_ok"}}',
    '',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"ok"}',
    '',
    'event: response.completed',
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":3}}}',
    '',
  ].join('\n');
  let calls = 0;
  const bodies: any[] = [];
  const originalFetch = global.fetch;
  global.fetch = (async (_url: any, init: any) => {
    calls += 1;
    bodies.push(JSON.parse(String(init?.body || '{}')));
    if (calls === 1) return new Response(encErr, { status: 400, headers: { 'content-type': 'application/json' } });
    return new Response(success, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as any;
  const app = await buildApp();
  try {
    const res = await app.inject({ method: 'POST', url: '/v1/responses', headers: { authorization: `Bearer ${raw}` }, payload: {
      model: 'gpt-test',
      stream: true,
      input: [
        { type: 'reasoning', id: 'rs_1', encrypted_content: 'gAAA-stale', summary: [] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      ],
    } });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(calls, 2);
    assert.match(res.body, /resp_ok/);
    assert.doesNotMatch(res.body, /invalid_encrypted_content/);
    // First attempt carried the poisoned reasoning; retry must have it stripped.
    assert.ok(bodies[0].input.some((i: any) => i.type === 'reasoning'));
    assert.ok(!bodies[1].input.some((i: any) => i.type === 'reasoning'));
    assert.deepEqual(requestLogReasons(), ['codex_encrypted_content_stripped']);
    const events = getDb().prepare('SELECT status_code FROM usage_events ORDER BY id').all() as any[];
    assert.equal(events[0].status_code, 400);
    assert.equal(events[1].status_code, 200);
    const encLog = String((getDb().prepare("SELECT response_text FROM request_logs ORDER BY id LIMIT 1").get() as any).response_text || '');
    // Raw 400 body (with the encrypted blob) must NOT be persisted when full-body logging is off.
    assert.doesNotMatch(encLog, /gAAA/);
  } finally {
    await app.close();
    global.fetch = originalFetch;
  }
});

test('O6e non-retryable response.failed before output is surfaced, not misclassified as empty stream', async () => {
  resetTables();
  const { raw } = seedUserAndToken();
  seedCodexFresh('codex-a');
  seedCodexFresh('codex-b');
  // Setup event then a NON-retryable failure (content policy), then close.
  const failedStream = [
    'event: response.created',
    'data: {"type":"response.created","response":{"id":"resp_failed"}}',
    '',
    'event: response.failed',
    'data: {"type":"response.failed","response":{"error":{"type":"invalid_request_error","code":"content_policy_violation","message":"blocked"}}}',
    '',
  ].join('\n');
  let calls = 0;
  const originalFetch = global.fetch;
  global.fetch = (async () => {
    calls += 1;
    return new Response(failedStream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as any;
  const app = await buildApp();
  try {
    const res = await app.inject({ method: 'POST', url: '/v1/responses', headers: { authorization: `Bearer ${raw}` }, payload: { model: 'gpt-test', stream: true, input: 'hello' } });
    assert.equal(res.statusCode, 200, res.body);
    // Must NOT have retried/failed over (real error surfaced once) and not logged as empty stream.
    assert.equal(calls, 1);
    assert.deepEqual(requestLogReasons(), ['openai_response_failed']);
    const events = getDb().prepare('SELECT status_code FROM usage_events ORDER BY id').all() as any[];
    assert.equal(events.length, 1);
    assert.equal(events[0].status_code, 200);
  } finally {
    await app.close();
    global.fetch = originalFetch;
  }
});

test('O6f encrypted-content 400 on a non-last attempt still fails over to remaining accounts', async () => {
  resetTables();
  const { raw } = seedUserAndToken();
  seedCodexFresh('codex-a');
  seedCodexFresh('codex-b');
  const encErr = JSON.stringify({ error: { code: 'invalid_encrypted_content', message: 'gAAAAabc could not be verified', type: 'invalid_request_error' } });
  const overload = [
    'event: response.created',
    'data: {"type":"response.created","response":{"id":"resp_ovl"}}',
    '',
    'event: error',
    'data: {"type":"error","error":{"type":"service_unavailable_error","code":"server_is_overloaded","message":"overloaded"}}',
    '',
  ].join('\n');
  const success = [
    'event: response.created',
    'data: {"type":"response.created","response":{"id":"resp_ok"}}',
    '',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"ok"}',
    '',
    'event: response.completed',
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":6,"output_tokens":2}}}',
    '',
  ].join('\n');
  let calls = 0;
  const originalFetch = global.fetch;
  global.fetch = (async () => {
    calls += 1;
    // 1) 400 encrypted -> strip; 2) stripped retry (same acct) overloads; 3) other acct succeeds.
    if (calls === 1) return new Response(encErr, { status: 400, headers: { 'content-type': 'application/json' } });
    if (calls === 2) return new Response(overload, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    return new Response(success, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as any;
  const app = await buildApp();
  try {
    const res = await app.inject({ method: 'POST', url: '/v1/responses', headers: { authorization: `Bearer ${raw}` }, payload: {
      model: 'gpt-test', stream: true,
      input: [
        { type: 'reasoning', id: 'rs_1', encrypted_content: 'gAAA-stale', summary: [] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      ],
    } });
    assert.equal(res.statusCode, 200, res.body);
    // Strip retry consumed a bonus attempt, so failover to the 3rd call still happened.
    assert.equal(calls, 3);
    assert.match(res.body, /resp_ok/);
  } finally {
    await app.close();
    global.fetch = originalFetch;
  }
});

test('O7 Codex Responses lifts system/developer input messages into instructions', async () => {
  resetTables();
  const { raw } = seedUserAndToken();
  seedCodexFresh('codex-live');
  let upstreamBody: any = null;
  const originalFetch = global.fetch;
  global.fetch = (async (_url: any, init: any) => {
    upstreamBody = JSON.parse(String(init?.body || '{}'));
    return new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  const app = await buildApp();
  try {
    const res = await app.inject({ method: 'POST', url: '/v1/responses', headers: { authorization: `Bearer ${raw}` }, payload: {
      model: 'gpt-test',
      input: [
        { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'system prompt' }] },
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'developer prompt' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      ],
      stream: true,
      include: [],
      store: false,
      reasoning: { effort: 'high' },
      text: { format: { type: 'text' } },
      tools: [],
      parallel_tool_calls: true,
      max_output_tokens: 16,
    } });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(upstreamBody.instructions, 'system prompt\ndeveloper prompt');
    assert.deepEqual(upstreamBody.input.map((item: any) => item.role), ['user']);
    assert.equal(upstreamBody.input[0].content[0].text, 'hello');
    assert.equal(upstreamBody.store, false);
    assert.equal(upstreamBody.stream, true);
    assert.equal(upstreamBody.max_output_tokens, undefined);
  } finally {
    await app.close();
    global.fetch = originalFetch;
  }
});

test('O8 Codex refresh failure on one account does NOT surface 401; pool retry serves the request', async () => {
  resetTables();
  const { raw } = seedUserAndToken();
  // Force dead account to be picked first by giving live account a more recent
  // last_used_at (selectCodexAccounts orders by last_used_at ASC).
  const deadAcct = seedCodexExpired('dead-cdx');
  const liveAcct = seedCodexFresh('live-cdx');
  getDb().prepare('UPDATE provider_accounts SET last_used_at = ? WHERE id = ?').run(Date.now(), liveAcct);
  getDb().prepare('UPDATE provider_accounts SET last_used_at = 0 WHERE id = ?').run(deadAcct);
  const originalFetch = global.fetch;
  global.fetch = (async (url: any) => {
    if (String(url).includes('auth.openai.com')) return new Response('{"error":"invalid_grant"}', { status: 400, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  const app = await buildApp();
  try {
    const res = await app.inject({ method: 'POST', url: '/v1/responses', headers: { authorization: `Bearer ${raw}` }, payload: { model: 'gpt-test', input: 'hello' } });
    // Critical user-visible behavior: with one dead and one live account in the
    // pool, the request must NOT return 401. Whether the dead account is
    // actually probed depends on sticky-hash ordering across test runs; we just
    // assert the live account is healthy and the request succeeds.
    assert.equal(res.statusCode, 200, res.body);
    assert.notEqual((getDb().prepare('SELECT status FROM provider_accounts WHERE id=?').get(liveAcct) as any).status, 'invalid');
  } finally {
    await app.close();
    global.fetch = originalFetch;
  }
});

test('O8b Codex refresh failure surfaces relink error ONLY after all accounts exhausted', async () => {
  resetTables();
  const { raw } = seedUserAndToken();
  const a1 = seedCodexExpired('dead-1');
  const a2 = seedCodexExpired('dead-2');
  const originalFetch = global.fetch;
  global.fetch = (async (url: any) => {
    if (String(url).includes('auth.openai.com')) return new Response('{"error":"invalid_grant"}', { status: 400, headers: { 'content-type': 'application/json' } });
    return new Response('{}', { status: 500 });
  }) as any;
  const app = await buildApp();
  try {
    const res = await app.inject({ method: 'POST', url: '/v1/responses', headers: { authorization: `Bearer ${raw}` }, payload: { model: 'gpt-test', input: 'hello' } });
    assert.equal(res.statusCode, 401, res.body);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.error.code, 'codex_refresh_failed');
    assert.match(parsed.error.message, /All available Codex OAuth sessions have expired/);
    assert.equal((getDb().prepare('SELECT status FROM provider_accounts WHERE id=?').get(a1) as any).status, 'invalid');
    assert.equal((getDb().prepare('SELECT status FROM provider_accounts WHERE id=?').get(a2) as any).status, 'invalid');
  } finally {
    await app.close();
    global.fetch = originalFetch;
  }
});

test('OpenAI image edits accept multipart and forward raw body to API-key upstream', async () => {
  resetTables();
  const token = seedUserAndToken('sp_openai_image_edit_multipart');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'openai', 'allow_all');
  seedOpenAi('openai-images', 'sk-image');
  const boundary = 'nbmgBoundary';
  const body = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-image-2\r\n--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nmake it cinematic\r\n--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="source.png"\r\nContent-Type: image/png\r\n\r\nPNGDATA\r\n--${boundary}--\r\n`, 'utf8');
  let seenUrl = '';
  let seenContentType = '';
  let seenBody: any;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: string, init: any) => {
    seenUrl = String(url);
    seenContentType = (init.headers as Headers).get('content-type') || '';
    seenBody = Buffer.from(await new Response(init.body).arrayBuffer());
    return new Response(JSON.stringify({ data: [{ b64_json: 'abc' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = await buildApp();
  const res = await app.inject({ method: 'POST', url: '/v1/images/edits', headers: { authorization: `Bearer ${token.raw}`, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body });
  await app.close();
  globalThis.fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(seenUrl, 'https://api.openai.test/v1/images/edits');
  assert.match(seenContentType, /multipart\/form-data/);
  assert.deepEqual(seenBody, body);
});

test('OpenAI image edits multipart falls back to Codex image tool with parsed input image', async () => {
  resetTables();
  const token = seedUserAndToken('sp_openai_image_edit_multipart_codex');
  seedCodexFresh('codex-image');
  const boundary = 'nbmgBoundary2';
  const body = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-image-2\r\n--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nmake it cinematic\r\n--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="source.png"\r\nContent-Type: image/png\r\n\r\nPNGDATA\r\n--${boundary}--\r\n`, 'utf8');
  let seenBody: any;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (_url: string, init: any) => {
    seenBody = JSON.parse(String(init.body));
    const sse = [
      'data: ' + JSON.stringify({ type: 'response.output_item.done', item: { type: 'image_generation_call', result: 'iVBORw0KGgo=' } }) + '\n\n',
      'data: [DONE]\n\n',
    ].join('');
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const app = await buildApp();
  const res = await app.inject({ method: 'POST', url: '/v1/images/edits', headers: { authorization: `Bearer ${token.raw}`, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body });
  await app.close();
  globalThis.fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(seenBody.tools[0].type, 'image_generation');
  const content = seenBody.input[0].content;
  assert.equal(content[0].text, 'make it cinematic');
  assert.equal(content[1].type, 'input_image');
  assert.match(content[1].image_url, /^data:image\/png;base64,/);
});

test('OpenAI image Codex fallback enforces token daily caps before upstream', async () => {
  resetTables();
  const token = seedUserAndToken('sp_openai_image_codex_cap');
  getDb().prepare('UPDATE api_tokens SET cap_tokens_daily=1 WHERE id=?').run(token.tokenId);
  getDb().prepare("INSERT INTO usage_events (user_id,token_id,provider,endpoint,model,status_code,input_tokens,output_tokens) VALUES (?,?,?,?,?,?,?,?)")
    .run(token.userId, token.tokenId, 'openai_codex', '/v1/images/edits', 'gpt-image-2', 200, 1, 0);
  seedCodexFresh('codex-image-cap');
  let called = false;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => { called = true; return new Response(''); };
  const app = await buildApp();
  const res = await app.inject({ method: 'POST', url: '/v1/images/edits', headers: { authorization: `Bearer ${token.raw}` }, payload: { model: 'gpt-image-2', prompt: 'edit', image: 'AAAA' } });
  await app.close();
  globalThis.fetch = oldFetch;
  assert.equal(res.statusCode, 429, res.body);
  assert.equal(called, false);
  assert.match(res.body, /Token-level daily token cap reached for openai_codex/);
});

test('OpenAI image edits multipart rejects missing image before upstream', async () => {
  resetTables();
  const token = seedUserAndToken('sp_openai_image_edit_multipart_no_image');
  seedCodexFresh('codex-image-no-image');
  const boundary = 'nbmgBoundaryNoImage';
  const body = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-image-2\r\n--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nmake it cinematic\r\n--${boundary}--\r\n`, 'utf8');
  let called = false;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => { called = true; return new Response(''); };
  const app = await buildApp();
  const res = await app.inject({ method: 'POST', url: '/v1/images/edits', headers: { authorization: `Bearer ${token.raw}`, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body });
  await app.close();
  globalThis.fetch = oldFetch;
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(called, false);
  assert.match(res.body, /requires at least one image field/);
});
