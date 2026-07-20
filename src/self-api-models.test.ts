import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';

const dbPath = path.join(os.tmpdir(), `super-proxy-model-catalog-${process.pid}-${Date.now()}.sqlite`);
process.env.DATABASE_PATH = dbPath;
process.env.SESSION_SECRET = 'model-catalog-test-session-secret';

const { migrate } = await import('./db/migrate.js');
const { getDb } = await import('./db/index.js');
const { createProxyToken } = await import('./utils/crypto.js');
const { registerSelfApi } = await import('./self-api.js');
const { MODEL_CATALOG } = await import('./providers/model-catalog.js');
const { authorizeEffectiveModelForUser } = await import('./proxy/policy.js');
const { validateProviderModel } = await import('./fusion/presets.js');

migrate();
const db = getDb();

function seedUser(email: string, role: 'admin' | 'member', isAdmin = false) {
  const user = db.prepare('INSERT INTO users (email, name, role, is_admin) VALUES (?, ?, ?, ?)')
    .run(email, email.split('@')[0], role, isAdmin ? 1 : 0);
  const userId = Number(user.lastInsertRowid);
  const token = createProxyToken();
  db.prepare('INSERT INTO api_tokens (user_id, label, token_hash, token_prefix) VALUES (?, ?, ?, ?)')
    .run(userId, 'model-catalog-test', token.hash, token.prefix);
  return { id: userId, email, role, isAdmin, token: token.raw };
}

const admin = seedUser('catalog-admin@example.test', 'admin', true);
const restricted = seedUser('catalog-member@example.test', 'member');
const fusionLimited = seedUser('catalog-fusion-limited@example.test', 'member');

db.prepare(`
  INSERT INTO fusion_presets
    (user_id, name, panel_models_json, synthesizer_model, panel_max_tokens, synthesizer_max_tokens, panel_timeout_ms)
  VALUES (?, 'my-preset', ?, 'openai_codex/gpt-5.4', 4096, 8192, 120000)
`).run(admin.id, JSON.stringify(['openai_codex/gpt-5.4']));

db.prepare(`
  INSERT INTO fusion_presets
    (user_id, name, panel_models_json, synthesizer_model, panel_max_tokens, synthesizer_max_tokens, panel_timeout_ms)
  VALUES (?, 'corrupt-object-panel', ?, 'openai_codex/gpt-5.4', 4096, 8192, 120000)
`).run(admin.id, JSON.stringify({ legacy: 'openai_codex/gpt-5.4' }));

function insertPreset(userId: number, name: string, panel: string[], synthesizer: string) {
  db.prepare(`
    INSERT INTO fusion_presets
      (user_id, name, panel_models_json, synthesizer_model, panel_max_tokens, synthesizer_max_tokens, panel_timeout_ms)
    VALUES (?, ?, ?, ?, 4096, 8192, 120000)
  `).run(userId, name, JSON.stringify(panel), synthesizer);
}

db.prepare("INSERT INTO user_provider_access_modes (user_id, provider, mode) VALUES (?, 'fusion', 'allow_all')").run(fusionLimited.id);
insertPreset(fusionLimited.id, 'allowed-preset', ['openai_codex/gpt-5.4'], 'openai_codex/gpt-5.4');
insertPreset(fusionLimited.id, 'unknown-model', ['gemini/not-a-real-model'], 'openai_codex/gpt-5.4');
insertPreset(fusionLimited.id, 'unroutable-provider', ['glm/glm-5.2'], 'openai_codex/gpt-5.4');
insertPreset(fusionLimited.id, 'denied-panel', ['groq/openai/gpt-oss-120b'], 'openai_codex/gpt-5.4');
insertPreset(fusionLimited.id, 'denied-alias', ['openai_codex/gpt-5.4'], 'openai_codex/gpt-5.4');
db.prepare("INSERT INTO user_model_denies (user_id, provider, model) VALUES (?, 'fusion', 'denied-alias')").run(fusionLimited.id);

// Give the restricted user one additional provider while retaining default
// access to openai_codex and the public OpenRouter model. Explicit denials must
// still be reflected in discovery exactly as they are at request time.
db.prepare("INSERT INTO user_provider_access_modes (user_id, provider, mode) VALUES (?, 'gemini', 'allow_all')").run(restricted.id);
db.prepare("INSERT INTO user_model_denies (user_id, provider, model) VALUES (?, 'openai_codex', 'gpt-5.5')").run(restricted.id);
db.prepare("INSERT INTO user_model_denies (user_id, provider, model) VALUES (?, 'gemini', 'gemini-embedding-001')").run(restricted.id);

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  registerSelfApi(app);
  await app.ready();
  return app;
}

