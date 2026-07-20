import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import Fastify from 'fastify';


const dbPath = path.join(os.tmpdir(), `model-gateway-gemini-${process.pid}-${Date.now()}.sqlite`);
process.env.DATABASE_PATH = dbPath;
process.env.DEV_ADMIN_KEY = 'test-admin';
process.env.GEMINI_UPSTREAM_URL = 'https://gemini.test/v1beta';

const old = new Database(dbPath);
old.exec(`
  CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE provider_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL CHECK(provider IN ('anthropic','openai_codex','openai')),
    label TEXT NOT NULL,
    owner_email TEXT,
    secret TEXT NOT NULL,
    refresh_secret TEXT,
    account_id TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'active',
    max_in_flight INTEGER,
    cooldown_until INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL DEFAULT 0,
    last_used_at INTEGER NOT NULL DEFAULT 0,
    last_refresh_at INTEGER NOT NULL DEFAULT 0,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    risk_notes TEXT,
    quota_notes TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  INSERT INTO provider_accounts (provider,label,secret) VALUES ('anthropic','kept','sk-ant');
`);
old.close();

const { migrate } = await import('./db/migrate.js');
const { getDb } = await import('./db/index.js');
const { createProxyToken } = await import('./utils/crypto.js');
const { registerGeminiProxy, classifyGeminiRateLimit, GEMINI_PER_MINUTE_COOLDOWN_MS } = await import('./proxy/gemini.js');
const { registerSearchProxy } = await import('./proxy/search.js');
const geminiPool = await import('./providers/gemini-pool.js');

test('classifyGeminiRateLimit: PerDay quota => per_day', () => {
  const body = JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', details: [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [
      { quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaMetric: 'generativelanguage.googleapis.com/generate_requests_per_model' } ] } ] } });
  const r = classifyGeminiRateLimit(body);
  assert.equal(r.kind, 'per_day');
});

test('classifyGeminiRateLimit: PerMinute quota => per_minute with retryDelay', () => {
  const body = JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', details: [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [
      { quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' } ] },
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '17s' } ] } });
  const r = classifyGeminiRateLimit(body);
  assert.equal(r.kind, 'per_minute');
  assert.equal(r.retryDelayMs, 17000);
});

test('classifyGeminiRateLimit: TPM (tokens per minute) => per_minute', () => {
  const body = JSON.stringify({ error: { details: [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [
      { quotaId: 'GenerateContentInputTokensPerModelPerMinute-FreeTier' } ] } ] } });
  assert.equal(classifyGeminiRateLimit(body).kind, 'per_minute');
});

test('classifyGeminiRateLimit: ambiguous/truncated body defaults to per_minute (never nukes a key for the day)', () => {
  assert.equal(classifyGeminiRateLimit('You exceeded your current quota').kind, 'per_minute');
  assert.equal(classifyGeminiRateLimit('').kind, 'per_minute');
  assert.equal(classifyGeminiRateLimit(null).kind, 'per_minute');
  assert.equal(classifyGeminiRateLimit(undefined).kind, 'per_minute');
});

test('classifyGeminiRateLimit: both PerDay and PerMinute present => per_minute (conservative, retryable)', () => {
  const body = JSON.stringify({ error: { details: [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [
      { quotaId: 'FooPerDayBar' }, { quotaId: 'FooPerMinuteBar' } ] } ] } });
  assert.equal(classifyGeminiRateLimit(body).kind, 'per_minute');
});

test('classifyGeminiRateLimit: substring fallback detects PerDay in non-JSON body', () => {
  assert.equal(classifyGeminiRateLimit('quota GenerateRequestsPerDay exhausted').kind, 'per_day');
});

test('GEMINI_PER_MINUTE_COOLDOWN_MS is a sane short default', () => {
  assert.ok(GEMINI_PER_MINUTE_COOLDOWN_MS > 0 && GEMINI_PER_MINUTE_COOLDOWN_MS <= 120_000);
});

migrate();
const db = getDb();
const tok = createProxyToken();
const devUserId = Number(db.prepare("INSERT INTO users (email,role,is_admin,enabled) VALUES ('dev@example.com','developer',0,1)").run().lastInsertRowid);
db.prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(devUserId, 'gemini', 'allow_all');
db.prepare('INSERT INTO api_tokens (user_id,label,token_hash,token_prefix) VALUES (?,?,?,?)').run(devUserId, 'dev-token', tok.hash, tok.prefix);

