import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';

process.env.DATABASE_PATH = path.join(os.tmpdir(), `nbmg-xai-${process.pid}.sqlite`);
process.env.DEV_ADMIN_KEY = 'test-admin-key';
process.env.XAI_UPSTREAM_URL = 'https://api.x.ai/v1';

const { getDb } = await import('./db/index.js');
const { migrate } = await import('./db/migrate.js');
const { sha256 } = await import('./utils/crypto.js');
const { registerAdminApi } = await import('./admin/admin-api.js');
const { registerXaiProxy } = await import('./proxy/xai.js');

migrate();

function resetRuntimeTables() {
  const db = getDb();
  db.prepare('DELETE FROM request_logs').run();
  db.prepare('DELETE FROM provider_health_events').run();
  db.prepare('DELETE FROM usage_events').run();
  db.prepare('DELETE FROM xai_batch_jobs').run();
  db.prepare('DELETE FROM xai_video_jobs').run();
  db.prepare('DELETE FROM user_provider_access_modes').run();
  db.prepare('DELETE FROM user_model_denies').run();
  db.prepare('DELETE FROM user_grants').run();
  db.prepare('DELETE FROM api_tokens').run();
  db.prepare('DELETE FROM users WHERE email != ?').run('admin@localhost');
  db.prepare('DELETE FROM provider_accounts').run();
}

function seedUserAndToken(raw = 'nbmg_xai_token', email = 'dev-xai@example.com') {
  const db = getDb();
  const userId = Number(db.prepare("INSERT INTO users (email,role,is_admin,enabled) VALUES (?,'developer',0,1)").run(email).lastInsertRowid);
  const tokenId = Number(db.prepare('INSERT INTO api_tokens (user_id,label,token_hash,token_prefix,enabled) VALUES (?,?,?,?,1)').run(userId, 'dev-token', sha256(raw), raw.slice(0, 14)).lastInsertRowid);
  return { raw, userId, tokenId };
}

function seedXai(label = 'xai1', secret = 'xai-access') {
  return Number(getDb().prepare("INSERT INTO provider_accounts (provider,label,secret,status,enabled) VALUES ('xai',?,?, 'active',1)").run(label, secret).lastInsertRowid);
}

function seedXaiBatchJob(batchId: string, accountId: number, userId: number, tokenId: number) {
  getDb().prepare('INSERT INTO xai_batch_jobs (batch_id,provider_account_id,user_id,token_id,created_at) VALUES (?,?,?,?,?)')
    .run(batchId, accountId, userId, tokenId, Date.now());
}

test('migration allows provider=xai and admin can create account', async () => {
  resetRuntimeTables();
  assert.ok(getDb().prepare('SELECT version FROM schema_migrations WHERE version=?').get(2026052001));
  assert.ok(getDb().prepare('SELECT version FROM schema_migrations WHERE version=?').get(2026060301));
  assert.ok(getDb().prepare('SELECT version FROM schema_migrations WHERE version=?').get(2026060302));
  const xaiVideoJobColumns = new Set((getDb().prepare('PRAGMA table_info(xai_video_jobs)').all() as any[]).map((c) => c.name));
  assert.ok(xaiVideoJobColumns.has('submit_cost_usd'));
  assert.ok(xaiVideoJobColumns.has('trued_up'));
  const xaiBatchJobColumns = new Set((getDb().prepare('PRAGMA table_info(xai_batch_jobs)').all() as any[]).map((c) => c.name));
  assert.ok(xaiBatchJobColumns.has('batch_id'));
  assert.ok(xaiBatchJobColumns.has('provider_account_id'));
  assert.ok(xaiBatchJobColumns.has('user_id'));
  assert.ok(xaiBatchJobColumns.has('token_id'));
  assert.ok(xaiBatchJobColumns.has('created_at'));
  assert.doesNotThrow(() => seedXai('direct'));
  resetRuntimeTables();
  const app = Fastify();
  registerAdminApi(app);
  const res = await app.inject({ method: 'POST', url: '/admin/provider-accounts', headers: { 'x-admin-key': 'test-admin-key' }, payload: { provider: 'xai', label: 'xai-1', secret: 'xai-access' } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal((getDb().prepare("SELECT provider FROM provider_accounts WHERE label='xai-1'").get() as any).provider, 'xai');
});

test('xAI route is off by default for non-admin users', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_default_off');
  seedXai();
  let calls = 0;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => { calls += 1; return new Response('{}', { status: 200 }); };
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/xai/responses', headers: { authorization: `Bearer ${token.raw}` }, payload: { model: 'grok-4.3', input: 'hi' } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().error.code, 'model_not_allowed_for_user');
  assert.equal(calls, 0);
});

test('xAI route forwards grok-4.5 and records usage with published pricing', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_allowed');
  seedXai('allowed', 'xai-access');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  let seenUrl = '';
  let seenAuth = '';
  let seenBody: any;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: string, init: any) => {
    seenUrl = String(url);
    seenAuth = init.headers.authorization;
    seenBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ id: 'resp', output: [], usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/xai/responses', headers: { authorization: `Bearer ${token.raw}` }, payload: { model: 'grok-4.5', input: 'hi' } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(seenUrl, 'https://api.x.ai/v1/responses');
  assert.equal(seenAuth, 'Bearer xai-access');
  assert.equal(seenBody.model, 'grok-4.5');
  const ev = getDb().prepare("SELECT provider,endpoint,model,input_tokens,output_tokens,estimated_cost_usd FROM usage_events WHERE provider='xai' ORDER BY id DESC LIMIT 1").get() as any;
  assert.equal(ev.endpoint, '/v1/xai/responses');
  assert.equal(ev.model, 'grok-4.5');
  assert.equal(ev.input_tokens, 1_000_000);
  assert.equal(ev.output_tokens, 1_000_000);
  assert.equal(ev.estimated_cost_usd, 8);
});

test('xAI responses route rejects media models and auto-routes realtime voice models', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_media_on_text');
  seedXai('media-on-text', 'xai-media-on-text-token');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  let calls = 0;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => { calls += 1; return new Response(JSON.stringify({ value: 'xai-realtime-client-secret-routed', expires_at: 999 }), { status: 200, headers: { 'content-type': 'application/json' } }); };
  const app = Fastify();
  registerXaiProxy(app);
  const media = await app.inject({ method: 'POST', url: '/v1/xai/responses', headers: { authorization: `Bearer ${token.raw}` }, payload: { model: 'grok-imagine-video', input: 'make a video' } });
  const audio = await app.inject({ method: 'POST', url: '/v1/xai/responses', headers: { authorization: `Bearer ${token.raw}` }, payload: { model: 'grok-voice-tts', input: 'say this' } });
  const realtime = await app.inject({ method: 'POST', url: '/v1/xai/responses', headers: { authorization: `Bearer ${token.raw}` }, payload: { model: 'grok-realtime-voice', input: 'voice' } });
  const files = await app.inject({ method: 'POST', url: '/v1/xai/responses', headers: { authorization: `Bearer ${token.raw}` }, payload: { model: 'xai-files', input: 'file' } });
  const batch = await app.inject({ method: 'POST', url: '/v1/xai/responses', headers: { authorization: `Bearer ${token.raw}` }, payload: { model: 'xai-batch', input: 'batch' } });
  const text = await app.inject({ method: 'POST', url: '/v1/xai/responses', headers: { authorization: `Bearer ${token.raw}` }, payload: { model: 'grok-4.3', input: 'hi' } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(media.statusCode, 400, media.body);
  assert.equal(media.json().error.code, 'wrong_endpoint_for_model');
  assert.match(media.json().error.message, /\/v1\/xai\/videos\/generations/);
  assert.equal(audio.statusCode, 400, audio.body);
  assert.equal(audio.json().error.code, 'wrong_endpoint_for_model');
  assert.match(audio.json().error.message, /\/v1\/xai\/tts/);
  assert.equal(realtime.statusCode, 200, realtime.body);
  assert.equal(realtime.json().value, 'xai-realtime-client-secret-routed');
  assert.equal(files.statusCode, 400, files.body);
  assert.equal(files.json().error.code, 'wrong_endpoint_for_model');
  assert.match(files.json().error.message, /\/v1\/xai\/files/);
  assert.equal(batch.statusCode, 400, batch.body);
  assert.equal(batch.json().error.code, 'wrong_endpoint_for_model');
  assert.match(batch.json().error.message, /\/v1\/xai\/batches/);
  assert.equal(text.statusCode, 200, text.body);
  assert.equal(calls, 2);
  const rows = getDb().prepare("SELECT endpoint,model,estimated_cost_usd FROM usage_events WHERE provider='xai' ORDER BY id").all() as any[];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].endpoint, '/v1/xai/realtime/client_secrets');
  assert.equal(rows[0].model, 'grok-realtime-voice');
  assert.equal(rows[1].model, 'grok-4.3');
});

test('xAI TTS forwards JSON, returns binary audio, and records character cost', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_tts');
  seedXai('tts', 'xai-tts-access');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  let seenUrl = '';
  let seenBody: any;
  let seenHeaders: any;
  const audio = Buffer.from('fake-audio');
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: string, init: any) => {
    seenUrl = String(url);
    seenHeaders = init.headers;
    seenBody = JSON.parse(String(init.body));
    return new Response(audio, { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  };
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/xai/tts', headers: { authorization: `Bearer ${token.raw}` }, payload: { text: 'Hello world', voice_id: 'eve', language: 'en' } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(seenUrl, 'https://api.x.ai/v1/tts');
  assert.equal(seenHeaders.authorization, 'Bearer xai-tts-access');
  assert.equal(seenBody.text, 'Hello world');
  assert.equal(seenBody.voice_id, 'eve');
  assert.match(res.headers['content-type'] as string, /^audio\/mpeg/);
  assert.deepEqual((res as any).rawPayload || Buffer.from(res.body), audio);
  const ev = getDb().prepare("SELECT endpoint,model,estimated_cost_usd FROM usage_events WHERE provider='xai' ORDER BY id DESC LIMIT 1").get() as any;
  assert.equal(ev.endpoint, '/v1/xai/tts');
  assert.equal(ev.model, 'grok-voice-tts');
  assert.ok(Math.abs(ev.estimated_cost_usd - 0.000165) < 1e-9);
});

