import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';

process.env.DATABASE_PATH = path.join(os.tmpdir(), `nbmg-fish-${process.pid}.sqlite`);
process.env.FISH_UPSTREAM_URL = 'https://fish.test';

const { getDb } = await import('./db/index.js');
const { migrate } = await import('./db/migrate.js');
const { sha256 } = await import('./utils/crypto.js');
const { registerFishProxy } = await import('./proxy/fish.js');

function resetTables() {
  const db = getDb();
  db.prepare('DELETE FROM request_logs').run();
  db.prepare('DELETE FROM usage_events').run();
  db.prepare('DELETE FROM api_tokens').run();
  db.prepare('DELETE FROM user_provider_access_modes').run();
  db.prepare('DELETE FROM users WHERE email != ?').run('admin@localhost');
  db.prepare('DELETE FROM provider_accounts').run();
}

function seedUserAndToken(raw = 'nbmg_fish_token') {
  const db = getDb();
  const userId = Number(db.prepare("INSERT INTO users (email,role,is_admin,enabled) VALUES (?, 'developer', 0, 1)").run(`fish-${Math.random().toString(36).slice(2)}@example.com`).lastInsertRowid);
  db.prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(userId, 'fish', 'allow_all');
  const tokenId = Number(db.prepare('INSERT INTO api_tokens (user_id,label,token_hash,token_prefix,enabled) VALUES (?,?,?,?,1)').run(userId, 'fish-token', sha256(raw), raw.slice(0, 14)).lastInsertRowid);
  return { raw, userId, tokenId };
}

async function buildApp() { const app = Fastify({ logger: false }); registerFishProxy(app); await app.ready(); return app; }

migrate();

test('migration/admin model list includes fish provider', () => {
  const sql = (getDb().prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='provider_accounts'").get() as any).sql;
  assert.match(sql, /'fish'/);
});

test('Fish TTS forwards s2.1-pro-free with Calm Male Narrator default', async () => {
  resetTables();
  const token = seedUserAndToken();
  const accountId = Number(getDb().prepare("INSERT INTO provider_accounts (provider,label,secret,status,enabled) VALUES ('fish','fish-free','fish-key','active',1)").run().lastInsertRowid);
  const audio = Buffer.from('fake-mp3');
  let seenUrl = '';
  let seenHeaders: any;
  let seenBody: any;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: string, init: any) => {
    seenUrl = String(url);
    seenHeaders = init.headers;
    seenBody = JSON.parse(String(init.body));
    return new Response(audio, { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  };
  const app = await buildApp();
  const res = await app.inject({ method: 'POST', url: '/v1/fish/tts', headers: { authorization: `Bearer ${token.raw}` }, payload: { input: 'Hello Don' } });
  await app.close();
  globalThis.fetch = oldFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(seenUrl, 'https://fish.test/v1/tts');
  assert.equal(seenHeaders.model, 's2.1-pro-free');
  assert.equal(seenBody.text, 'Hello Don');
  assert.equal(seenBody.reference_id, '519c87e88c8c47b4a500ab134ed938d5');
  assert.match(res.headers['content-type'] as string, /^audio\/mpeg/);
  const ev = getDb().prepare('SELECT provider,endpoint,model,input_tokens,estimated_cost_usd,provider_account_id FROM usage_events ORDER BY id DESC LIMIT 1').get() as any;
  assert.equal(ev.provider, 'fish');
  assert.equal(ev.endpoint, '/v1/fish/tts');
  assert.equal(ev.model, 's2.1-pro-free');
  assert.equal(ev.input_tokens, 9);
  assert.equal(ev.estimated_cost_usd, 0);
  assert.equal(ev.provider_account_id, accountId);
});

test('Fish TTS enforces account max_in_flight before upstream', async () => {
  resetTables();
  const token = seedUserAndToken('nbmg_fish_concurrency_token');
  getDb().prepare("INSERT INTO provider_accounts (provider,label,secret,status,enabled,max_in_flight) VALUES ('fish','fish-free','fish-key','active',1,1)").run();
  let fetchCalls = 0;
  let releaseFirst!: () => void;
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => {
    fetchCalls += 1;
    await new Promise<void>((resolve) => { releaseFirst = resolve; });
    return new Response(Buffer.from('fake-mp3'), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  };
  const app = await buildApp();
  const first = app.inject({ method: 'POST', url: '/v1/fish/tts', headers: { authorization: `Bearer ${token.raw}` }, payload: { input: 'First request' } });
  await new Promise((resolve) => setImmediate(resolve));
  const second = await app.inject({ method: 'POST', url: '/v1/fish/tts', headers: { authorization: `Bearer ${token.raw}` }, payload: { input: 'Second request' } });
  releaseFirst();
  const firstRes = await first;
  await app.close();
  globalThis.fetch = oldFetch;
  assert.equal(firstRes.statusCode, 200, firstRes.body);
  assert.equal(second.statusCode, 503, second.body);
  assert.match(second.body, /No Fish Audio account available/);
  assert.equal(fetchCalls, 1);
});
