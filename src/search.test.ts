import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';

process.env.DATABASE_PATH = path.join(os.tmpdir(), `nbmg-search-${process.pid}-${Date.now()}.sqlite`);

const { getDb } = await import('./db/index.js');
const { migrate } = await import('./db/migrate.js');
const { sha256 } = await import('./utils/crypto.js');
const { registerSearchProxy } = await import('./proxy/search.js');

migrate();
const db = getDb();
const rawToken = 'sp_search_test_token';
const userId = Number(db.prepare("INSERT INTO users (email,role,is_admin,enabled,full_body_logging) VALUES ('search@example.com','developer',0,1,1)").run().lastInsertRowid);
const tokenId = Number(db.prepare('INSERT INTO api_tokens (user_id,label,token_hash,token_prefix,enabled) VALUES (?,?,?,?,1)').run(userId, 'search-token', sha256(rawToken), rawToken.slice(0, 14)).lastInsertRowid);

type FetchCall = { url: string; body: any; headers: any };

function resetSerper() {
  db.prepare('DELETE FROM request_logs').run();
  db.prepare("DELETE FROM usage_events WHERE provider='serper'").run();
  db.prepare("DELETE FROM provider_accounts WHERE provider='serper'").run();
}

function seedSerper(label = 'serper-test', secret = 'serper-key') {
  return Number(db.prepare("INSERT INTO provider_accounts (provider,label,secret,max_in_flight) VALUES ('serper',?,?,2)").run(label, secret).lastInsertRowid);
}

async function app() {
  const a = Fastify({ logger: false });
  registerSearchProxy(a);
  await a.ready();
  return a;
}

test('migration allows serper provider accounts', () => {
  resetSerper();
  assert.doesNotThrow(() => seedSerper('migration-serper'));
});

test('/v1/search mode=serp calls Serper and returns normalized organic results', async () => {
  resetSerper();
  seedSerper('primary', 'key-primary');
  const calls: FetchCall[] = [];
  const originalFetch = global.fetch;
  global.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)), headers: init.headers });
    return new Response(JSON.stringify({
      searchParameters: { q: 'apple inc', type: 'search', engine: 'google' },
      organic: [
        { title: 'Apple Inc. - Wikipedia', link: 'https://en.wikipedia.org/wiki/Apple_Inc.', displayedLink: 'en.wikipedia.org', snippet: 'Apple Inc. is an American multinational technology company.', position: 1 },
        { title: 'Apple', link: 'https://www.apple.com/', snippet: 'Apple official site.', position: 2 },
      ],
      relatedSearches: [{ query: 'apple stock' }],
      credits: 1,
    }), { status: 200, headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '24', 'x-ratelimit-reset': '1781544270' } });
  }) as any;
  const a = await app();
  try {
    const res = await a.inject({ method: 'POST', url: '/v1/search', headers: { authorization: `Bearer ${rawToken}` }, payload: { query: 'apple inc', mode: 'serp', limit: 2, gl: 'US', hl: 'EN', tbs: 'qdr:d', page: 3 } });
    assert.equal(res.statusCode, 200, res.body);
    const call = calls[0];
    assert.equal(call.url, 'https://google.serper.dev/search');
    assert.deepEqual(call.body, { q: 'apple inc', num: 2, gl: 'us', hl: 'en', tbs: 'qdr:d', page: 3 });
    assert.equal((call.headers as any)['X-API-KEY'], 'key-primary');
    const out = res.json();
    assert.equal(out.mode, 'serp');
    assert.equal(out.provider, 'serper');
    assert.equal(out.cache_status, 'none');
    assert.equal(out.results.length, 2);
    assert.equal(out.results[0].index, 1);
    assert.equal(out.results[0].url, 'https://en.wikipedia.org/wiki/Apple_Inc.');
    assert.equal(out.results[0].display_url, 'en.wikipedia.org');
    assert.equal(out.usage.credits, 1);
    assert.equal(out.usage.rate_limit_remaining, 24);
    const usage = db.prepare("SELECT provider,endpoint,status_code,provider_account_label FROM usage_events WHERE provider='serper' ORDER BY id DESC LIMIT 1").get() as any;
    assert.equal(usage.provider, 'serper');
    assert.equal(usage.endpoint, '/v1/search');
    assert.equal(usage.status_code, 200);
    assert.equal(usage.provider_account_label, 'primary');
    const log = db.prepare('SELECT request_json,response_text FROM request_logs ORDER BY id DESC LIMIT 1').get() as any;
    assert.match(log.request_json, /apple inc/);
    assert.match(log.response_text, /Apple Inc/);
  } finally {
    await a.close();
    global.fetch = originalFetch;
  }
});