test('xAI TTS rejects invalid voice_id', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_tts_bad_voice');
  seedXai('tts-bad-voice');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  let calls = 0;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => { calls += 1; return new Response('{}', { status: 200 }); };
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/xai/tts', headers: { authorization: `Bearer ${token.raw}` }, payload: { text: 'Hello', voice_id: 'not-a-voice', language: 'en' } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 400, res.body);
  assert.match(res.body, /invalid_voice|invalid voice_id/);
  assert.equal(calls, 0);
});

test('xAI TTS rejects text over 15000 characters', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_tts_too_long');
  seedXai('tts-too-long');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  let calls = 0;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => { calls += 1; return new Response('{}', { status: 200 }); };
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/xai/tts', headers: { authorization: `Bearer ${token.raw}` }, payload: { text: 'x'.repeat(15001), voice_id: 'eve', language: 'en' } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 400, res.body);
  assert.match(res.body, /text exceeds 15000 character limit/);
  assert.equal(calls, 0);
});

test('xAI TTS defaults omitted voice_id to eve', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_tts_default_voice');
  seedXai('tts-default-voice');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  let seenBody: any;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (_url: string, init: any) => {
    seenBody = JSON.parse(String(init.body));
    return new Response(Buffer.from('ok'), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  };
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/xai/tts', headers: { authorization: `Bearer ${token.raw}` }, payload: { text: 'Default voice', language: 'en' } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(seenBody.voice_id, 'eve');
});

test('xAI STT forwards multipart body and records duration cost', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_stt');
  seedXai('stt', 'xai-stt-access');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  let seenUrl = '';
  let seenBody: any;
  let seenHeaders: any;
  const multipart = Buffer.from('--abc\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\nfake\r\n--abc--\r\n');
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: string, init: any) => {
    seenUrl = String(url);
    seenHeaders = init.headers;
    seenBody = init.body;
    return new Response(JSON.stringify({ text: 'hi', duration: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/xai/stt', headers: { authorization: `Bearer ${token.raw}`, 'content-type': 'multipart/form-data; boundary=abc' }, payload: multipart });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { text: 'hi', duration: 3600 });
  assert.equal(seenUrl, 'https://api.x.ai/v1/stt');
  assert.equal(seenHeaders.authorization, 'Bearer xai-stt-access');
  assert.equal(seenHeaders['content-type'], 'multipart/form-data; boundary=abc');
  assert.deepEqual(seenBody, multipart);
  const ev = getDb().prepare("SELECT endpoint,model,estimated_cost_usd FROM usage_events WHERE provider='xai' ORDER BY id DESC LIMIT 1").get() as any;
  assert.equal(ev.endpoint, '/v1/xai/stt');
  assert.equal(ev.model, 'grok-stt');
  assert.ok(Math.abs(ev.estimated_cost_usd - 0.10) < 1e-9);
});

test('xAI STT missing duration records zero cost', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_stt_no_duration');
  seedXai('stt-no-duration');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => new Response(JSON.stringify({ text: 'hi' }), { status: 200, headers: { 'content-type': 'application/json' } });
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/xai/stt', headers: { authorization: `Bearer ${token.raw}` }, payload: { url: 'https://example.com/audio.wav' } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { text: 'hi' });
  const ev = getDb().prepare("SELECT endpoint,model,estimated_cost_usd FROM usage_events WHERE provider='xai' ORDER BY id DESC LIMIT 1").get() as any;
  assert.equal(ev.endpoint, '/v1/xai/stt');
  assert.equal(ev.model, 'grok-stt');
  assert.equal(ev.estimated_cost_usd, 0);
});

test('xAI realtime client secret mint forwards empty JSON, records zero cost, and logs metadata only', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_realtime_secret');
  seedXai('realtime', 'xai-realtime-access');
  getDb().prepare('UPDATE users SET full_body_logging=1 WHERE id=?').run(token.userId);
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  let seenUrl = '';
  let seenMethod = '';
  let seenBody = '';
  const upstreamSecret = 'xai-realtime-client-secret-abc';
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: string, init: any) => {
    seenUrl = String(url);
    seenMethod = init.method;
    seenBody = String(init.body);
    return new Response(JSON.stringify({ value: upstreamSecret, expires_at: 123 }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/xai/realtime/client_secrets', headers: { authorization: `Bearer ${token.raw}` }, payload: {} });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { value: upstreamSecret, expires_at: 123 });
  assert.equal(seenUrl, 'https://api.x.ai/v1/realtime/client_secrets');
  assert.equal(seenMethod, 'POST');
  assert.equal(JSON.parse(seenBody).model, 'grok-voice-latest');
  const ev = getDb().prepare("SELECT endpoint,model,estimated_cost_usd FROM usage_events WHERE provider='xai' ORDER BY id DESC LIMIT 1").get() as any;
  assert.equal(ev.endpoint, '/v1/xai/realtime/client_secrets');
  assert.equal(ev.model, 'grok-voice-latest');
  assert.equal(ev.estimated_cost_usd, 0);
  const log = getDb().prepare('SELECT request_json,response_text FROM request_logs ORDER BY id DESC LIMIT 1').get() as any;
  assert.ok(log);
  assert.doesNotMatch(log.request_json, new RegExp(upstreamSecret));
  assert.doesNotMatch(log.response_text, new RegExp(upstreamSecret));
  assert.equal(JSON.parse(log.response_text).expires_at, 123);
});

test('xAI responses route auto-routes grok voice think fast to realtime client secret', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_responses_think_fast_route');
  seedXai('responses-think-fast-route', 'xai-realtime-access');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  let seenUrl = '';
  let seenBody: any;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: string, init: any) => {
    seenUrl = String(url);
    seenBody = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ value: 'xai-realtime-client-secret-from-responses', expires_at: 654 }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/xai/responses', headers: { authorization: `Bearer ${token.raw}` }, payload: { model: 'grok-voice-think-fast-1.0', voice: 'eve', reasoning_effort: 'high' } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().value, 'xai-realtime-client-secret-from-responses');
  assert.equal(seenUrl, 'https://api.x.ai/v1/realtime/client_secrets');
  assert.equal(seenBody.model, 'grok-voice-think-fast-1.0');
  assert.equal(seenBody.voice, 'eve');
  const ev = getDb().prepare("SELECT endpoint,model,estimated_cost_usd FROM usage_events WHERE provider='xai' ORDER BY id DESC LIMIT 1").get() as any;
  assert.equal(ev.endpoint, '/v1/xai/realtime/client_secrets');
  assert.equal(ev.model, 'grok-voice-think-fast-1.0');
  assert.equal(ev.estimated_cost_usd, 0);
});

test('xAI realtime client secret supports grok voice think fast model', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_realtime_think_fast');
  seedXai('realtime-think-fast', 'xai-realtime-access');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  let seenBody: any;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (_url: string, init: any) => {
    seenBody = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ value: 'xai-realtime-client-secret-think-fast', expires_at: 789 }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/xai/realtime/client_secrets', headers: { authorization: `Bearer ${token.raw}` }, payload: { model: 'grok-voice-think-fast-1.0', voice: 'eve', reasoning_effort: 'high' } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(seenBody.model, 'grok-voice-think-fast-1.0');
  assert.equal(seenBody.voice, 'eve');
  assert.equal(seenBody.reasoning_effort, 'high');
  const ev = getDb().prepare("SELECT endpoint,model,estimated_cost_usd FROM usage_events WHERE provider='xai' ORDER BY id DESC LIMIT 1").get() as any;
  assert.equal(ev.endpoint, '/v1/xai/realtime/client_secrets');
  assert.equal(ev.model, 'grok-voice-think-fast-1.0');
  assert.equal(ev.estimated_cost_usd, 0);
});

test('xAI realtime client secret mint forwards model and voice params', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_realtime_params');
  seedXai('realtime-params', 'xai-realtime-access');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  let seenBody: any;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (_url: string, init: any) => {
    seenBody = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ value: 'xai-realtime-client-secret-def', expires_at: 456 }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = Fastify();
  registerXaiProxy(app);
  const payload = { model: 'grok-realtime', voice: 'eve', expires_after: { anchor: 'created_at', seconds: 600 } };
  const res = await app.inject({ method: 'POST', url: '/v1/xai/realtime/client_secrets', headers: { authorization: `Bearer ${token.raw}` }, payload });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(seenBody.model, 'grok-realtime');
  assert.equal(seenBody.voice, 'eve');
  assert.deepEqual(seenBody.expires_after, { anchor: 'created_at', seconds: 600 });
});

