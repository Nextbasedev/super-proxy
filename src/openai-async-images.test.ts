import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';

process.env.DATABASE_PATH = path.join(os.tmpdir(), `nbmg-openai-async-${process.pid}.sqlite`);
process.env.OPENAI_UPSTREAM_URL = 'https://openai.test';
process.env.OPENAI_PLATFORM_UPSTREAM_URL = 'https://api.openai.test/v1';

const { getDb } = await import('./db/index.js');
const { migrate, LATEST_SCHEMA_MIGRATION_VERSION } = await import('./db/migrate.js');
const { sha256 } = await import('./utils/crypto.js');
const { registerOpenAiProxy } = await import('./proxy/openai.js');

function resetTables() {
  const db = getDb();
  db.prepare('DELETE FROM image_jobs').run();
  db.prepare('DELETE FROM request_logs').run();
  db.prepare('DELETE FROM provider_health_events').run();
  db.prepare('DELETE FROM usage_events').run();
  db.prepare('DELETE FROM api_tokens').run();
  db.prepare('DELETE FROM user_provider_access_modes').run();
  db.prepare('DELETE FROM users WHERE email != ?').run('daxitm2112@gmail.com');
  db.prepare('DELETE FROM provider_accounts').run();
}

function seedUserAndToken(raw = `nbmg_async_test_${Math.random().toString(36).slice(2)}`) {
  const db = getDb();
  const userId = Number(db.prepare("INSERT INTO users (email,role,is_admin,enabled,full_body_logging) VALUES (?, 'developer', 0, 1, 0)").run(`dev-${Math.random().toString(36).slice(2)}@example.com`).lastInsertRowid);
  db.prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(userId, 'openai_codex', 'allow_all');
  const tokenId = Number(db.prepare('INSERT INTO api_tokens (user_id,label,token_hash,token_prefix,enabled) VALUES (?,?,?,?,1)').run(userId, 'dev-token', sha256(raw), raw.slice(0, 14)).lastInsertRowid);
  return { raw, userId, tokenId };
}

let codexSeedCounter = 0;
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

async function pollUntil(app: any, raw: string, jobId: string, predicate: (j: any) => boolean, tries = 50) {
  for (let i = 0; i < tries; i++) {
    const res = await app.inject({ method: 'GET', url: `/v1/images/jobs/${jobId}`, headers: { authorization: `Bearer ${raw}` } });
    const json = res.json();
    if (predicate(json)) return { res, json };
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('pollUntil timed out');
}

const IMAGE_SSE = [
  'data: ' + JSON.stringify({ type: 'response.output_item.done', item: { type: 'image_generation_call', result: 'iVBORw0KGgo=', revised_prompt: 'a cat' } }) + '\n\n',
  'data: ' + JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 0 } } }) + '\n\n',
  'data: [DONE]\n\n',
].join('');

migrate();

test('image_jobs migration is registered as the latest schema version', () => {
  // image_jobs landed in migration 2026070301; later migrations bump the
  // latest-version constant, so assert it is at least that version rather than
  // pinning an exact number (which breaks on every new migration).
  assert.ok(LATEST_SCHEMA_MIGRATION_VERSION >= 2026070301);
  const cols = (getDb().prepare('PRAGMA table_info(image_jobs)').all() as any[]).map((c) => c.name);
  for (const c of ['id', 'user_id', 'token_id', 'endpoint', 'status', 'request_json', 'result_json', 'error_json', 'status_code', 'provider_account_label', 'created_at', 'updated_at', 'expires_at']) {
    assert.ok(cols.includes(c), `image_jobs missing column ${c}`);
  }
});

