import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';

process.env.DATABASE_PATH = path.join(os.tmpdir(), `nbmg-provider-models-${process.pid}.sqlite`);
process.env.DEV_ADMIN_KEY = 'test-admin-key';

const { getDb } = await import('./db/index.js');
const { migrate } = await import('./db/migrate.js');
const { sha256 } = await import('./utils/crypto.js');
const { registerProviderModelsRoutes, pathScopedProviders } = await import('./api/provider-models.js');
const { registerRunpodProxy } = await import('./proxy/runpod.js');
const { registerSelfApi } = await import('./self-api.js');
const { catalogModelsForProvider } = await import('./providers/model-catalog.js');

migrate();

function reset() {
  const db = getDb();
  db.prepare('DELETE FROM user_provider_access_modes').run();
  db.prepare('DELETE FROM user_model_denies').run();
  db.prepare('DELETE FROM user_grants').run();
  db.prepare('DELETE FROM api_tokens').run();
  db.prepare('DELETE FROM users WHERE email != ?').run('admin@localhost');
}

function seedUser(raw = 'nbmg_provider_models_token') {
  const db = getDb();
  const userId = Number(db.prepare("INSERT INTO users (email,role,is_admin,enabled) VALUES ('pm@example.com','developer',0,1)").run().lastInsertRowid);
  db.prepare('INSERT INTO api_tokens (user_id,label,token_hash,token_prefix,enabled) VALUES (?,?,?,?,1)').run(userId, 'pm-token', sha256(raw), raw.slice(0, 14));
  return { raw, userId };
}

function allow(userId: number, provider: string) {
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(userId, provider, 'allow_all');
}

function appWith(...registrars: Array<(app: any) => void>) {
  const app = Fastify();
  for (const r of registrars) r(app);
  return app;
}

test('pathScopedProviders derives the EXACT expected set (silent-drop guard)', () => {
  // Exact-set assertion, not includes(): with the every()-over-interfaces
  // predicate, a future catalog edit that gives a derived provider one
  // mixed-root interface would silently DROP its /models route (returning
  // 404s for fleet clients) with no error anywhere. This deepEqual turns
  // that silent production regression into a red test. It also pins the
  // subtle exclusions: openai is out because its interfaces root at
  // /v1/images/ — the exact case every() exists for (some() would pass it).
  assert.deepEqual(
    [...pathScopedProviders()].sort(),
    ['cerebras', 'deepgram', 'fish', 'gemini', 'glm', 'groq', 'kimi', 'openrouter', 'runpod', 'xai'],
  );
});

test('every derived provider serves a live, provider-scoped, canonical listing', async () => {
  // Parametrized over the derived set so new providers are auto-covered and
  // the least-obvious classes (audio/TTS: fish, deepgram) get real 200s.
  reset();
  const { raw, userId } = seedUser();
  const app = appWith(registerProviderModelsRoutes);
  for (const provider of pathScopedProviders()) {
    allow(userId, provider);
    const res = await app.inject({ method: 'GET', url: `/v1/${provider}/models`, headers: { authorization: `Bearer ${raw}` } });
    assert.equal(res.statusCode, 200, `${provider}: ${res.body}`);
    assert.equal(res.headers['cache-control'], 'private, no-store', provider);
    const body = res.json();
    assert.equal(body.object, 'list');
    assert.ok(body.data.length > 0, `${provider} listing must not be empty for an allowed user`);
    const catalogIds = catalogModelsForProvider(provider).map((e) => e.id);
    assert.deepEqual(body.data.map((m: any) => m.id).sort(), [...catalogIds].sort(), provider);
    for (const m of body.data) {
      assert.equal(m.owned_by, provider);
      assert.ok(m.catalog_id.startsWith(`${provider}/`), provider);
      assert.ok(Array.isArray(m.interfaces) && m.interfaces.length > 0, provider);
    }
  }
});

test('unauthenticated request is rejected', async () => {
  reset();
  const app = appWith(registerProviderModelsRoutes);
  const res = await app.inject({ method: 'GET', url: '/v1/groq/models' });
  assert.equal(res.statusCode, 401);
});