function resetGemini() {
  db.prepare('DELETE FROM request_logs').run();
  db.prepare("DELETE FROM usage_events WHERE provider='gemini'").run();
  db.prepare('DELETE FROM provider_health_events').run();
  db.prepare('DELETE FROM gemini_key_usage').run();
  db.prepare("DELETE FROM provider_accounts WHERE provider='gemini'").run();
}

function seedGemini(label: string, secret = `key-${label}`) {
  return Number(db.prepare("INSERT INTO provider_accounts (provider,label,secret,max_in_flight) VALUES ('gemini',?,?,2)").run(label, secret).lastInsertRowid);
}

async function geminiApp() {
  const app = Fastify({ logger: false });
  registerGeminiProxy(app);
  return app;
}

async function geminiSearchApp() {
  const app = Fastify({ logger: false });
  registerGeminiProxy(app);
  registerSearchProxy(app);
  return app;
}

test('migration 2026060303 adds gemini provider and gemini_key_usage table', () => {
  const kept = db.prepare("SELECT provider,label FROM provider_accounts WHERE label='kept'").get() as any;
  assert.equal(kept.provider, 'anthropic');
  assert.doesNotThrow(() => db.prepare("INSERT INTO provider_accounts (provider,label,secret) VALUES ('gemini','migration-gemini','AIza-test')").run());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='gemini_key_usage'").get());
  assert.ok(db.prepare('SELECT version FROM schema_migrations WHERE version=?').get(2026060303));
});

test('rotation picks the lowest-usage Gemini key for a model family', () => {
  resetGemini();
  const a = seedGemini('a');
  const b = seedGemini('b');
  const c = seedGemini('c');
  const day = geminiPool.geminiPacificDay();
  db.prepare('INSERT INTO gemini_key_usage (account_id,model_family,day_pacific,count) VALUES (?,?,?,?)').run(a, 'tts', day, 5);
  db.prepare('INSERT INTO gemini_key_usage (account_id,model_family,day_pacific,count) VALUES (?,?,?,?)').run(b, 'tts', day, 1);
  db.prepare('INSERT INTO gemini_key_usage (account_id,model_family,day_pacific,count) VALUES (?,?,?,?)').run(c, 'tts', day, 3);
  assert.equal(geminiPool.selectGeminiAccount('tts')?.id, b);
});

test('Gemini proactive skip ignores keys at >=95% of daily family cap', () => {
  resetGemini();
  const nearlyDone = seedGemini('nearly-done');
  const fresh = seedGemini('fresh');
  const day = geminiPool.geminiPacificDay();
  db.prepare('INSERT INTO gemini_key_usage (account_id,model_family,day_pacific,count) VALUES (?,?,?,?)').run(nearlyDone, 'tts', day, 9);
  assert.equal(geminiPool.selectGeminiAccount('tts')?.id, fresh);
  db.prepare('INSERT INTO gemini_key_usage (account_id,model_family,day_pacific,count) VALUES (?,?,?,?)').run(fresh, 'tts', day, 9);
  assert.equal(geminiPool.selectGeminiAccount('tts'), null);
});