test('/v1/search mode=serp returns 503 when no Serper accounts exist', async () => {
  resetSerper();
  const a = await app();
  try {
    const res = await a.inject({ method: 'POST', url: '/v1/search', headers: { authorization: `Bearer ${rawToken}` }, payload: { query: 'x', mode: 'serp' } });
    assert.equal(res.statusCode, 503, res.body);
    assert.match(res.body, /No available Serper accounts/);
  } finally {
    await a.close();
  }
});

test('searxng adapter: GET /v1/searxng/:token/search returns SearXNG shape with snippet remapped to content', async () => {
  resetSerper();
  seedSerper('adapter', 'key-adapter');
  const calls: FetchCall[] = [];
  const originalFetch = global.fetch;
  global.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)), headers: init.headers });
    return new Response(JSON.stringify({
      organic: [
        { title: 'Paris - Wikipedia', link: 'https://en.wikipedia.org/wiki/Paris', snippet: 'Paris is the capital of France.', position: 1 },
        { title: 'Paris official', link: 'https://www.paris.fr/', snippet: 'City of Paris.', position: 2 },
      ],
      credits: 1,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  const a = await app();
  try {
    const res = await a.inject({ method: 'GET', url: `/v1/searxng/${rawToken}/search?q=capital%20of%20france&format=json&language=en` });
    assert.equal(res.statusCode, 200, res.body);
    const out = res.json();
    // SearXNG-shape: top-level results[] with url+title+content (snippet remapped).
    assert.equal(out.query, 'capital of france');
    assert.ok(Array.isArray(out.results));
    assert.equal(out.results.length, 2);
    assert.equal(out.results[0].url, 'https://en.wikipedia.org/wiki/Paris');
    assert.equal(out.results[0].title, 'Paris - Wikipedia');
    assert.equal(out.results[0].content, 'Paris is the capital of France.');
    assert.equal(out.results[0].snippet, undefined);
    // language passthrough -> Serper hl
    assert.equal(calls[0].body.hl, 'en');
    // metered under serper / /v1/searxng
    const usage = db.prepare("SELECT provider,endpoint,status_code FROM usage_events WHERE provider='serper' ORDER BY id DESC LIMIT 1").get() as any;
    assert.equal(usage.endpoint, '/v1/searxng');
    assert.equal(usage.status_code, 200);
  } finally {
    await a.close();
    global.fetch = originalFetch;
  }
});

test('searxng adapter: invalid token -> 401 non-200 text', async () => {
  resetSerper();
  seedSerper('adapter2', 'key-adapter2');
  const a = await app();
  try {
    const res = await a.inject({ method: 'GET', url: '/v1/searxng/wrong-token/search?q=hi&format=json' });
    assert.equal(res.statusCode, 401, res.body);
    assert.notEqual(res.headers['content-type'], 'application/json; charset=utf-8');
  } finally {
    await a.close();
  }
});

test('searxng adapter: missing q -> 400', async () => {
  resetSerper();
  seedSerper('adapter3', 'key-adapter3');
  const a = await app();
  try {
    const res = await a.inject({ method: 'GET', url: `/v1/searxng/${rawToken}/search?format=json` });
    assert.equal(res.statusCode, 400, res.body);
  } finally {
    await a.close();
  }
});