test('per-provider listing: policy-filtered, provider-scoped, catalog-derived', async () => {
  reset();
  const { raw, userId } = seedUser();
  allow(userId, 'groq');
  const app = appWith(registerProviderModelsRoutes);

  const res = await app.inject({ method: 'GET', url: '/v1/groq/models', headers: { authorization: `Bearer ${raw}` } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.headers['cache-control'], 'private, no-store');
  const body = res.json();
  assert.equal(body.object, 'list');
  const ids = body.data.map((m: any) => m.id);
  const catalogIds = catalogModelsForProvider('groq').map((e) => e.id);
  assert.deepEqual(ids.sort(), [...catalogIds].sort(), 'listing must mirror the registry');
  for (const m of body.data) {
    assert.equal(m.owned_by, 'groq');
    assert.ok(m.catalog_id.startsWith('groq/'));
    assert.ok(Array.isArray(m.interfaces) && m.interfaces.length > 0, 'metadata parity with root listing');
  }

  // deny_all provider → empty list, not 403 (parity with root listing behavior)
  const denied = await app.inject({ method: 'GET', url: '/v1/kimi/models', headers: { authorization: `Bearer ${raw}` } });
  assert.equal(denied.statusCode, 200);
  assert.deepEqual(denied.json().data, []);
});

test('model deny rows filter the per-provider listing', async () => {
  reset();
  const { raw, userId } = seedUser();
  allow(userId, 'groq');
  getDb().prepare('INSERT INTO user_model_denies (user_id,provider,model) VALUES (?,?,?)').run(userId, 'groq', 'llama-3.1-8b-instant');
  const app = appWith(registerProviderModelsRoutes);
  const res = await app.inject({ method: 'GET', url: '/v1/groq/models', headers: { authorization: `Bearer ${raw}` } });
  const ids = res.json().data.map((m: any) => m.id);
  assert.ok(!ids.includes('llama-3.1-8b-instant'));
  assert.ok(ids.length > 0, 'other groq models still listed');
});

test('K3 is advertised with its exact Kimi runtime ID and both Kimi Code interfaces', async () => {
  reset();
  const { raw, userId } = seedUser();
  allow(userId, 'kimi');
  const app = appWith(registerProviderModelsRoutes);
  const res = await app.inject({ method: 'GET', url: '/v1/kimi/models', headers: { authorization: `Bearer ${raw}` } });
  assert.equal(res.statusCode, 200, res.body);
  const k3 = res.json().data.find((model: any) => model.id === 'k3');
  assert.ok(k3, 'K3 must use Kimi’s documented exact runtime ID');
  assert.equal(k3.catalog_id, 'kimi/k3');
  assert.equal(k3.direct_runtime_support, true);
  assert.deepEqual(k3.interfaces.map((iface: any) => iface.path), [
    '/v1/kimi/chat/completions',
    '/v1/kimi/messages',
  ]);
  await app.close();
});

test('runpod listing preserves both virtual ids and applies runtime_model authorization', async () => {
  reset();
  const { raw, userId } = seedUser();
  allow(userId, 'runpod');
  const app = appWith(registerRunpodProxy, registerProviderModelsRoutes);
  const res = await app.inject({ method: 'GET', url: '/v1/runpod/models', headers: { authorization: `Bearer ${raw}` } });
  assert.equal(res.statusCode, 200, res.body);
  const ids = res.json().data.map((m: any) => m.id).sort();
  assert.deepEqual(ids, ['qwen36-27b', 'qwen36-27b-fast'], 'both virtual ids (parity with removed hardcoded handler)');
  const fast = res.json().data.find((m: any) => m.id === 'qwen36-27b-fast');
  assert.equal(fast.direct_runtime_support, false);
  assert.equal(fast.runtime_model, 'qwen36-27b');

  // Denying the runtime fallback model hides the alias too
  // (authorizeEffectiveModelForUser checks the effective model).
  getDb().prepare('INSERT INTO user_model_denies (user_id,provider,model) VALUES (?,?,?)').run(userId, 'runpod', 'qwen36-27b');
  const res2 = await app.inject({ method: 'GET', url: '/v1/runpod/models', headers: { authorization: `Bearer ${raw}` } });
  assert.deepEqual(res2.json().data, [], 'deny on runtime model hides both ids');
});

test('full route composition boots: provider-models + runpod proxy + self-api', async () => {
  // Regression guard for FST_ERR_DUPLICATED_ROUTE: runpod.ts used to register
  // GET /v1/runpod/models itself. Composing all three modules must not throw.
  const app = appWith(registerRunpodProxy, registerSelfApi, registerProviderModelsRoutes);
  await app.ready();
  await app.close();
});