test('Gemini PER-DAY 429 marks key-family exhausted and fails over to next key', async () => {
  resetGemini();
  const first = seedGemini('first', 'key-first');
  const second = seedGemini('second', 'key-second');
  const calls: string[] = [];
  const perDayBody = JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', details: [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [
      { quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' } ] } ] } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push(String(url));
    const body = JSON.parse(String(init.body));
    assert.equal(body.contents[0].parts[0].text, 'hi');
    if (calls.length === 1) return new Response(perDayBody, { status: 429, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hello' }], role: 'model' }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  const app = await geminiApp();
  const res = await app.inject({ method: 'POST', url: '/v1/gemini/chat/completions', headers: { authorization: `Bearer ${tok.raw}` }, payload: { model: 'gemini-3.1-flash-lite', messages: [{ role: 'user', content: 'hi' }] } });
  globalThis.fetch = originalFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().choices[0].message.content, 'hello');
  assert.equal(calls.length, 2);
  assert.match(calls[0], /key=key-first/);
  assert.match(calls[1], /key=key-second/);
  // Per-day 429 => family exhausted (count forced to daily cap).
  assert.equal(geminiPool.getGeminiUsageCount(first, 'chat'), geminiPool.GEMINI_DAILY_CAPS.chat);
  assert.equal(geminiPool.getGeminiUsageCount(second, 'chat'), 1);
  await app.close();
});

test('Gemini PER-MINUTE 429 fails over but does NOT mark key-family exhausted (key stays usable today)', async () => {
  resetGemini();
  const first = seedGemini('first', 'key-first');
  const second = seedGemini('second', 'key-second');
  const calls: string[] = [];
  // Generic/truncated quota body (no PerDay) => treated as transient per-minute.
  const perMinBody = '{"error":"quota"}';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push(String(url));
    if (calls.length === 1) return new Response(perMinBody, { status: 429, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hello' }], role: 'model' }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  const app = await geminiApp();
  const res = await app.inject({ method: 'POST', url: '/v1/gemini/chat/completions', headers: { authorization: `Bearer ${tok.raw}` }, payload: { model: 'gemini-3.1-flash-lite', messages: [{ role: 'user', content: 'hi' }] } });
  globalThis.fetch = originalFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(calls.length, 2, 'should fail over to the second key');
  // Per-minute 429 => NOT family-exhausted; the attempt counter is just the recorded attempt, not the daily cap.
  assert.notEqual(geminiPool.getGeminiUsageCount(first, 'chat'), geminiPool.GEMINI_DAILY_CAPS.chat);
  await app.close();
});

test('all Gemini keys exhausted returns clean 429 with retry-after', async () => {
  resetGemini();
  const a = seedGemini('a');
  const b = seedGemini('b');
  const day = geminiPool.geminiPacificDay();
  db.prepare('INSERT INTO gemini_key_usage (account_id,model_family,day_pacific,count) VALUES (?,?,?,?)').run(a, 'chat', day, geminiPool.GEMINI_DAILY_CAPS.chat);
  db.prepare('INSERT INTO gemini_key_usage (account_id,model_family,day_pacific,count) VALUES (?,?,?,?)').run(b, 'chat', day, geminiPool.GEMINI_DAILY_CAPS.chat);
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { calls += 1; throw new Error('should not call upstream'); }) as any;
  const app = await geminiApp();
  const res = await app.inject({ method: 'POST', url: '/v1/gemini/chat/completions', headers: { authorization: `Bearer ${tok.raw}` }, payload: { model: 'gemini-3.1-flash-lite', messages: [{ role: 'user', content: 'hi' }] } });
  globalThis.fetch = originalFetch;
  assert.equal(res.statusCode, 429, res.body);
  assert.equal(calls, 0);
  assert.ok(Number(res.headers['retry-after']) > 0);
  assert.match(res.json().error.message, /Pacific midnight/);
  await app.close();
});

test('Gemini embeddings maps OpenAI input to batchEmbedContents and OpenAI response shape', async () => {
  resetGemini();
  seedGemini('embed', 'key-embed');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    assert.match(String(url), /gemini-embedding-001:batchEmbedContents\?key=key-embed/);
    const body = JSON.parse(String(init.body));
    assert.deepEqual(body.requests.map((r: any) => r.content.parts[0].text), ['one', 'two']);
    return new Response(JSON.stringify({ embeddings: [{ values: [0.1, 0.2] }, { values: [0.3, 0.4] }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  const app = await geminiApp();
  const res = await app.inject({ method: 'POST', url: '/v1/gemini/embeddings', headers: { authorization: `Bearer ${tok.raw}` }, payload: { input: ['one', 'two'] } });
  globalThis.fetch = originalFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json().data.map((d: any) => d.embedding), [[0.1, 0.2], [0.3, 0.4]]);
  assert.equal(res.json().usage.prompt_tokens, 2);
  await app.close();
});

test('Gemini chat translates OpenAI messages to Gemini contents and maps response usage', async () => {
  resetGemini();
  seedGemini('chat', 'key-chat');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(String(init.body));
    assert.equal(body.systemInstruction.parts[0].text, 'be terse');
    assert.deepEqual(body.contents.map((c: any) => [c.role, c.parts[0].text]), [['user', 'hi'], ['model', 'hello before']]);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'done' }], role: 'model' }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 6, totalTokenCount: 11 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  const app = await geminiApp();
  const res = await app.inject({ method: 'POST', url: '/v1/gemini/chat/completions', headers: { authorization: `Bearer ${tok.raw}` }, payload: { model: 'gemini-3.1-flash-lite', messages: [{ role: 'system', content: 'be terse' }, { role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello before' }] } });
  globalThis.fetch = originalFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().choices[0].message.content, 'done');
  assert.deepEqual(res.json().usage, { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 });
  const ev = db.prepare("SELECT input_tokens,output_tokens,estimated_cost_usd FROM usage_events WHERE provider='gemini' ORDER BY id DESC LIMIT 1").get() as any;
  assert.equal(ev.input_tokens, 5);
  assert.equal(ev.output_tokens, 6);
  assert.equal(ev.estimated_cost_usd, 0);
  await app.close();
});

test('Gemini cache + thoughts tokens are split into cache_read/reasoning and input is uncached-only', async () => {
  resetGemini();
  seedGemini('cachetest', 'key-cache');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: 'cached answer' }], role: 'model' }, finishReason: 'STOP' }],
    // promptTokenCount INCLUDES cached tokens (Gemini semantics): 1000 total, 800 cached.
    usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 50, cachedContentTokenCount: 800, thoughtsTokenCount: 30, totalTokenCount: 1080 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as any;
  const app = await geminiApp();
  const res = await app.inject({ method: 'POST', url: '/v1/gemini/chat/completions', headers: { authorization: `Bearer ${tok.raw}` }, payload: { model: 'gemini-3.1-flash-lite', messages: [{ role: 'user', content: 'hi' }] } });
  globalThis.fetch = originalFetch;
  assert.equal(res.statusCode, 200, res.body);
  const ev = db.prepare("SELECT input_tokens,output_tokens,cache_read_tokens,reasoning_tokens,billing_mode,ttft_ms FROM usage_events WHERE provider='gemini' ORDER BY id DESC LIMIT 1").get() as any;
  assert.equal(ev.input_tokens, 200); // 1000 - 800 cached
  assert.equal(ev.cache_read_tokens, 800);
  assert.equal(ev.output_tokens, 50);
  assert.equal(ev.reasoning_tokens, 30);
  assert.equal(ev.billing_mode, 'metered');
  assert.ok(ev.ttft_ms == null || ev.ttft_ms >= 0);
  await app.close();
});

test('Gemini TTS maps JSON to generateContent AUDIO and wraps PCM as WAV', async () => {
  resetGemini();
  seedGemini('tts', 'key-tts');
  const pcm = Buffer.from([1, 2, 3, 4]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(String(init.body));
    assert.equal(body.contents[0].parts[0].text, 'say hi');
    assert.deepEqual(body.generationConfig.responseModalities, ['AUDIO']);
    assert.equal(body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore');
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/pcm', data: pcm.toString('base64') } }] } }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 0, totalTokenCount: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  const app = await geminiApp();
  const res = await app.inject({ method: 'POST', url: '/v1/gemini/tts', headers: { authorization: `Bearer ${tok.raw}` }, payload: { input: 'say hi' } });
  globalThis.fetch = originalFetch;
  assert.equal(res.statusCode, 200, res.body);
  const out = res.rawPayload as Buffer;
  assert.equal(out.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(out.subarray(8, 12).toString('ascii'), 'WAVE');
  assert.equal(out.readUInt32LE(24), 24000);
  assert.deepEqual([...out.subarray(44)], [1, 2, 3, 4]);
  await app.close();
});

test('Gemini unknown model is rejected with 400 before upstream fetch', async () => {
  resetGemini();
  seedGemini('unknown');
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { calls += 1; throw new Error('should not call upstream'); }) as any;
  const app = await geminiApp();
  const res = await app.inject({ method: 'POST', url: '/v1/gemini/chat/completions', headers: { authorization: `Bearer ${tok.raw}` }, payload: { model: 'made-up-gemini', messages: [{ role: 'user', content: 'hi' }] } });
  globalThis.fetch = originalFetch;
  assert.equal(res.statusCode, 400);
  assert.equal(calls, 0);
  assert.match(res.json().error.message, /Unknown Gemini chat model/);
  await app.close();
});

test('Gemini Live model id is rejected on the non-Live chat path (400, no upstream)', async () => {
  resetGemini();
  seedGemini('live-on-chat');
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { calls += 1; throw new Error('should not call upstream'); }) as any;
  const app = await geminiApp();
  // Live ids are globally known now, but must NOT be servable over chat/completions.
  const res = await app.inject({ method: 'POST', url: '/v1/gemini/chat/completions', headers: { authorization: `Bearer ${tok.raw}` }, payload: { model: 'gemini-3.1-flash-live-preview', messages: [{ role: 'user', content: 'hi' }] } });
  globalThis.fetch = originalFetch;
  assert.equal(res.statusCode, 400);
  assert.equal(calls, 0);
  await app.close();
});

test('gemini_key_usage accepts the live model family (migration)', () => {
  resetGemini();
  const a = seedGemini('live-usage');
  const day = geminiPool.geminiPacificDay();
  assert.doesNotThrow(() => db.prepare('INSERT INTO gemini_key_usage (account_id,model_family,day_pacific,count) VALUES (?,?,?,?)').run(a, 'live', day, 1));
  const row = db.prepare('SELECT count FROM gemini_key_usage WHERE account_id=? AND model_family=? AND day_pacific=?').get(a, 'live', day) as any;
  assert.equal(row.count, 1);
});

test('gemini-embedding-2-preview is allowed and maps to embeddings family', () => {
  assert.equal(geminiPool.KNOWN_GEMINI_EMBEDDING_MODELS.has('gemini-embedding-2-preview'), true);
  assert.equal(geminiPool.geminiModelFamily('gemini-embedding-2-preview'), 'embeddings');
});

test('Gemini video models are known and map to chat-video family with 20 RPD cap', () => {
  assert.equal(geminiPool.KNOWN_GEMINI_VIDEO_MODELS.has('gemini-2.5-flash'), true);
  assert.equal(geminiPool.KNOWN_GEMINI_VIDEO_MODELS.has('gemini-3.5-flash'), true);
  assert.equal(geminiPool.geminiModelFamily('gemini-2.5-flash'), 'chat-video');
  assert.equal(geminiPool.geminiModelFamily('gemini-3.5-flash'), 'chat-video');
  assert.equal(geminiPool.GEMINI_DAILY_CAPS['chat-video'], 20);
  // text-only chat models stay on the high-volume 'chat' family
  assert.equal(geminiPool.geminiModelFamily('gemini-3.1-flash-lite'), 'chat');
});

test('Gemini chat maps web_search tool to Google Search grounding and returns sources', async () => {
  resetGemini();
  seedGemini('grounded', 'key-grounded');
  const originalFetch = globalThis.fetch;
  let sawTools: any = null;
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(String(init.body));
    sawTools = body.tools;
    return new Response(JSON.stringify({
      candidates: [{
        content: { parts: [{ text: 'Today: important world news.' }], role: 'model' },
        finishReason: 'STOP',
        groundingMetadata: {
          groundingChunks: [
            { web: { title: 'Example News', uri: 'https://example.com/world' } },
            { web: { title: 'Second Source', uri: 'https://example.com/second' } },
          ],
          groundingSupports: [{ groundingChunkIndices: [0], segment: { text: 'Today: important world news.' } }],
        },
      }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 20, toolUsePromptTokenCount: 5 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  const app = await geminiApp();
  const res = await app.inject({ method: 'POST', url: '/v1/gemini/chat/completions', headers: { authorization: `Bearer ${tok.raw}` }, payload: {
    model: 'gemini-2.5-flash-lite',
    messages: [{ role: 'user', content: 'what is happening today?' }],
    tools: [{ type: 'web_search' }],
  } });
  globalThis.fetch = originalFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(sawTools, [{ google_search: {} }]);
  const out = res.json();
  assert.match(out.choices[0].message.content, /Sources:/);
  assert.match(out.choices[0].message.content, /https:\/\/example\.com\/world/);
  assert.deepEqual(out.choices[0].message.annotations[0], { type: 'url_citation', url: 'https://example.com/world', title: 'Example News' });
  assert.equal(out.usage.tool_use_prompt_tokens, 5);
  assert.equal(out.grounding_metadata.groundingChunks.length, 2);
  await app.close();
});

test('/v1/search defaults to Gemini model-backed search and returns indexed results', async () => {
  resetGemini();
  seedGemini('search', 'key-search');
  const originalFetch = globalThis.fetch;
  let sawTools: any = null;
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(String(init.body));
    sawTools = body.tools;
    return new Response(JSON.stringify({
      candidates: [{
        content: { parts: [{ text: 'Answer with sources.' }], role: 'model' },
        finishReason: 'STOP',
        groundingMetadata: { groundingChunks: [{ web: { title: 'Example', uri: 'https://example.com/a' } }] },
      }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, totalTokenCount: 14, toolUsePromptTokenCount: 3 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  const app = await geminiSearchApp();
  const res = await app.inject({ method: 'POST', url: '/v1/search', headers: { authorization: `Bearer ${tok.raw}` }, payload: { query: 'latest world news', limit: 5 } });
  globalThis.fetch = originalFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(sawTools, [{ google_search: {} }]);
  const out = res.json();
  assert.equal(out.mode, 'models');
  assert.equal(out.provider, 'gemini');
  assert.equal(out.model, 'gemini-2.5-flash-lite');
  assert.equal(out.results[0].index, 1);
  assert.equal(out.results[0].url, 'https://example.com/a');
  assert.match(out.answer, /Answer with sources/);
  await app.close();
});

test('Gemini chat forwards inline video (data URI) as inline_data to upstream and bills under chat-video', async () => {
  resetGemini();
  seedGemini('chat-video', 'key-cv');
  const originalFetch = globalThis.fetch;
  let sawInline: any = null;
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(String(init.body));
    const userMsg = body.contents.find((c: any) => c.role === 'user');
    sawInline = userMsg.parts.find((p: any) => p.inline_data);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'a gala scene' }], role: 'model' }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 8000, candidatesTokenCount: 20, totalTokenCount: 8020 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  const app = await geminiApp();
  const res = await app.inject({ method: 'POST', url: '/v1/gemini/chat/completions', headers: { authorization: `Bearer ${tok.raw}` }, payload: {
    model: 'gemini-2.5-flash',
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'describe this video' },
      { type: 'video_url', video_url: { url: 'data:video/mp4;base64,AAAA' } },
    ] }],
  } });
  globalThis.fetch = originalFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().choices[0].message.content, 'a gala scene');
  assert.ok(sawInline, 'inline_data video part should be forwarded to Gemini');
  assert.equal(sawInline.inline_data.mime_type, 'video/mp4');
  assert.equal(sawInline.inline_data.data, 'AAAA');
  const ev = db.prepare("SELECT model FROM usage_events WHERE provider='gemini' ORDER BY id DESC LIMIT 1").get() as any;
  assert.equal(ev.model, 'gemini-2.5-flash');
  // usage tracked under chat-video family for the 20 RPD cap
  const fam = db.prepare("SELECT model_family FROM gemini_key_usage ORDER BY rowid DESC LIMIT 1").get() as any;
  assert.equal(fam.model_family, 'chat-video');
  await app.close();
});

test('Gemini chat forwards http(s) media URL as file_data (e.g. YouTube)', async () => {
  resetGemini();
  seedGemini('chat-video2', 'key-cv2');
  const originalFetch = globalThis.fetch;
  let sawFile: any = null;
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(String(init.body));
    const userMsg = body.contents.find((c: any) => c.role === 'user');
    sawFile = userMsg.parts.find((p: any) => p.file_data);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }], role: 'model' }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  const app = await geminiApp();
  const res = await app.inject({ method: 'POST', url: '/v1/gemini/chat/completions', headers: { authorization: `Bearer ${tok.raw}` }, payload: {
    model: 'gemini-3.5-flash',
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'summarize' },
      { type: 'video_url', video_url: { url: 'https://www.youtube.com/watch?v=abc' } },
    ] }],
  } });
  globalThis.fetch = originalFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.ok(sawFile, 'http(s) media should map to file_data');
  assert.equal(sawFile.file_data.file_uri, 'https://www.youtube.com/watch?v=abc');
  await app.close();
});