test('async generations: queue -> running -> completed with OpenAI Images shape', async () => {
  resetTables();
  const token = seedUserAndToken('nbmg_async_gen_ok');
  seedCodexFresh('codex-async-gen');
  let seenUrl = '';
  let seenBody: any;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: string, init: any) => {
    seenUrl = String(url);
    seenBody = JSON.parse(String(init.body));
    return new Response(IMAGE_SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const app = await buildApp();
  try {
    const enq = await app.inject({ method: 'POST', url: '/v1/images/generations/async', headers: { authorization: `Bearer ${token.raw}` }, payload: { model: 'gpt-image-2', prompt: 'a cat' } });
    assert.equal(enq.statusCode, 202, enq.body);
    const enqJson = enq.json();
    assert.equal(enqJson.status, 'queued');
    assert.ok(enqJson.job_id);
    assert.equal(enqJson.poll_url, `/v1/images/jobs/${enqJson.job_id}`);
    assert.equal(enq.headers['x-gateway-image-mode'], 'codex-responses-async');

    const { res, json } = await pollUntil(app, token.raw, enqJson.job_id, (j) => j.status === 'completed' || j.status === 'failed');
    assert.equal(json.status, 'completed', JSON.stringify(json));
    assert.equal(res.headers['x-gateway-image-mode'], 'codex-responses-async');
    assert.equal(json.status_code, 200);
    assert.equal(typeof json.created, 'number');
    assert.deepEqual(json.data, [{ b64_json: 'iVBORw0KGgo=', revised_prompt: 'a cat' }]);
    // Upstream shape check
    assert.equal(seenUrl, 'https://openai.test/codex/responses');
    assert.equal(seenBody.tools[0].type, 'image_generation');
    // Usage recorded (billing/usage still logs on async completion)
    const usage = getDb().prepare("SELECT COUNT(*) AS n FROM usage_events WHERE endpoint='/v1/images/generations' AND status_code=200").get() as any;
    assert.equal(usage.n, 1);
  } finally {
    await app.close();
    (globalThis as any).fetch = oldFetch;
  }
});

test('async edits: base64 image is persisted and reconstructed into Responses input', async () => {
  resetTables();
  const token = seedUserAndToken('nbmg_async_edit_ok');
  seedCodexFresh('codex-async-edit');
  let seenBody: any;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (_url: string, init: any) => {
    seenBody = JSON.parse(String(init.body));
    return new Response(IMAGE_SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const app = await buildApp();
  try {
    const enq = await app.inject({ method: 'POST', url: '/v1/images/edits/async', headers: { authorization: `Bearer ${token.raw}` }, payload: { model: 'gpt-image-2', prompt: 'make it cinematic', image: 'QUFBQQ==' } });
    assert.equal(enq.statusCode, 202, enq.body);
    const jobId = enq.json().job_id;
    // request_json persisted with the base64 image
    const row = getDb().prepare('SELECT request_json FROM image_jobs WHERE id=?').get(jobId) as any;
    assert.equal(JSON.parse(row.request_json).image, 'QUFBQQ==');

    const { json } = await pollUntil(app, token.raw, jobId, (j) => j.status === 'completed' || j.status === 'failed');
    assert.equal(json.status, 'completed', JSON.stringify(json));
    const content = seenBody.input[0].content;
    assert.equal(content[0].text, 'make it cinematic');
    assert.equal(content[1].type, 'input_image');
    assert.match(content[1].image_url, /^data:image\/png;base64,/);
  } finally {
    await app.close();
    (globalThis as any).fetch = oldFetch;
  }
});

test('async multipart edits persist parsed base64 image into the job', async () => {
  resetTables();
  const token = seedUserAndToken('nbmg_async_edit_multipart');
  seedCodexFresh('codex-async-mp');
  const boundary = 'nbmgAsyncBoundary';
  const body = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-image-2\r\n--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nmake it pop\r\n--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="source.png"\r\nContent-Type: image/png\r\n\r\nPNGDATA\r\n--${boundary}--\r\n`, 'utf8');
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => new Response(IMAGE_SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const app = await buildApp();
  try {
    const enq = await app.inject({ method: 'POST', url: '/v1/images/edits/async', headers: { authorization: `Bearer ${token.raw}`, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body });
    assert.equal(enq.statusCode, 202, enq.body);
    const jobId = enq.json().job_id;
    const row = getDb().prepare('SELECT request_json FROM image_jobs WHERE id=?').get(jobId) as any;
    const persisted = JSON.parse(row.request_json);
    assert.match(persisted.image, /^data:image\/png;base64,/);
    const { json } = await pollUntil(app, token.raw, jobId, (j) => j.status === 'completed' || j.status === 'failed');
    assert.equal(json.status, 'completed', JSON.stringify(json));
  } finally {
    await app.close();
    (globalThis as any).fetch = oldFetch;
  }
});

test('async multipart edits reject missing image before enqueue', async () => {
  resetTables();
  const token = seedUserAndToken('nbmg_async_edit_no_image');
  seedCodexFresh('codex-async-noimg');
  const boundary = 'nbmgAsyncNoImg';
  const body = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-image-2\r\n--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nhi\r\n--${boundary}--\r\n`, 'utf8');
  let called = false;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => { called = true; return new Response(''); };
  const app = await buildApp();
  try {
    const res = await app.inject({ method: 'POST', url: '/v1/images/edits/async', headers: { authorization: `Bearer ${token.raw}`, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body });
    assert.equal(res.statusCode, 400, res.body);
    assert.match(res.body, /requires at least one image field/);
    assert.equal(called, false);
    assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM image_jobs').get() as any).n, 0);
  } finally {
    await app.close();
    (globalThis as any).fetch = oldFetch;
  }
});

test('async failure: upstream error is stored as failed with status_code + error object', async () => {
  resetTables();
  const token = seedUserAndToken('nbmg_async_fail');
  seedCodexFresh('codex-async-fail');
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => new Response(JSON.stringify({ error: { message: 'nope' } }), { status: 400, headers: { 'content-type': 'application/json' } });
  const app = await buildApp();
  try {
    const enq = await app.inject({ method: 'POST', url: '/v1/images/generations/async', headers: { authorization: `Bearer ${token.raw}` }, payload: { model: 'gpt-image-2', prompt: 'x' } });
    const jobId = enq.json().job_id;
    const { json } = await pollUntil(app, token.raw, jobId, (j) => j.status === 'completed' || j.status === 'failed');
    assert.equal(json.status, 'failed', JSON.stringify(json));
    assert.equal(json.status_code, 400);
    assert.ok(json.error);
    // Usage recorded on failure path? Sync error path records usage; async mirrors it via runCodexImageJob when it reaches upstream. Here 400 is non-retryable so no recordUsage in worker; job simply marked failed.
  } finally {
    await app.close();
    (globalThis as any).fetch = oldFetch;
  }
});

test('ownership scoping: another user cannot read someone else\'s job (404)', async () => {
  resetTables();
  const owner = seedUserAndToken('nbmg_async_owner');
  const other = seedUserAndToken('nbmg_async_other');
  seedCodexFresh('codex-async-scope');
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => new Response(IMAGE_SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const app = await buildApp();
  try {
    const enq = await app.inject({ method: 'POST', url: '/v1/images/generations/async', headers: { authorization: `Bearer ${owner.raw}` }, payload: { model: 'gpt-image-2', prompt: 'a cat' } });
    const jobId = enq.json().job_id;
    // owner can read
    const ownerRead = await app.inject({ method: 'GET', url: `/v1/images/jobs/${jobId}`, headers: { authorization: `Bearer ${owner.raw}` } });
    assert.equal(ownerRead.statusCode, 200, ownerRead.body);
    // other user gets 404
    const otherRead = await app.inject({ method: 'GET', url: `/v1/images/jobs/${jobId}`, headers: { authorization: `Bearer ${other.raw}` } });
    assert.equal(otherRead.statusCode, 404, otherRead.body);
    assert.match(otherRead.body, /not found/i);
    // unknown id -> 404
    const missing = await app.inject({ method: 'GET', url: `/v1/images/jobs/does-not-exist`, headers: { authorization: `Bearer ${owner.raw}` } });
    assert.equal(missing.statusCode, 404, missing.body);
  } finally {
    await app.close();
    (globalThis as any).fetch = oldFetch;
  }
});

test('stuck running job older than 10m is lazily marked failed on read', async () => {
  resetTables();
  const token = seedUserAndToken('nbmg_async_stuck');
  const now = Date.now();
  const jobId = 'stuck-job-1';
  getDb().prepare(`INSERT INTO image_jobs (id,user_id,token_id,endpoint,status,request_json,created_at,updated_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(jobId, token.userId, token.tokenId, '/images/generations', 'running', JSON.stringify({ model: 'gpt-image-2', prompt: 'x' }), now - 20 * 60_000, now - 20 * 60_000, now + 60 * 60_000);
  const app = await buildApp();
  try {
    const res = await app.inject({ method: 'GET', url: `/v1/images/jobs/${jobId}`, headers: { authorization: `Bearer ${token.raw}` } });
    assert.equal(res.statusCode, 200, res.body);
    const json = res.json();
    assert.equal(json.status, 'failed');
    assert.equal(json.status_code, 500);
    assert.match(JSON.stringify(json.error), /worker lost|restart/i);
  } finally {
    await app.close();
  }
});

test('expired job rows are purged lazily on read', async () => {
  resetTables();
  const token = seedUserAndToken('nbmg_async_expired');
  const now = Date.now();
  getDb().prepare(`INSERT INTO image_jobs (id,user_id,token_id,endpoint,status,request_json,created_at,updated_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run('expired-1', token.userId, token.tokenId, '/images/generations', 'completed', JSON.stringify({}), now - 2 * 60 * 60_000, now - 90 * 60_000, now - 60_000);
  const app = await buildApp();
  try {
    const res = await app.inject({ method: 'GET', url: `/v1/images/jobs/expired-1`, headers: { authorization: `Bearer ${token.raw}` } });
    assert.equal(res.statusCode, 404, res.body);
    assert.equal((getDb().prepare("SELECT COUNT(*) AS n FROM image_jobs WHERE id='expired-1'").get() as any).n, 0);
  } finally {
    await app.close();
  }
});

test('async model-not-allowed is rejected up front (no job row)', async () => {
  resetTables();
  const token = seedUserAndToken('nbmg_async_denied');
  // Deny openai_codex for this user by removing the allow_all mode.
  getDb().prepare('DELETE FROM user_provider_access_modes WHERE user_id=?').run(token.userId);
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'openai_codex', 'deny_all');
  seedCodexFresh('codex-async-denied');
  let called = false;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => { called = true; return new Response(''); };
  const app = await buildApp();
  try {
    const res = await app.inject({ method: 'POST', url: '/v1/images/generations/async', headers: { authorization: `Bearer ${token.raw}` }, payload: { model: 'gpt-image-2', prompt: 'x' } });
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(called, false);
    assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM image_jobs').get() as any).n, 0);
  } finally {
    await app.close();
    (globalThis as any).fetch = oldFetch;
  }
});

test('async over-limit is rejected up front (429, no job row)', async () => {
  resetTables();
  const token = seedUserAndToken('nbmg_async_overlimit');
  getDb().prepare('UPDATE api_tokens SET cap_tokens_daily=1 WHERE id=?').run(token.tokenId);
  getDb().prepare("INSERT INTO usage_events (user_id,token_id,provider,endpoint,model,status_code,input_tokens,output_tokens) VALUES (?,?,?,?,?,?,?,?)")
    .run(token.userId, token.tokenId, 'openai_codex', '/v1/images/generations', 'gpt-image-2', 200, 1, 0);
  seedCodexFresh('codex-async-overlimit');
  let called = false;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => { called = true; return new Response(''); };
  const app = await buildApp();
  try {
    const res = await app.inject({ method: 'POST', url: '/v1/images/generations/async', headers: { authorization: `Bearer ${token.raw}` }, payload: { model: 'gpt-image-2', prompt: 'x' } });
    assert.equal(res.statusCode, 429, res.body);
    assert.equal(called, false);
    assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM image_jobs').get() as any).n, 0);
  } finally {
    await app.close();
    (globalThis as any).fetch = oldFetch;
  }
});

test('sync Codex image path still returns identical OpenAI Images shape after refactor', async () => {
  resetTables();
  const token = seedUserAndToken('nbmg_sync_unchanged');
  seedCodexFresh('codex-sync-unchanged');
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => new Response(IMAGE_SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const app = await buildApp();
  try {
    const res = await app.inject({ method: 'POST', url: '/v1/images/generations', headers: { authorization: `Bearer ${token.raw}` }, payload: { model: 'gpt-image-2', prompt: 'a cat' } });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.headers['x-gateway-provider'], 'openai_codex');
    assert.equal(res.headers['x-gateway-image-mode'], 'codex-responses-tool');
    const json = res.json();
    assert.equal(typeof json.created, 'number');
    assert.deepEqual(json.data, [{ b64_json: 'iVBORw0KGgo=', revised_prompt: 'a cat' }]);
    // No image_jobs row is created by the sync path.
    assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM image_jobs').get() as any).n, 0);
  } finally {
    await app.close();
    (globalThis as any).fetch = oldFetch;
  }
});