function bearer(token: string) {
  return { authorization: 'Bearer ' + token };
}

function dashboardCookie(email: string) {
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', process.env.SESSION_SECRET!).update(`${email}:${ts}`).digest('hex').slice(0, 48);
  return { cookie: `sp_session=${email}:${ts}:${sig}` };
}

test('GET /v1/models requires proxy-token authentication', async () => {
  const app = await buildApp();
  const response = await app.inject({ method: 'GET', url: '/v1/models' });
  assert.equal(response.statusCode, 401);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.equal(response.json().error.type, 'authentication_error');
  await app.close();
});

test('admin sees every canonical provider model and Fusion presets without duplicate Fusion aliases', async () => {
  const app = await buildApp();
  const response = await app.inject({ method: 'GET', url: '/v1/models', headers: bearer(admin.token) });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers['cache-control'], 'private, no-store');

  const body = response.json();
  assert.equal(body.object, 'list');
  const canonical = body.data.filter((model: any) => model.catalog_id);
  const expected = MODEL_CATALOG.filter((model) => model.provider !== 'fusion');
  assert.equal(canonical.length, expected.length);
  assert.deepEqual(
    new Set(canonical.map((model: any) => model.catalog_id)),
    new Set(expected.map((model) => `${model.provider}/${model.id}`)),
  );

  const fusionIds = body.data.filter((model: any) => model.owned_by === 'super-proxy-fusion').map((model: any) => model.id);
  assert.deepEqual(fusionIds, ['fusion/max', 'fusion/quality', 'fusion/budget', 'fusion/my-preset'], 'must not leak other users\' presets');
  assert.equal(new Set(body.data.map((model: any) => model.catalog_id).filter(Boolean)).size, canonical.length);
  await app.close();
});

test('GET /v1/models omits a legacy preset with object-valued panel JSON without throwing', async () => {
  const app = await buildApp();
  const response = await app.inject({ method: 'GET', url: '/v1/models', headers: bearer(admin.token) });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  const fusionIds = response.json().data
    .filter((model: any) => model.owned_by === 'super-proxy-fusion')
    .map((model: any) => model.id);
  assert.ok(!fusionIds.includes('fusion/corrupt-object-panel'));
  await app.close();
});

test('restricted user sees exactly policy-allowed canonical models', async () => {
  const app = await buildApp();
  const response = await app.inject({ method: 'GET', url: '/v1/models', headers: bearer(restricted.token) });
  assert.equal(response.statusCode, 200, response.body);

  const body = response.json();
  const canonicalIds = body.data.filter((model: any) => model.catalog_id).map((model: any) => model.catalog_id).sort();
  const expectedIds = MODEL_CATALOG
    .filter((model) => model.provider !== 'fusion')
    .filter((model) => authorizeEffectiveModelForUser(restricted, model.provider, model.id).ok)
    .map((model) => `${model.provider}/${model.id}`)
    .sort();
  assert.deepEqual(canonicalIds, expectedIds);
  assert.ok(canonicalIds.includes('openai_codex/gpt-5.4'));
  assert.ok(canonicalIds.includes('openrouter/tencent/hy3:free'));
  assert.ok(canonicalIds.includes('gemini/gemini-3.5-flash'));
  assert.ok(!canonicalIds.includes('openai_codex/gpt-5.5'));
  assert.ok(!canonicalIds.includes('gemini/gemini-embedding-001'));
  assert.ok(!canonicalIds.some((id: string) => id.startsWith('anthropic/')));
  assert.deepEqual(body.data.filter((model: any) => model.owned_by === 'super-proxy-fusion'), [], 'Fusion deny_all must remove built-ins and saved presets');
  await app.close();
});

test('Fusion listings require alias authorization plus exact route and panel/synthesizer policy viability', async () => {
  const app = await buildApp();
  const response = await app.inject({ method: 'GET', url: '/v1/models', headers: bearer(fusionLimited.token) });
  assert.equal(response.statusCode, 200, response.body);
  const fusion = response.json().data.filter((model: any) => model.owned_by === 'super-proxy-fusion');
  assert.deepEqual(fusion.map((model: any) => model.id), ['fusion/allowed-preset']);
  assert.ok(Array.isArray(fusion[0].interfaces));
  assert.equal(fusion[0].interfaces[0].path, '/v1/fusion/chat/completions');
  await app.close();
});