test('Gemini chat: file_data URL no longer carries a wildcard mime_type', async () => {
  resetGemini();
  seedGemini('nomime', 'key-nomime');
  const originalFetch = globalThis.fetch;
  let sawFile: any = null;
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(String(init.body));
    sawFile = body.contents.find((c: any) => c.role === 'user').parts.find((p: any) => p.file_data);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }], role: 'model' }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  const app = await geminiApp();
  const res = await app.inject({ method: 'POST', url: '/v1/gemini/chat/completions', headers: { authorization: `Bearer ${tok.raw}` }, payload: {
    model: 'gemini-3.5-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }, { type: 'video_url', video_url: { url: 'https://example.com/v.mp4' } }] }],
  } });
  globalThis.fetch = originalFetch;
  assert.equal(res.statusCode, 200, res.body);
  assert.ok(sawFile, 'should map to file_data');
  assert.equal(sawFile.file_data.mime_type, undefined, 'must NOT send a wildcard mime_type');
  await app.close();
});

test('Gemini File API: upload returns a tagged file_uri and pins chat to the uploading key', async () => {
  resetGemini();
  // Two keys: prove the chat pins to the UPLOADER, not free rotation.
  const a = seedGemini('fileA', 'key-fileA');
  seedGemini('fileB', 'key-fileB');
  const originalFetch = globalThis.fetch;
  let chatKeyUsed: string | null = null;
  let sawCleanUri: string | null = null;
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    if (u.includes('/upload/v1beta/files') && init?.headers?.['X-Goog-Upload-Command'] === 'start') {
      return new Response('{}', { status: 200, headers: { 'x-goog-upload-url': 'https://up.example/session?key=key-fileA&upload_id=z' } });
    }
    if (u.startsWith('https://up.example/session')) {
      return new Response(JSON.stringify({ file: { name: 'files/vid123', uri: 'https://generativelanguage.googleapis.com/v1beta/files/vid123', mimeType: 'video/mp4', sizeBytes: 5, state: 'ACTIVE' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes(':generateContent')) {
      chatKeyUsed = new URL(u).searchParams.get('key');
      const body = JSON.parse(String(init.body));
      sawCleanUri = body.contents[0].parts.find((p: any) => p.file_data)?.file_data?.file_uri;
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'a gala' }], role: 'model' }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 3 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200 });
  }) as any;
  const app = await geminiApp();
  // upload
  const up = await app.inject({ method: 'POST', url: '/v1/gemini/files', headers: { authorization: `Bearer ${tok.raw}`, 'content-type': 'video/mp4' }, payload: Buffer.from('hello') });
  assert.equal(up.statusCode, 200, up.body);
  const taggedUri = up.json().file_uri as string;
  assert.match(taggedUri, /nbmg_acct=\d+/, 'returned file_uri must carry the account hint');
  // chat referencing the tagged uri
  const ch = await app.inject({ method: 'POST', url: '/v1/gemini/chat/completions', headers: { authorization: `Bearer ${tok.raw}` }, payload: {
    model: 'gemini-3.5-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'who?' }, { type: 'video_url', video_url: { url: taggedUri } }] }],
  } });
  globalThis.fetch = originalFetch;
  assert.equal(ch.statusCode, 200, ch.body);
  assert.equal(chatKeyUsed, 'key-fileA', 'chat must run on the uploading key (fileA), not rotate to fileB');
  assert.equal(sawCleanUri, 'https://generativelanguage.googleapis.com/v1beta/files/vid123', 'account hint must be stripped before forwarding upstream');
  // usage events recorded for both the upload and the chat
  const upEv = db.prepare("SELECT model FROM usage_events WHERE endpoint='/v1/gemini/files' ORDER BY id DESC LIMIT 1").get() as any;
  assert.equal(upEv.model, 'file-upload');
  await app.close();
});