test('xAI files upload forwards multipart body and records zero cost', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_files_upload');
  seedXai('files', 'xai-files-access');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  let seenUrl = '';
  let seenMethod = '';
  let seenHeaders: any;
  let seenBody: any;
  const multipart = Buffer.from('--abc\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n--abc--\r\n');
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: string, init: any) => {
    seenUrl = String(url);
    seenMethod = init.method;
    seenHeaders = init.headers;
    seenBody = init.body;
    return new Response(JSON.stringify({ id: 'file_x', object: 'file', filename: 'a.txt', bytes: 5, purpose: '' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/xai/files', headers: { authorization: `Bearer ${token.raw}`, 'content-type': 'multipart/form-data; boundary=abc' }, payload: multipart });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { id: 'file_x', object: 'file', filename: 'a.txt', bytes: 5, purpose: '' });
  assert.equal(seenUrl, 'https://api.x.ai/v1/files');
  assert.equal(seenMethod, 'POST');
  assert.equal(seenHeaders.authorization, 'Bearer xai-files-access');
  assert.equal(seenHeaders['content-type'], 'multipart/form-data; boundary=abc');
  assert.deepEqual(seenBody, multipart);
  const ev = getDb().prepare("SELECT endpoint,model,estimated_cost_usd FROM usage_events WHERE provider='xai' ORDER BY id DESC LIMIT 1").get() as any;
  assert.equal(ev.endpoint, '/v1/xai/files');
  assert.equal(ev.model, 'xai-files');
  assert.equal(ev.estimated_cost_usd, 0);
});

test('xAI files list passes query through and records zero cost', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_files_list');
  seedXai('files-list', 'xai-files-access');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  let seenUrl = '';
  let seenMethod = '';
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: string, init: any) => {
    seenUrl = String(url);
    seenMethod = init.method;
    return new Response(JSON.stringify({ data: [], pagination_token: null }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'GET', url: '/v1/xai/files?limit=10&pagination_token=next', headers: { authorization: `Bearer ${token.raw}` } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { data: [], pagination_token: null });
  assert.equal(seenUrl, 'https://api.x.ai/v1/files?limit=10&pagination_token=next');
  assert.equal(seenMethod, 'GET');
  const ev = getDb().prepare("SELECT endpoint,model,estimated_cost_usd FROM usage_events WHERE provider='xai' ORDER BY id DESC LIMIT 1").get() as any;
  assert.equal(ev.endpoint, '/v1/xai/files');
  assert.equal(ev.model, 'xai-files');
  assert.equal(ev.estimated_cost_usd, 0);
});

test('xAI files retrieve and delete forward file id', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_files_delete');
  seedXai('files-delete', 'xai-files-access');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  const seen: Array<{ url: string; method: string }> = [];
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: string, init: any) => {
    seen.push({ url: String(url), method: init.method });
    if (init.method === 'GET') return new Response(JSON.stringify({ id: 'file_x', object: 'file' }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ id: 'file_x', deleted: true, object: 'file' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = Fastify();
  registerXaiProxy(app);
  const getRes = await app.inject({ method: 'GET', url: '/v1/xai/files/file_x', headers: { authorization: `Bearer ${token.raw}` } });
  const delRes = await app.inject({ method: 'DELETE', url: '/v1/xai/files/file_x', headers: { authorization: `Bearer ${token.raw}` } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(getRes.statusCode, 200, getRes.body);
  assert.deepEqual(getRes.json(), { id: 'file_x', object: 'file' });
  assert.equal(delRes.statusCode, 200, delRes.body);
  assert.deepEqual(delRes.json(), { id: 'file_x', deleted: true, object: 'file' });
  assert.deepEqual(seen, [
    { url: 'https://api.x.ai/v1/files/file_x', method: 'GET' },
    { url: 'https://api.x.ai/v1/files/file_x', method: 'DELETE' },
  ]);
  const rows = getDb().prepare("SELECT endpoint,model,estimated_cost_usd FROM usage_events WHERE provider='xai' ORDER BY id DESC LIMIT 2").all() as any[];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].endpoint, '/v1/xai/files/:id');
  assert.equal(rows[0].model, 'xai-files');
  assert.equal(rows[0].estimated_cost_usd, 0);
});

test('xAI batch create forwards JSON verbatim and records zero cost', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_batch_create');
  const accountId = seedXai('batch-create', 'xai-batch-access');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  let seenUrl = '';
  let seenMethod = '';
  let seenBody: any;
  const batch = { batch_id: 'batch_1', name: 'b', state: { num_requests: 0, num_pending: 0, num_success: 0, num_error: 0, num_cancelled: 0 } };
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: string, init: any) => {
    seenUrl = String(url);
    seenMethod = init.method;
    seenBody = JSON.parse(String(init.body));
    return new Response(JSON.stringify(batch), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/xai/batches', headers: { authorization: `Bearer ${token.raw}` }, payload: { name: 'b' } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), batch);
  assert.equal(seenUrl, 'https://api.x.ai/v1/batches');
  assert.equal(seenMethod, 'POST');
  assert.deepEqual(seenBody, { name: 'b' });
  const ev = getDb().prepare("SELECT endpoint,model,estimated_cost_usd FROM usage_events WHERE provider='xai' ORDER BY id DESC LIMIT 1").get() as any;
  assert.equal(ev.endpoint, '/v1/xai/batches');
  assert.equal(ev.model, 'xai-batch');
  assert.equal(ev.estimated_cost_usd, 0);
  const job = getDb().prepare("SELECT batch_id, provider_account_id, user_id, token_id FROM xai_batch_jobs WHERE batch_id='batch_1'").get() as any;
  assert.equal(job.batch_id, 'batch_1');
  assert.equal(job.provider_account_id, accountId);
  assert.equal(job.user_id, token.userId);
  assert.equal(job.token_id, token.tokenId);
});

test('xAI batch list passes query through and records zero cost', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_batch_list');
  seedXai('batch-list', 'xai-batch-access');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  let seenUrl = '';
  let seenMethod = '';
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: string, init: any) => {
    seenUrl = String(url);
    seenMethod = init.method;
    return new Response(JSON.stringify({ batches: [], pagination_token: null }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'GET', url: '/v1/xai/batches?limit=5', headers: { authorization: `Bearer ${token.raw}` } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { batches: [], pagination_token: null });
  assert.equal(seenUrl, 'https://api.x.ai/v1/batches?limit=5');
  assert.equal(seenMethod, 'GET');
  const ev = getDb().prepare("SELECT endpoint,model,estimated_cost_usd FROM usage_events WHERE provider='xai' ORDER BY id DESC LIMIT 1").get() as any;
  assert.equal(ev.endpoint, '/v1/xai/batches');
  assert.equal(ev.model, 'xai-batch');
  assert.equal(ev.estimated_cost_usd, 0);
});

test('xAI batch id operations reuse the creating account affinity', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_batch_affinity');
  const accountA = seedXai('batch-a', 'xai-batch-a-token');
  seedXai('batch-b', 'xai-batch-b-token');
  seedXaiBatchJob('batch_1', accountA, token.userId, token.tokenId);
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  let seenAuth = '';
  let seenAccount = '';
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (_url: string, init: any) => {
    seenAuth = init.headers.authorization;
    return new Response(JSON.stringify({ batch_id: 'batch_1', state: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/xai/batches/batch_1/requests', headers: { authorization: `Bearer ${token.raw}` }, payload: { batch_requests: [] } });
  seenAccount = String(res.headers['x-gateway-account']);
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(seenAuth, 'Bearer xai-batch-a-token');
  assert.equal(seenAccount, 'batch-a');
});

test('xAI batch id operations reject unknown batch ids before upstream', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_batch_unknown');
  seedXai('batch-unknown', 'xai-batch-access');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  let calls = 0;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => { calls += 1; return new Response('{}', { status: 200 }); };
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'GET', url: '/v1/xai/batches/unknownbatch', headers: { authorization: `Bearer ${token.raw}` } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 404, res.body);
  assert.equal(res.json().error.message, 'batch not found for this token');
  assert.equal(calls, 0);
});

test('xAI batch id operations do not fall back when mapped account is disabled', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_batch_disabled');
  const accountId = seedXai('batch-disabled', 'xai-batch-disabled-token');
  seedXai('batch-fallback', 'xai-batch-fallback-token');
  seedXaiBatchJob('batch_disabled', accountId, token.userId, token.tokenId);
  getDb().prepare('UPDATE provider_accounts SET enabled=0 WHERE id=?').run(accountId);
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  let calls = 0;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => { calls += 1; return new Response('{}', { status: 200 }); };
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'GET', url: '/v1/xai/batches/batch_disabled', headers: { authorization: `Bearer ${token.raw}` } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 503, res.body);
  assert.equal(calls, 0, 'disabled mapped account should not fall back to another xAI account');
});

test('xAI batch get forwards encoded batch id', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_batch_get');
  const accountId = seedXai('batch-get', 'xai-batch-access');
  seedXaiBatchJob('batch_1', accountId, token.userId, token.tokenId);
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  let seenUrl = '';
  let seenMethod = '';
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: string, init: any) => {
    seenUrl = String(url);
    seenMethod = init.method;
    return new Response(JSON.stringify({ batch_id: 'batch_1', state: { num_requests: 0, num_pending: 0, num_success: 0, num_error: 0, num_cancelled: 0 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'GET', url: '/v1/xai/batches/batch_1', headers: { authorization: `Bearer ${token.raw}` } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().batch_id, 'batch_1');
  assert.equal(seenUrl, 'https://api.x.ai/v1/batches/batch_1');
  assert.equal(seenMethod, 'GET');
  const ev = getDb().prepare("SELECT endpoint,model,estimated_cost_usd FROM usage_events WHERE provider='xai' ORDER BY id DESC LIMIT 1").get() as any;
  assert.equal(ev.endpoint, '/v1/xai/batches/:id');
  assert.equal(ev.model, 'xai-batch');
  assert.equal(ev.estimated_cost_usd, 0);
});

test('xAI batch add requests forwards tagged-union request body verbatim and tolerates empty upstream body', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_batch_requests');
  const accountId = seedXai('batch-requests', 'xai-batch-access');
  seedXaiBatchJob('batch_1', accountId, token.userId, token.tokenId);
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  let seenUrl = '';
  let seenMethod = '';
  let seenBody: any;
  const payload = { batch_requests: [{ custom_id: 'r1', batch_request: { responses: { model: 'grok-4.3', input: 'hi' } } }] };
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: string, init: any) => {
    seenUrl = String(url);
    seenMethod = init.method;
    seenBody = JSON.parse(String(init.body));
    return new Response(null, { status: 200 });
  };
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/xai/batches/batch_1/requests', headers: { authorization: `Bearer ${token.raw}` }, payload });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.body, '');
  assert.equal(seenUrl, 'https://api.x.ai/v1/batches/batch_1/requests');
  assert.equal(seenMethod, 'POST');
  assert.deepEqual(seenBody, payload);
  const ev = getDb().prepare("SELECT endpoint,model,estimated_cost_usd FROM usage_events WHERE provider='xai' ORDER BY id DESC LIMIT 1").get() as any;
  assert.equal(ev.endpoint, '/v1/xai/batches/:id/requests');
  assert.equal(ev.model, 'xai-batch');
  assert.equal(ev.estimated_cost_usd, 0);
});

test('xAI batch action passthrough forwards body without hardcoded cancel shape', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_batch_action');
  const accountId = seedXai('batch-action', 'xai-batch-access');
  seedXaiBatchJob('batch_1', accountId, token.userId, token.tokenId);
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  let seenUrl = '';
  let seenMethod = '';
  let seenBody: any;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: string, init: any) => {
    seenUrl = String(url);
    seenMethod = init.method;
    seenBody = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ batch_id: 'batch_1', state: { num_requests: 1, num_pending: 0, num_success: 0, num_error: 0, num_cancelled: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/xai/batches/batch_1', headers: { authorization: `Bearer ${token.raw}` }, payload: { some: 'action' } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(seenUrl, 'https://api.x.ai/v1/batches/batch_1');
  assert.equal(seenMethod, 'POST');
  assert.deepEqual(seenBody, { some: 'action' });
  const ev = getDb().prepare("SELECT endpoint,model,estimated_cost_usd FROM usage_events WHERE provider='xai' ORDER BY id DESC LIMIT 1").get() as any;
  assert.equal(ev.endpoint, '/v1/xai/batches/:id');
  assert.equal(ev.model, 'xai-batch');
  assert.equal(ev.estimated_cost_usd, 0);
});

test('xAI batch results forwards query and records zero cost', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_batch_results');
  const accountId = seedXai('batch-results', 'xai-batch-access');
  seedXaiBatchJob('batch_1', accountId, token.userId, token.tokenId);
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  let seenUrl = '';
  let seenMethod = '';
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: string, init: any) => {
    seenUrl = String(url);
    seenMethod = init.method;
    return new Response(JSON.stringify({ results: [], pagination_token: null }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'GET', url: '/v1/xai/batches/batch_1/results?limit=5', headers: { authorization: `Bearer ${token.raw}` } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { results: [], pagination_token: null });
  assert.equal(seenUrl, 'https://api.x.ai/v1/batches/batch_1/results?limit=5');
  assert.equal(seenMethod, 'GET');
  const ev = getDb().prepare("SELECT endpoint,model,estimated_cost_usd FROM usage_events WHERE provider='xai' ORDER BY id DESC LIMIT 1").get() as any;
  assert.equal(ev.endpoint, '/v1/xai/batches/:id/results');
  assert.equal(ev.model, 'xai-batch');
  assert.equal(ev.estimated_cost_usd, 0);
});

test('xAI batch route re-encodes weird batch ids before upstream fetch', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_batch_encode');
  const accountId = seedXai('batch-encode', 'xai-batch-access');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  let seenUrl = '';
  const weirdId = 'batch 1?#:%';
  seedXaiBatchJob(weirdId, accountId, token.userId, token.tokenId);
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: string) => {
    seenUrl = String(url);
    return new Response(JSON.stringify({ batch_id: weirdId, state: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'GET', url: `/v1/xai/batches/${encodeURIComponent(weirdId)}`, headers: { authorization: `Bearer ${token.raw}` } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(seenUrl, `https://api.x.ai/v1/batches/${encodeURIComponent(weirdId)}`);
});

test('xAI route refreshes stored OAuth credential before forwarding', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_refresh');
  const oldCredential = { type: 'oauth', provider: 'xai', access: 'old-access', refresh: 'refresh-token', expires: Date.now() - 1, tokenEndpoint: 'https://auth.x.ai/oauth/token' };
  const accountId = seedXai('oauth', JSON.stringify(oldCredential));
  getDb().prepare('UPDATE provider_accounts SET refresh_secret=?, expires_at=? WHERE id=?').run('refresh-token', Date.now() - 1, accountId);
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  const oldFetch = globalThis.fetch;
  const calls: string[] = [];
  (globalThis as any).fetch = async (url: string, init: any) => {
    calls.push(String(url));
    if (String(url).includes('/oauth/token')) {
      assert.equal(init.body, 'grant_type=refresh_token&client_id=b1a00492-073a-47ea-816f-4c329264a828&refresh_token=refresh-token');
      return new Response(JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    assert.equal(init.headers.authorization, 'Bearer new-access');
    return new Response(JSON.stringify({ id: 'resp', usage: { input_tokens: 1, output_tokens: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/xai/responses', headers: { authorization: `Bearer ${token.raw}` }, payload: { model: 'grok-4.3', input: 'hi' } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(calls, ['https://auth.x.ai/oauth/token', 'https://api.x.ai/v1/responses']);
  const row = getDb().prepare('SELECT secret, refresh_secret, status FROM provider_accounts WHERE id=?').get(accountId) as any;
  assert.equal(row.secret, 'new-access');
  assert.equal(row.refresh_secret, 'new-refresh');
  assert.equal(row.status, 'active');
});

test('xAI content_filter is surfaced and force-logged', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_filter');
  seedXai('filter');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => new Response(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'content_filter' }], usage: { input_tokens: 5, output_tokens: 0 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/xai/responses', headers: { authorization: `Bearer ${token.raw}` }, payload: { model: 'grok-4.3', input: 'blocked' } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().choices[0].message.content, '⛔ xai safety filter blocked this response (content_filter).');
  const log = getDb().prepare('SELECT request_json FROM request_logs ORDER BY id DESC LIMIT 1').get() as any;
  assert.equal(JSON.parse(log.request_json).forcedLogReason, 'xai_content_filter');
});

test('xAI length finish_reason appends truncation marker without force-log', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_length');
  seedXai('length');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => new Response(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'partial' }, finish_reason: 'length' }], usage: { input_tokens: 5, output_tokens: 3 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/xai/responses', headers: { authorization: `Bearer ${token.raw}` }, payload: { model: 'grok-4.3', input: 'long' } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().choices[0].message.content, 'partial\n\n[truncated: length]');
  assert.equal((getDb().prepare('SELECT COUNT(*) n FROM request_logs').get() as any).n, 0);
});

test('xAI interrupted stream emits visible tail and force-logs', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_interrupt');
  seedXai('interrupt');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  const sse = 'data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n';
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/xai/responses', headers: { authorization: `Bearer ${token.raw}` }, payload: { model: 'grok-4.3', stream: true, input: 'hi' } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.match(res.body, /Stream interrupted; partial response above/);
  assert.match(res.body, /data: \[DONE\]/);
  const log = getDb().prepare('SELECT request_json FROM request_logs ORDER BY id DESC LIMIT 1').get() as any;
  assert.equal(JSON.parse(log.request_json).forcedLogReason, 'xai_stream_interrupted');
});

test('xAI completed stream is recognized when SSE completion event is split across chunks', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_split_complete');
  seedXai('split-complete');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => new Response(new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(enc.encode('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n'));
      controller.enqueue(enc.encode('event: response.completed\ndata: {"type":"response.'));
      controller.enqueue(enc.encode('completed","usage":{"input_tokens":1,"output_tokens":1}}\n\n'));
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/xai/responses', headers: { authorization: `Bearer ${token.raw}` }, payload: { model: 'grok-4.3', stream: true, input: 'hi' } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.doesNotMatch(res.body, /Stream interrupted; partial response above/);
  assert.equal((getDb().prepare('SELECT COUNT(*) n FROM request_logs').get() as any).n, 0);
});

test('xAI completed stream is recognized when final SSE event has no trailing delimiter', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_undelimited_complete');
  seedXai('undelimited-complete');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => new Response('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\nevent: response.completed\ndata: {"type":"response.completed","usage":{"input_tokens":1,"output_tokens":1}}', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/xai/responses', headers: { authorization: `Bearer ${token.raw}` }, payload: { model: 'grok-4.3', stream: true, input: 'hi' } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.doesNotMatch(res.body, /Stream interrupted; partial response above/);
  assert.equal((getDb().prepare('SELECT COUNT(*) n FROM request_logs').get() as any).n, 0);
});

test('xAI 403 spending-limit cools the account down and retries on the next pool account', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_quota');
  const deadAcct = seedXai('xai-out-of-credits', 'xai-dead');
  const liveAcct = seedXai('xai-live', 'xai-live');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  const seenAccounts: string[] = [];
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (_url: any, init: any) => {
    const bearer = (init.headers as any).authorization || (init.headers?.get?.('authorization'));
    seenAccounts.push(String(bearer));
    if (bearer && /xai-dead/.test(String(bearer))) {
      return new Response(JSON.stringify({
        code: 'The caller does not have permission to execute the specified operation',
        error: 'You have run out of credits or need a Grok subscription. [WKE=personal-team-blocked:spending-limit]',
      }), { status: 403, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/xai/responses', headers: { authorization: `Bearer ${token.raw}` }, payload: { model: 'grok-4.3', input: 'hi' } });
  (globalThis as any).fetch = oldFetch;
  // Request must succeed via the live account.
  assert.equal(res.statusCode, 200, res.body);
  // Dead account should be in cooldown with reason out_of_quota.
  const deadRow = getDb().prepare('SELECT status, cooldown_until FROM provider_accounts WHERE id=?').get(deadAcct) as any;
  assert.equal(deadRow.status, 'cooldown');
  assert.ok(deadRow.cooldown_until > Date.now(), 'cooldown_until should be in the future');
  // Live account should still be active.
  const liveRow = getDb().prepare('SELECT status FROM provider_accounts WHERE id=?').get(liveAcct) as any;
  assert.notEqual(liveRow.status, 'cooldown');
  // Health event should record out_of_quota.
  const evt = getDb().prepare("SELECT reason FROM provider_health_events WHERE provider_account_id=? ORDER BY id DESC LIMIT 1").get(deadAcct) as any;
  assert.match(String(evt?.reason || ''), /out_of_quota/);
});

test('xAI 403 spending-limit surfaces error only after ALL pool accounts are exhausted', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_quota_all');
  seedXai('xai-dead-1', 'xai-dead-1');
  seedXai('xai-dead-2', 'xai-dead-2');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => new Response(JSON.stringify({
    code: 'The caller does not have permission to execute the specified operation',
    error: 'You have run out of credits or need a Grok subscription. [WKE=personal-team-blocked:spending-limit]',
  }), { status: 403, headers: { 'content-type': 'application/json' } });
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/xai/responses', headers: { authorization: `Bearer ${token.raw}` }, payload: { model: 'grok-4.3', input: 'hi' } });
  (globalThis as any).fetch = oldFetch;
  // Both accounts cooled down, no eligible accounts left -> 429 capacity exhausted.
  assert.equal(res.statusCode, 429, res.body);
  assert.match(res.body, /xAI capacity unavailable/);
  const rows = getDb().prepare("SELECT status FROM provider_accounts WHERE provider='xai'").all() as any[];
  assert.equal(rows.filter((r) => r.status === 'cooldown').length, 2);
});

test('xAI image generation route forwards Grok Imagine requests and records usage', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_image');
  seedXai('image', 'xai-image-token');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  let seenUrl = '';
  let seenAuth = '';
  let seenBody: any;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: string, init: any) => {
    seenUrl = String(url);
    seenAuth = init.headers.authorization;
    seenBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ usage: { cost_in_usd_ticks: 1000000000 }, data: [{ url: 'https://images.x.ai/generated-1.jpg' }, { url: 'https://images.x.ai/generated-2.jpg' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/xai/images/generations', headers: { authorization: `Bearer ${token.raw}` }, payload: { prompt: 'a startup command center', aspect_ratio: '16:9' } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(seenUrl, 'https://api.x.ai/v1/images/generations');
  assert.equal(seenAuth, 'Bearer xai-image-token');
  assert.equal(seenBody.model, 'grok-imagine-image-quality');
  assert.equal(seenBody.prompt, 'a startup command center');
  const ev = getDb().prepare("SELECT provider,endpoint,model,status_code,estimated_cost_usd FROM usage_events WHERE provider='xai' ORDER BY id DESC LIMIT 1").get() as any;
  assert.equal(ev.endpoint, '/v1/xai/images/generations');
  assert.equal(ev.model, 'grok-imagine-image-quality');
  assert.equal(ev.status_code, 200);
  assert.ok(Math.abs(Number(ev.estimated_cost_usd) - 0.1) < 1e-9, `expected upstream ticks cost 0.1, got ${ev.estimated_cost_usd}`);
});

test('xAI image edit route forwards single URL edits and bills upstream cost ticks', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_image_edit_single');
  seedXai('image-edit-single', 'xai-image-edit-single-token');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  let seenUrl = '';
  let seenBody: any;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: string, init: any) => {
    seenUrl = String(url);
    seenBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ usage: { cost_in_usd_ticks: 600000000 }, data: [{ url: 'https://images.x.ai/edited-1.jpg' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/xai/images/edits', headers: { authorization: `Bearer ${token.raw}` }, payload: { prompt: 'make the jacket red', image_url: 'https://example.com/source.jpg' } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(seenUrl, 'https://api.x.ai/v1/images/edits');
  assert.equal(seenBody.model, 'grok-imagine-image-quality');
  assert.deepEqual(seenBody.image, { url: 'https://example.com/source.jpg', type: 'image_url' });
  assert.equal(seenBody.image_url, undefined);
  assert.equal(seenBody.images, undefined);
  const ev = getDb().prepare("SELECT endpoint,model,status_code,estimated_cost_usd FROM usage_events WHERE provider='xai' ORDER BY id DESC LIMIT 1").get() as any;
  assert.equal(ev.endpoint, '/v1/xai/images/edits');
  assert.equal(ev.model, 'grok-imagine-image-quality');
  assert.equal(ev.status_code, 200);
  assert.ok(Math.abs(Number(ev.estimated_cost_usd) - 0.06) < 1e-9, `expected upstream ticks cost 0.06, got ${ev.estimated_cost_usd}`);
});

test('xAI image edit route falls back to estimated cost when upstream cost ticks are absent', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_image_edit_fallback_cost');
  seedXai('image-edit-fallback-cost', 'xai-image-edit-fallback-cost-token');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => new Response(JSON.stringify({ data: [{ url: 'https://images.x.ai/edited-fallback.jpg' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/xai/images/edits', headers: { authorization: `Bearer ${token.raw}` }, payload: { prompt: 'fallback bill', image_url: 'https://example.com/source.jpg' } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  const ev = getDb().prepare("SELECT endpoint,model,estimated_cost_usd FROM usage_events WHERE provider='xai' ORDER BY id DESC LIMIT 1").get() as any;
  assert.equal(ev.endpoint, '/v1/xai/images/edits');
  assert.equal(ev.model, 'grok-imagine-image-quality');
  assert.ok(Math.abs(Number(ev.estimated_cost_usd) - 0.1) < 1e-9, `expected fallback estimate 0.1, got ${ev.estimated_cost_usd}`);
});

test('xAI image edit route accepts data URI single sources', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_image_edit_data_uri');
  seedXai('image-edit-data-uri', 'xai-image-edit-data-uri-token');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  let seenBody: any;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (_url: string, init: any) => {
    seenBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ data: [{ url: 'https://images.x.ai/edited-data-uri.jpg' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/xai/images/edits', headers: { authorization: `Bearer ${token.raw}` }, payload: { prompt: 'add cinematic lighting', image: { url: 'data:image/png;base64,AAAA' } } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(seenBody.image, { url: 'data:image/png;base64,AAAA', type: 'image_url' });
});

test('xAI image edit route forwards multi-image edits and bills upstream cost ticks', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_image_edit_multi');
  seedXai('image-edit-multi', 'xai-image-edit-multi-token');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  let seenBody: any;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (_url: string, init: any) => {
    seenBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ usage: { cost_in_usd_ticks: 700000000 }, data: [{ url: 'https://images.x.ai/edited-multi.jpg' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/xai/images/edits', headers: { authorization: `Bearer ${token.raw}` }, payload: { prompt: 'combine <IMAGE_0> with <IMAGE_1>', images: ['https://example.com/a.jpg', { url: 'https://example.com/b.jpg' }] } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(seenBody.image, undefined);
  assert.equal(seenBody.images.length, 2);
  assert.deepEqual(seenBody.images, [
    { url: 'https://example.com/a.jpg', type: 'image_url' },
    { url: 'https://example.com/b.jpg', type: 'image_url' },
  ]);
  const ev = getDb().prepare("SELECT endpoint,estimated_cost_usd FROM usage_events WHERE provider='xai' ORDER BY id DESC LIMIT 1").get() as any;
  assert.equal(ev.endpoint, '/v1/xai/images/edits');
  assert.ok(Math.abs(Number(ev.estimated_cost_usd) - 0.07) < 1e-9, `expected upstream ticks cost 0.07, got ${ev.estimated_cost_usd}`);
});

test('xAI image edit route rejects more than three source images before upstream', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_image_edit_too_many');
  seedXai('image-edit-too-many', 'xai-image-edit-too-many-token');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  let calls = 0;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => { calls += 1; return new Response('{}', { status: 200 }); };
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/xai/images/edits', headers: { authorization: `Bearer ${token.raw}` }, payload: { prompt: 'edit', images: ['https://example.com/1.png', 'https://example.com/2.png', 'https://example.com/3.png', 'https://example.com/4.png'] } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 400, res.body);
  assert.match(res.body, /at most 3 source images/);
  assert.equal(calls, 0);
});

test('xAI image edit route requires a source image before upstream', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_image_edit_no_source');
  seedXai('image-edit-no-source', 'xai-image-edit-no-source-token');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  let calls = 0;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => { calls += 1; return new Response('{}', { status: 200 }); };
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/xai/images/edits', headers: { authorization: `Bearer ${token.raw}` }, payload: { prompt: 'edit without source' } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 400, res.body);
  assert.match(res.body, /requires a source image/);
  assert.equal(calls, 0);
});

test('xAI image edit route rejects internal-host source URLs before upstream', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_image_edit_internal');
  seedXai('image-edit-internal', 'xai-image-edit-internal-token');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  let calls = 0;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => { calls += 1; return new Response('{}', { status: 200 }); };
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/xai/images/edits', headers: { authorization: `Bearer ${token.raw}` }, payload: { prompt: 'edit private source', image_url: 'http://127.0.0.1/private.png' } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(calls, 0);
});

test('xAI image edit route bills explicit grok-imagine-image model from upstream cost ticks', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_image_edit_base_model');
  seedXai('image-edit-base-model', 'xai-image-edit-base-model-token');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  let seenBody: any;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (_url: string, init: any) => {
    seenBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ usage: { cost_in_usd_ticks: 220000000 }, data: [{ url: 'https://images.x.ai/edited-base.jpg' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/xai/images/edits', headers: { authorization: `Bearer ${token.raw}` }, payload: { model: 'grok-imagine-image', prompt: 'quick edit', image_url: 'https://example.com/source.jpg' } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(seenBody.model, 'grok-imagine-image');
  const ev = getDb().prepare("SELECT model,estimated_cost_usd FROM usage_events WHERE provider='xai' ORDER BY id DESC LIMIT 1").get() as any;
  assert.equal(ev.model, 'grok-imagine-image');
  assert.ok(Math.abs(Number(ev.estimated_cost_usd) - 0.022) < 1e-9, `expected upstream ticks cost 0.022, got ${ev.estimated_cost_usd}`);
});

test('xAI video generation route forwards Grok Imagine submit requests and records usage', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_video');
  seedXai('video', 'xai-video-token');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  let seenUrl = '';
  let seenAuth = '';
  let seenBody: any;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: string, init: any) => {
    seenUrl = String(url);
    seenAuth = init.headers.authorization;
    seenBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ request_id: 'vid-123' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/xai/videos/generations', headers: { authorization: `Bearer ${token.raw}` }, payload: { prompt: 'animate it', image_url: 'https://example.com/image.jpg', duration: 8 } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(seenUrl, 'https://api.x.ai/v1/videos/generations');
  assert.equal(seenAuth, 'Bearer xai-video-token');
  assert.equal(seenBody.model, 'grok-imagine-video-1.5-preview');
  assert.deepEqual(seenBody.image, { url: 'https://example.com/image.jpg' });
  assert.equal(seenBody.duration, 8);
  const ev = getDb().prepare("SELECT provider,endpoint,model,status_code,estimated_cost_usd FROM usage_events WHERE provider='xai' ORDER BY id DESC LIMIT 1").get() as any;
  assert.equal(ev.endpoint, '/v1/xai/videos/generations');
  assert.equal(ev.model, 'grok-imagine-video-1.5-preview');
  assert.equal(ev.status_code, 200);
  assert.ok(Math.abs(Number(ev.estimated_cost_usd) - 0.64) < 0.000001, `expected 8s cost 0.64, got ${ev.estimated_cost_usd}`);
  const job = getDb().prepare("SELECT request_id, provider_account_id, user_id, token_id, model FROM xai_video_jobs WHERE request_id='vid-123'").get() as any;
  assert.equal(job.request_id, 'vid-123');
  assert.equal(job.user_id, token.userId);
  assert.equal(job.token_id, token.tokenId);
  assert.equal(job.model, 'grok-imagine-video-1.5-preview');
});

test('xAI video generation bills default duration when omitted', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_video_default_duration');
  seedXai('video-default', 'xai-video-default-token');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  let seenBody: any;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (_url: string, init: any) => {
    seenBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ request_id: 'vid-default' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/xai/videos/generations', headers: { authorization: `Bearer ${token.raw}` }, payload: { prompt: 'animate it' } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(seenBody.duration, undefined);
  const ev = getDb().prepare("SELECT estimated_cost_usd FROM usage_events WHERE provider='xai' ORDER BY id DESC LIMIT 1").get() as any;
  assert.ok(Math.abs(Number(ev.estimated_cost_usd) - 0.4) < 0.000001, `expected default 5s cost 0.4, got ${ev.estimated_cost_usd}`);
});

test('xAI video generation clamps duration before billing', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_video_clamped_duration');
  seedXai('video-clamped', 'xai-video-clamped-token');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  let seenBody: any;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (_url: string, init: any) => {
    seenBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ request_id: 'vid-clamped' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/xai/videos/generations', headers: { authorization: `Bearer ${token.raw}` }, payload: { prompt: 'animate it', duration: 30 } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(seenBody.duration, 15);
  const ev = getDb().prepare("SELECT estimated_cost_usd FROM usage_events WHERE provider='xai' ORDER BY id DESC LIMIT 1").get() as any;
  assert.ok(Math.abs(Number(ev.estimated_cost_usd) - 1.2) < 0.000001, `expected clamped 15s cost 1.2, got ${ev.estimated_cost_usd}`);
});

test('xAI video edit route forwards source video object and bills submit floor', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_video_edit');
  seedXai('video-edit', 'xai-video-edit-token');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  let seenUrl = '';
  let seenBody: any;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: string, init: any) => {
    seenUrl = String(url);
    seenBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ request_id: 'edit-r1' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/xai/videos/edits', headers: { authorization: `Bearer ${token.raw}` }, payload: { prompt: 'edit it', video: { url: 'https://vidgen.x.ai/x.mp4', type: 'video_url' } } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().request_id, 'edit-r1');
  assert.equal(seenUrl, 'https://api.x.ai/v1/videos/edits');
  // Video editing must route to grok-imagine-video (only capable model).
  assert.equal(seenBody.model, 'grok-imagine-video');
  assert.deepEqual(seenBody.video, { url: 'https://vidgen.x.ai/x.mp4', type: 'video_url' });
  const ev = getDb().prepare("SELECT endpoint,model,estimated_cost_usd FROM usage_events WHERE provider='xai' ORDER BY id DESC LIMIT 1").get() as any;
  assert.equal(ev.endpoint, '/v1/xai/videos/edits');
  assert.equal(ev.model, 'grok-imagine-video');
  // grok-imagine-video is $0.05/sec; 5s default floor = 0.25.
  assert.ok(Math.abs(Number(ev.estimated_cost_usd) - 0.25) < 1e-9, `expected edit floor 0.25, got ${ev.estimated_cost_usd}`);
  const job = getDb().prepare("SELECT submit_cost_usd,trued_up FROM xai_video_jobs WHERE request_id='edit-r1'").get() as any;
  assert.ok(Math.abs(Number(job.submit_cost_usd) - 0.25) < 1e-9, `expected submit_cost_usd 0.25, got ${job.submit_cost_usd}`);
  assert.equal(job.trued_up, 0);
});

test('xAI video edit route normalizes bare string video to upstream object', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_video_edit_string');
  seedXai('video-edit-string', 'xai-video-edit-string-token');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  let seenBody: any;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (_url: string, init: any) => {
    seenBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ request_id: 'edit-r2' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/xai/videos/edits', headers: { authorization: `Bearer ${token.raw}` }, payload: { prompt: 'edit it', video: 'https://vidgen.x.ai/string.mp4' } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(seenBody.video, { url: 'https://vidgen.x.ai/string.mp4', type: 'video_url' });
});

test('xAI video edit route rejects internal-host source video before upstream', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_video_edit_internal');
  seedXai('video-edit-internal', 'xai-video-edit-internal-token');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  let calls = 0;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => { calls += 1; return new Response('{}', { status: 200 }); };
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/xai/videos/edits', headers: { authorization: `Bearer ${token.raw}` }, payload: { prompt: 'edit it', video: 'http://127.0.0.1/private.mp4' } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(calls, 0);
});

test('xAI video extension route forwards to upstream and bills submit floor', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_video_extend');
  seedXai('video-extend', 'xai-video-extend-token');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  let seenUrl = '';
  let seenBody: any;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: string, init: any) => {
    seenUrl = String(url);
    seenBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ request_id: 'extend-r1' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/xai/videos/extensions', headers: { authorization: `Bearer ${token.raw}` }, payload: { prompt: 'extend it', video_url: 'https://vidgen.x.ai/source.mp4' } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(seenUrl, 'https://api.x.ai/v1/videos/extensions');
  // Video extension must route to grok-imagine-video (only capable model).
  assert.equal(seenBody.model, 'grok-imagine-video');
  assert.deepEqual(seenBody.video, { url: 'https://vidgen.x.ai/source.mp4', type: 'video_url' });
  const ev = getDb().prepare("SELECT endpoint,model,estimated_cost_usd FROM usage_events WHERE provider='xai' ORDER BY id DESC LIMIT 1").get() as any;
  assert.equal(ev.endpoint, '/v1/xai/videos/extensions');
  assert.equal(ev.model, 'grok-imagine-video');
  // grok-imagine-video is $0.05/sec; 5s default floor = 0.25.
  assert.ok(Math.abs(Number(ev.estimated_cost_usd) - 0.25) < 1e-9, `expected extension floor 0.25, got ${ev.estimated_cost_usd}`);
  const job = getDb().prepare("SELECT submit_cost_usd FROM xai_video_jobs WHERE request_id='extend-r1'").get() as any;
  assert.ok(Math.abs(Number(job.submit_cost_usd) - 0.25) < 1e-9, `expected submit_cost_usd 0.25, got ${job.submit_cost_usd}`);
});

test('xAI reference-to-video routes to grok-imagine-video and forwards reference_images', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_ref_video');
  seedXai('video-ref', 'xai-video-ref-token');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  let seenUrl = '';
  let seenBody: any;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: string, init: any) => {
    seenUrl = String(url);
    seenBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ request_id: 'ref-r1' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = Fastify();
  registerXaiProxy(app);
  const referenceUrls = [
    'https://example.com/a.png', 'https://example.com/b.png', 'https://example.com/c.png',
    'https://example.com/d.png', 'https://example.com/e.png', 'https://example.com/f.png',
    'https://example.com/g.png',
  ];
  const res = await app.inject({ method: 'POST', url: '/v1/xai/videos/generations', headers: { authorization: 'Bearer ' + token.raw }, payload: { prompt: 'runway walk', reference_image_urls: referenceUrls } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(seenUrl, 'https://api.x.ai/v1/videos/generations');
  // Default (unpinned) reference request must upgrade to the capable model and
  // preserve all seven reference images allowed by xAI Imagine.
  assert.equal(seenBody.model, 'grok-imagine-video');
  assert.deepEqual(seenBody.reference_images, referenceUrls.map((url) => ({ url })));
  assert.equal(seenBody.reference_image_urls, undefined);
  const ev = getDb().prepare("SELECT model FROM usage_events WHERE provider='xai' ORDER BY id DESC LIMIT 1").get() as any;
  assert.equal(ev.model, 'grok-imagine-video');
});

test('xAI reference-to-video rejects a pinned model that cannot do reference-to-video before upstream', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_ref_video_bad_model');
  seedXai('video-ref-bad', 'xai-video-ref-bad-token');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  let calls = 0;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => { calls += 1; return new Response('{}', { status: 200 }); };
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/xai/videos/generations', headers: { authorization: `Bearer ${token.raw}` }, payload: { prompt: 'runway walk', model: 'grok-imagine-video-1.5-preview', reference_image_urls: ['https://example.com/a.png'] } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(calls, 0, 'must not forward an incapable reference-to-video request upstream');
  assert.match(res.json().error.message, /reference-to-video requires model "grok-imagine-video"/);
});

test('xAI plain video generation still defaults to grok-imagine-video-1.5-preview', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_plain_video_default');
  seedXai('video-plain', 'xai-video-plain-token');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  let seenBody: any;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (_url: string, init: any) => {
    seenBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ request_id: 'plain-r1' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/xai/videos/generations', headers: { authorization: `Bearer ${token.raw}` }, payload: { prompt: 'a calm ocean at sunset' } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(seenBody.model, 'grok-imagine-video-1.5-preview');
  assert.equal(seenBody.reference_images, undefined);
});

test('xAI video edit rejects a pinned model that cannot edit before upstream', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_edit_bad_model');
  seedXai('video-edit-bad', 'xai-video-edit-bad-token');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  let calls = 0;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => { calls += 1; return new Response('{}', { status: 200 }); };
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/xai/videos/edits', headers: { authorization: `Bearer ${token.raw}` }, payload: { prompt: 'edit it', model: 'grok-imagine-video-1.5-preview', video: 'https://vidgen.x.ai/x.mp4' } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(calls, 0, 'must not forward an incapable edit request upstream');
  assert.match(res.json().error.message, /video editing requires model "grok-imagine-video"/);
});

test('xAI video status route forwards polling requests', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_video_status');
  seedXai('video-status', 'xai-video-status-token');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  const accountId = (getDb().prepare("SELECT id FROM provider_accounts WHERE label='video-status'").get() as any).id;
  getDb().prepare('INSERT INTO xai_video_jobs (request_id,provider_account_id,user_id,token_id,model,created_at) VALUES (?,?,?,?,?,?)')
    .run('vid-123', accountId, token.userId, token.tokenId, 'grok-imagine-video-1.5-preview', Date.now());
  let seenUrl = '';
  let seenAuth = '';
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: string, init: any) => {
    seenUrl = String(url);
    seenAuth = init.headers.authorization;
    return new Response(JSON.stringify({ status: 'done', video: { url: 'https://videos.x.ai/out.mp4' } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'GET', url: '/v1/xai/videos/vid-123', headers: { authorization: `Bearer ${token.raw}` } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(seenUrl, 'https://api.x.ai/v1/videos/vid-123');
  assert.equal(seenAuth, 'Bearer xai-video-status-token');
  assert.equal(res.json().video.url, 'https://videos.x.ai/out.mp4');
  const ev = getDb().prepare("SELECT endpoint,model,status_code,estimated_cost_usd FROM usage_events WHERE provider='xai' ORDER BY id DESC LIMIT 1").get() as any;
  assert.equal(ev.endpoint, '/v1/xai/videos/:requestId');
  assert.equal(ev.model, 'grok-imagine-video-1.5-preview');
  assert.equal(ev.status_code, 200);
  assert.equal(ev.estimated_cost_usd, 0);
});

test('xAI video status true-ups edit jobs from upstream cost ticks once', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_video_trueup');
  const accountId = seedXai('video-trueup', 'xai-video-trueup-token');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  getDb().prepare('INSERT INTO xai_video_jobs (request_id,provider_account_id,user_id,token_id,model,submit_cost_usd,trued_up,created_at) VALUES (?,?,?,?,?,?,0,?)')
    .run('edit-trueup', accountId, token.userId, token.tokenId, 'grok-imagine-video', 0.25, Date.now());
  let calls = 0;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ status: 'done', video: { url: 'https://videos.x.ai/trueup.mp4', duration: 6 }, model: 'grok-imagine-video', usage: { cost_in_usd_ticks: 3500000000 }, progress: 100 }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = Fastify();
  registerXaiProxy(app);
  const first = await app.inject({ method: 'GET', url: '/v1/xai/videos/edit-trueup', headers: { authorization: `Bearer ${token.raw}` } });
  const second = await app.inject({ method: 'GET', url: '/v1/xai/videos/edit-trueup', headers: { authorization: `Bearer ${token.raw}` } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(calls, 2);
  const reconcileRows = getDb().prepare("SELECT endpoint,estimated_cost_usd FROM usage_events WHERE provider='xai' AND endpoint='/v1/xai/videos/:reconcile' ORDER BY id").all() as any[];
  assert.equal(reconcileRows.length, 1);
  assert.ok(Math.abs(Number(reconcileRows[0].estimated_cost_usd) - 0.10) < 1e-9, `expected true-up delta 0.10, got ${reconcileRows[0].estimated_cost_usd}`);
  const job = getDb().prepare("SELECT trued_up FROM xai_video_jobs WHERE request_id='edit-trueup'").get() as any;
  assert.equal(job.trued_up, 1);
});

test('xAI video submit records account affinity and status poll reuses the same account', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_video_affinity');
  seedXai('video-a', 'xai-video-a-token');
  seedXai('video-b', 'xai-video-b-token');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  const seenAuths: string[] = [];
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: string, init: any) => {
    seenAuths.push(init.headers.authorization);
    if (String(url).endsWith('/videos/generations')) return new Response(JSON.stringify({ request_id: 'vid-affinity' }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ status: 'done', video: { url: 'https://videos.x.ai/affinity.mp4' } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = Fastify();
  registerXaiProxy(app);
  const submit = await app.inject({ method: 'POST', url: '/v1/xai/videos/generations', headers: { authorization: `Bearer ${token.raw}` }, payload: { prompt: 'animate it', duration: 5 } });
  const poll = await app.inject({ method: 'GET', url: '/v1/xai/videos/vid-affinity', headers: { authorization: `Bearer ${token.raw}` } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(submit.statusCode, 200, submit.body);
  assert.equal(poll.statusCode, 200, poll.body);
  assert.equal(seenAuths.length, 2);
  assert.equal(seenAuths[1], seenAuths[0]);
  assert.equal(poll.headers['x-gateway-account'], submit.headers['x-gateway-account']);
});

test('xAI media route full-body logging stores metadata only', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_media_log');
  seedXai('media-log', 'xai-media-log-token');
  getDb().prepare('UPDATE users SET full_body_logging=1 WHERE id=?').run(token.userId);
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => new Response(JSON.stringify({ data: [{ url: 'https://temporary-media.x.ai/private-generated.jpg' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  const app = Fastify();
  registerXaiProxy(app);
  const prompt = 'private prompt that must not be logged';
  const imageData = 'data:image/png;base64,AAAAsecretbase64BBBB';
  const res = await app.inject({ method: 'POST', url: '/v1/xai/images/generations', headers: { authorization: `Bearer ${token.raw}` }, payload: { prompt, image: { url: imageData } } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  const log = getDb().prepare('SELECT request_json,response_text FROM request_logs ORDER BY id DESC LIMIT 1').get() as any;
  assert.ok(log, 'expected metadata log row');
  const combined = `${log.request_json}\n${log.response_text}`;
  assert.doesNotMatch(combined, /private prompt/);
  assert.doesNotMatch(combined, /AAAAsecretbase64BBBB/);
  assert.doesNotMatch(combined, /temporary-media\.x\.ai/);
  const requestJson = JSON.parse(log.request_json);
  assert.equal(requestJson.endpoint, '/v1/xai/images/generations');
  assert.equal(requestJson.model, 'grok-imagine-image-quality');
  assert.equal(requestJson.imageCount, 1);
});

test('xAI video status is owner-scoped and rejects cross-user polling', async () => {
  resetRuntimeTables();
  const owner = seedUserAndToken('nbmg_xai_owner', 'owner-xai@example.com');
  const other = seedUserAndToken('nbmg_xai_other', 'other-xai@example.com');
  seedXai('owner-video', 'xai-owner-token');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(owner.userId, 'xai', 'allow_all');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(other.userId, 'xai', 'allow_all');
  let calls = 0;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ request_id: 'vid-private' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = Fastify();
  registerXaiProxy(app);
  const submit = await app.inject({ method: 'POST', url: '/v1/xai/videos/generations', headers: { authorization: `Bearer ${owner.raw}` }, payload: { prompt: 'private video', duration: 5 } });
  const pollOther = await app.inject({ method: 'GET', url: '/v1/xai/videos/vid-private', headers: { authorization: `Bearer ${other.raw}` } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(submit.statusCode, 200, submit.body);
  assert.equal(pollOther.statusCode, 404, pollOther.body);
  assert.equal(calls, 1, 'cross-user poll must not hit upstream');
});

test('xAI video status does not fall back when mapped account is disabled', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_disabled_affinity');
  seedXai('mapped-video', 'xai-mapped-token');
  seedXai('fallback-video', 'xai-fallback-token');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  let calls = 0;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ request_id: 'vid-disabled' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = Fastify();
  registerXaiProxy(app);
  const submit = await app.inject({ method: 'POST', url: '/v1/xai/videos/generations', headers: { authorization: `Bearer ${token.raw}` }, payload: { prompt: 'animate', duration: 5 } });
  assert.equal(submit.statusCode, 200, submit.body);
  const mappedLabel = String(submit.headers['x-gateway-account']);
  getDb().prepare("UPDATE provider_accounts SET enabled=0 WHERE label=?").run(mappedLabel);
  const poll = await app.inject({ method: 'GET', url: '/v1/xai/videos/vid-disabled', headers: { authorization: `Bearer ${token.raw}` } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(poll.statusCode, 503, poll.body);
  assert.equal(calls, 1, 'disabled mapped account should not fall back to the other xAI account');
});

test('xAI video status keeps edit-job affinity for disabled and unknown request ids', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_edit_affinity_errors');
  const accountId = seedXai('mapped-edit-video', 'xai-mapped-edit-token');
  seedXai('fallback-edit-video', 'xai-fallback-edit-token');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  getDb().prepare('INSERT INTO xai_video_jobs (request_id,provider_account_id,user_id,token_id,model,submit_cost_usd,trued_up,created_at) VALUES (?,?,?,?,?,?,0,?)')
    .run('edit-disabled', accountId, token.userId, token.tokenId, 'grok-imagine-video', 0.25, Date.now());
  getDb().prepare('UPDATE provider_accounts SET enabled=0 WHERE id=?').run(accountId);
  let calls = 0;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => { calls += 1; return new Response('{}', { status: 200 }); };
  const app = Fastify();
  registerXaiProxy(app);
  const disabled = await app.inject({ method: 'GET', url: '/v1/xai/videos/edit-disabled', headers: { authorization: `Bearer ${token.raw}` } });
  const unknown = await app.inject({ method: 'GET', url: '/v1/xai/videos/edit-unknown', headers: { authorization: `Bearer ${token.raw}` } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(disabled.statusCode, 503, disabled.body);
  assert.equal(unknown.statusCode, 404, unknown.body);
  assert.equal(calls, 0);
});

test('xAI video status stays cost-free even when upstream returns a completed duration', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_video_poll_free');
  seedXai('poll-free-video', 'xai-poll-free-token');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: string) => {
    if (String(url).endsWith('/videos/generations')) return new Response(JSON.stringify({ request_id: 'vid-poll-free' }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ status: 'done', video: { url: 'https://videos.x.ai/free.mp4', duration: 12 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = Fastify();
  registerXaiProxy(app);
  const submit = await app.inject({ method: 'POST', url: '/v1/xai/videos/generations', headers: { authorization: `Bearer ${token.raw}` }, payload: { prompt: 'animate it', duration: 5 } });
  const poll = await app.inject({ method: 'GET', url: '/v1/xai/videos/vid-poll-free', headers: { authorization: `Bearer ${token.raw}` } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(submit.statusCode, 200, submit.body);
  assert.equal(poll.statusCode, 200, poll.body);
  const costs = (getDb().prepare("SELECT endpoint, estimated_cost_usd FROM usage_events WHERE provider='xai' AND endpoint IN ('/v1/xai/videos/generations','/v1/xai/videos/:requestId') ORDER BY id").all() as any[]).map((r) => Number(r.estimated_cost_usd));
  assert.equal(costs.length, 2);
  assert.equal(costs[0], 0.4);
  assert.equal(costs[1], 0);
  const reconcile = getDb().prepare("SELECT COUNT(*) AS count FROM usage_events WHERE provider='xai' AND endpoint='/v1/xai/videos/:reconcile'").get() as any;
  assert.equal(reconcile.count, 0);
});

test('xAI media routes reject internal hosts before upstream', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_internal_media_url');
  seedXai('internal-media-url', 'xai-internal-media-url-token');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  let calls = 0;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => { calls += 1; return new Response('{}', { status: 200 }); };
  const app = Fastify();
  registerXaiProxy(app);
  const imageUrl = await app.inject({ method: 'POST', url: '/v1/xai/videos/generations', headers: { authorization: `Bearer ${token.raw}` }, payload: { prompt: 'animate', image_url: 'http://127.0.0.1/private.png' } });
  const imageObject = await app.inject({ method: 'POST', url: '/v1/xai/images/generations', headers: { authorization: `Bearer ${token.raw}` }, payload: { prompt: 'image', image: { url: 'http://10.1.2.3/private.png' } } });
  const reference = await app.inject({ method: 'POST', url: '/v1/xai/videos/generations', headers: { authorization: `Bearer ${token.raw}` }, payload: { prompt: 'animate', reference_image_urls: ['http://localhost/private.png'] } });
  const wildcard = await app.inject({ method: 'POST', url: '/v1/xai/videos/generations', headers: { authorization: `Bearer ${token.raw}` }, payload: { prompt: 'animate', image_url: 'http://0.0.0.0/x.png' } });
  const localhostSubdomain = await app.inject({ method: 'POST', url: '/v1/xai/videos/generations', headers: { authorization: `Bearer ${token.raw}` }, payload: { prompt: 'animate', image_url: 'http://foo.localhost/x.png' } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(imageUrl.statusCode, 400, imageUrl.body);
  assert.equal(imageObject.statusCode, 400, imageObject.body);
  assert.equal(reference.statusCode, 400, reference.body);
  assert.equal(wildcard.statusCode, 400, wildcard.body);
  assert.equal(localhostSubdomain.statusCode, 400, localhostSubdomain.body);
  assert.equal(calls, 0);
});

test('xAI media routes allow public URLs and image data URIs', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_public_media_url');
  seedXai('public-media-url', 'xai-public-media-url-token');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  const seenBodies: any[] = [];
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: string, init: any) => {
    seenBodies.push(JSON.parse(init.body));
    if (String(url).endsWith('/videos/generations')) return new Response(JSON.stringify({ request_id: 'vid-public-media' }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ data: [{ url: 'https://images.x.ai/public.png' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = Fastify();
  registerXaiProxy(app);
  const publicUrl = await app.inject({ method: 'POST', url: '/v1/xai/videos/generations', headers: { authorization: `Bearer ${token.raw}` }, payload: { prompt: 'animate', image_url: 'https://example.com/image.jpg' } });
  const dataUri = await app.inject({ method: 'POST', url: '/v1/xai/images/generations', headers: { authorization: `Bearer ${token.raw}` }, payload: { prompt: 'image', image: { url: 'data:image/png;base64,AAAA' } } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(publicUrl.statusCode, 200, publicUrl.body);
  assert.equal(dataUri.statusCode, 200, dataUri.body);
  assert.deepEqual(seenBodies[0].image, { url: 'https://example.com/image.jpg' });
  assert.deepEqual(seenBodies[1].image, { url: 'data:image/png;base64,AAAA' });
});

test('xAI media routes reject non-priced known models and invalid bodies before upstream', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_media_validation');
  seedXai('validation', 'xai-validation-token');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  let calls = 0;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => { calls += 1; return new Response('{}', { status: 200 }); };
  const app = Fastify();
  registerXaiProxy(app);
  const model = await app.inject({ method: 'POST', url: '/v1/xai/images/generations', headers: { authorization: `Bearer ${token.raw}` }, payload: { model: 'grok-4.3', prompt: 'not a media model' } });
  const prompt = await app.inject({ method: 'POST', url: '/v1/xai/images/generations', headers: { authorization: `Bearer ${token.raw}` }, payload: { prompt: 'x'.repeat(8001) } });
  const refs = await app.inject({ method: 'POST', url: '/v1/xai/videos/generations', headers: { authorization: `Bearer ${token.raw}` }, payload: { prompt: 'animate', reference_image_urls: Array.from({ length: 8 }, (_, i) => `https://example.com/${i + 1}.png`) } });
  const url = await app.inject({ method: 'POST', url: '/v1/xai/videos/generations', headers: { authorization: `Bearer ${token.raw}` }, payload: { prompt: 'animate', image_url: 'ftp://example.com/bad.png' } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(model.statusCode, 400, model.body);
  assert.equal(prompt.statusCode, 400, prompt.body);
  assert.equal(refs.statusCode, 400, refs.body);
  assert.equal(url.statusCode, 400, url.body);
  assert.equal(calls, 0);
});

test('xAI video status rejects dot-segment request ids', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('nbmg_xai_bad_request_id');
  seedXai('bad-request-id', 'xai-bad-request-id-token');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'xai', 'allow_all');
  let calls = 0;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => { calls += 1; return new Response('{}', { status: 200 }); };
  const app = Fastify();
  registerXaiProxy(app);
  const res = await app.inject({ method: 'GET', url: '/v1/xai/videos/a..b', headers: { authorization: `Bearer ${token.raw}` } });
  (globalThis as any).fetch = oldFetch;
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(calls, 0);
});