test('Fusion available-model picker uses exact routable catalog entries and user policy', async () => {
  const app = await buildApp();
  const unauthorized = await app.inject({ method: 'GET', url: '/api/me/fusion-available-models' });
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(unauthorized.headers['cache-control'], 'private, no-store');
  const response = await app.inject({
    method: 'GET',
    url: '/api/me/fusion-available-models',
    headers: dashboardCookie(admin.email),
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  const ids = response.json().models.map((model: any) => model.id);
  const expected = MODEL_CATALOG
    .filter((model) => validateProviderModel(`${model.provider}/${model.id}`).ok)
    .map((model) => `${model.provider}/${model.id}`);
  assert.deepEqual(ids, expected);
  assert.ok(ids.includes('gemini/gemini-3.5-flash'));
  assert.ok(ids.includes('xai/grok-4-fast'));
  assert.ok(!ids.some((id: string) => id.startsWith('glm/')));
  assert.ok(!ids.some((id: string) => id.startsWith('runpod/')));

  const limitedResponse = await app.inject({
    method: 'GET',
    url: '/api/me/fusion-available-models',
    headers: dashboardCookie(fusionLimited.email),
  });
  assert.equal(limitedResponse.statusCode, 200, limitedResponse.body);
  assert.equal(limitedResponse.headers['cache-control'], 'private, no-store');
  const limitedIds = limitedResponse.json().models.map((model: any) => model.id);
  const limitedExpected = MODEL_CATALOG
    .filter((model) => validateProviderModel(`${model.provider}/${model.id}`).ok)
    .filter((model) => authorizeEffectiveModelForUser(fusionLimited, model.provider, model.id).ok)
    .map((model) => `${model.provider}/${model.id}`);
  assert.deepEqual(limitedIds, limitedExpected);
  assert.ok(limitedIds.some((id: string) => id.startsWith('openai_codex/')));
  assert.ok(limitedIds.includes('openrouter/tencent/hy3:free'), 'public OpenRouter model remains policy-allowed');
  assert.ok(!limitedIds.some((id: string) => id.startsWith('gemini/')));
  assert.ok(!limitedIds.some((id: string) => id.startsWith('groq/')));
  await app.close();
});

test('canonical /v1/models entries expose stable OpenAI fields and Super Proxy metadata', async () => {
  const app = await buildApp();
  const response = await app.inject({ method: 'GET', url: '/v1/models', headers: bearer(admin.token) });
  assert.equal(response.statusCode, 200, response.body);

  const canonical = response.json().data.filter((model: any) => model.catalog_id);
  for (const model of canonical) {
    assert.equal(model.object, 'model');
    assert.equal(typeof model.id, 'string');
    assert.equal(typeof model.created, 'number');
    assert.equal(model.owned_by, model.provider);
    assert.equal(model.catalog_id, `${model.provider}/${model.id}`);
    assert.equal(typeof model.endpoint, 'string');
    assert.equal(typeof model.api, 'string');
    assert.equal(typeof model.streaming, 'boolean');
    assert.equal(typeof model.non_streaming, 'boolean');
    assert.ok(Array.isArray(model.input_modalities));
    assert.ok(Array.isArray(model.output_modalities));
    assert.ok(Array.isArray(model.capabilities));
    assert.ok(Array.isArray(model.interfaces));
    assert.ok(model.interfaces.length > 0);
    assert.equal(typeof model.direct_runtime_support, 'boolean');
    assert.equal(typeof model.fusion_routable, 'boolean');
    const primary = model.interfaces[0];
    assert.equal(model.endpoint, primary.path);
    assert.equal(model.api, primary.api);
    assert.equal(model.streaming, primary.response_modes.includes('streaming'));
    assert.equal(model.non_streaming, primary.response_modes.includes('non_streaming'));
  }

  const video = canonical.find((model: any) => model.catalog_id === 'xai/grok-imagine-video');
  assert.equal(video.id, 'grok-imagine-video');
  assert.equal(video.max_reference_images, 7);
  assert.equal(video.interfaces.find((iface: any) => iface.operation === 'video-editing').path, '/v1/xai/videos/edits');
  assert.equal(video.interfaces.find((iface: any) => iface.operation === 'video-extension').path, '/v1/xai/videos/extensions');

  const fallback = canonical.find((model: any) => model.catalog_id === 'cerebras/qwen-3-235b-a22b-instruct-2507');
  assert.equal(fallback.direct_runtime_support, false);
  assert.equal(fallback.runtime_model, 'gpt-oss-120b');

  const glm = canonical.find((model: any) => model.catalog_id === 'glm/glm-5.2');
  assert.equal(glm.direct_runtime_support, true);
  assert.equal(glm.fusion_routable, false);

  const k3 = canonical.find((model: any) => model.catalog_id === 'kimi/k3');
  assert.equal(k3.id, 'k3');
  assert.equal(k3.direct_runtime_support, true);
  assert.deepEqual(k3.interfaces.map((iface: any) => iface.path), [
    '/v1/kimi/chat/completions',
    '/v1/kimi/messages',
  ]);
  await app.close();
});