test('Gemini File API: referencing a file whose key is gone returns a clear 400', async () => {
  resetGemini();
  seedGemini('present', 'key-present');
  const app = await geminiApp();
  // tagged uri points at account id 999999 which does not exist
  const res = await app.inject({ method: 'POST', url: '/v1/gemini/chat/completions', headers: { authorization: `Bearer ${tok.raw}` }, payload: {
    model: 'gemini-3.5-flash',
    messages: [{ role: 'user', content: [{ type: 'video_url', video_url: { url: 'https://generativelanguage.googleapis.com/v1beta/files/x?nbmg_acct=999999' } }] }],
  } });
  assert.equal(res.statusCode, 400, res.body);
  assert.match(res.json().error.message, /no longer available|re-upload/i);
  await app.close();
});

test('gemini + deepgram proxies register together without a content-type-parser collision', async () => {
  // Regression: gemini must not claim application/octet-stream (deepgram owns it
  // app-wide and is registered AFTER gemini in server.ts). Registering in that
  // exact order must NOT throw FST_ERR_CTP_ALREADY_PRESENT.
  const { registerDeepgramProxy } = await import('./proxy/deepgram.js');
  const Fastify = (await import('fastify')).default;
  const app = Fastify({ logger: false });
  registerGeminiProxy(app);    // gemini first (matches server.ts)
  registerDeepgramProxy(app);  // deepgram after — must not collide
  await assert.doesNotReject(() => Promise.resolve(app.ready()));
  await app.close();
});
