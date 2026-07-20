import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';

process.env.DATABASE_PATH = path.join(os.tmpdir(), `nbmg-model-access-${process.pid}.sqlite`);
process.env.DEV_ADMIN_KEY = 'test-admin-key';
process.env.GROQ_UPSTREAM_URL = 'https://groq.test/openai/v1';

const { getDb } = await import('./db/index.js');
const { migrate } = await import('./db/migrate.js');
const { sha256 } = await import('./utils/crypto.js');
const { isModelAllowedForUser } = await import('./proxy/policy.js');
const { registerAdminApi } = await import('./admin/admin-api.js');
const { registerGroqProxy } = await import('./proxy/groq.js');
const { registerFusionProxy } = await import('./proxy/fusion.js');

migrate();

function resetRuntimeTables() {
  const db = getDb();
  db.prepare('DELETE FROM request_logs').run();
  db.prepare('DELETE FROM provider_health_events').run();
  db.prepare('DELETE FROM groq_model_cooldowns').run();
  db.prepare('DELETE FROM groq_usage_buckets').run();
  db.prepare('DELETE FROM groq_limits').run();
  db.prepare('DELETE FROM usage_events').run();
  db.prepare('DELETE FROM user_provider_access_modes').run();
  db.prepare('DELETE FROM user_model_denies').run();
  db.prepare('DELETE FROM user_grants').run();
  db.prepare('DELETE FROM api_tokens').run();
  db.prepare('DELETE FROM users WHERE email != ?').run('admin@localhost');
  db.prepare('DELETE FROM provider_accounts').run();
}

function seedUserAndToken(raw = 'sp_model_access_token') {
  const db = getDb();
  const userId = Number(db.prepare("INSERT INTO users (email,role,is_admin,enabled) VALUES ('dev@example.com','developer',0,1)").run().lastInsertRowid);
  const tokenId = Number(db.prepare('INSERT INTO api_tokens (user_id,label,token_hash,token_prefix,enabled) VALUES (?,?,?,?,1)').run(userId, 'dev-token', sha256(raw), raw.slice(0, 14)).lastInsertRowid);
  return { raw, userId, tokenId, user: { id: userId, role: 'developer' } };
}

function seedGroq(label = 'g1', secret = 'gsk_test') {
  return Number(getDb().prepare("INSERT INTO provider_accounts (provider,label,secret,status,enabled) VALUES ('groq',?,?, 'active',1)").run(label, secret).lastInsertRowid);
}

test('migration creates user_model_denies table', () => {
  assert.ok(getDb().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user_model_denies'").get());
  assert.ok(getDb().prepare('SELECT version FROM schema_migrations WHERE version=?').get(2026051801));
  assert.ok(getDb().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user_provider_access_modes'").get());
  assert.ok(getDb().prepare('SELECT version FROM schema_migrations WHERE version=?').get(2026051802));
});

test('PUT atomically replaces denies', async () => {
  resetRuntimeTables();
  const { userId } = seedUserAndToken();
  const app = Fastify();
  registerAdminApi(app);
  let res = await app.inject({ method: 'PUT', url: `/admin/users/${userId}/model-access`, headers: { 'x-admin-key': 'test-admin-key' }, payload: { deniedModels: [{ provider: 'groq', model: 'openai/gpt-oss-120b' }, { provider: 'anthropic', model: 'claude-opus-4-7' }] } });
  assert.equal(res.statusCode, 200, res.body);
  res = await app.inject({ method: 'PUT', url: `/admin/users/${userId}/model-access`, headers: { 'x-admin-key': 'test-admin-key' }, payload: { deniedModels: [{ provider: 'groq', model: 'llama-3.1-8b-instant' }] } });
  assert.equal(res.statusCode, 200, res.body);
  const rows = getDb().prepare('SELECT provider,model FROM user_model_denies WHERE user_id=? ORDER BY provider,model').all(userId) as any[];
  assert.deepEqual(rows, [{ provider: 'groq', model: 'llama-3.1-8b-instant' }]);
});

test('PUT saves provider access modes', async () => {
  resetRuntimeTables();
  const { userId } = seedUserAndToken();
  const app = Fastify();
  registerAdminApi(app);
  const res = await app.inject({ method: 'PUT', url: `/admin/users/${userId}/model-access`, headers: { 'x-admin-key': 'test-admin-key' }, payload: { deniedModels: [], providerModes: [{ provider: 'groq', mode: 'deny_all' }, { provider: 'kimi', mode: 'allow_all' }] } });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json().providerModes, [{ provider: 'groq', mode: 'deny_all' }, { provider: 'kimi', mode: 'allow_all' }]);
});

test('PUT no longer 500s when dashboard includes serper; deepgram saves, serper dropped', async () => {
  // Regression: the dashboard posts a mode row for EVERY provider it lists,
  // including search-only 'serper' which has no model catalog and is absent
  // from KNOWN_PROVIDERS. Previously z.enum(KNOWN_PROVIDERS) made the whole PUT
  // 500, bricking every model-access save (incl. enabling deepgram). Now the PUT
  // succeeds, the enforced provider (deepgram) is saved, and the unenforced
  // search-only 'serper' is silently dropped (not stored as a misleading mode).
  resetRuntimeTables();
  const { userId } = seedUserAndToken();
  const app = Fastify();
  registerAdminApi(app);
  const res = await app.inject({ method: 'PUT', url: `/admin/users/${userId}/model-access`, headers: { 'x-admin-key': 'test-admin-key' }, payload: { deniedModels: [], providerModes: [{ provider: 'deepgram', mode: 'allow_all' }, { provider: 'serper', mode: 'allow_all' }] } });
  assert.equal(res.statusCode, 200, res.body);
  const modes = res.json().providerModes;
  assert.ok(modes.some((m: any) => m.provider === 'deepgram' && m.mode === 'allow_all'), 'deepgram mode saved');
  assert.ok(!modes.some((m: any) => m.provider === 'serper'), 'serper not persisted (unenforced provider dropped)');
});

test('PUT ignores unknown providers instead of 500 (drift-proof)', async () => {
  resetRuntimeTables();
  const { userId } = seedUserAndToken();
  const app = Fastify();
  registerAdminApi(app);
  const res = await app.inject({ method: 'PUT', url: `/admin/users/${userId}/model-access`, headers: { 'x-admin-key': 'test-admin-key' }, payload: { deniedModels: [], providerModes: [{ provider: 'groq', mode: 'deny_all' }, { provider: 'totally_unknown_provider', mode: 'allow_all' }] } });
  assert.equal(res.statusCode, 200, res.body);
  const modes = res.json().providerModes;
  assert.ok(modes.some((m: any) => m.provider === 'groq'), 'known provider saved');
  assert.ok(!modes.some((m: any) => m.provider === 'totally_unknown_provider'), 'unknown provider dropped');
});

test('GET returns current denies', async () => {
  resetRuntimeTables();
  const { userId } = seedUserAndToken();
  getDb().prepare('INSERT INTO user_model_denies (user_id,provider,model) VALUES (?,?,?)').run(userId, 'groq', 'openai/gpt-oss-120b');
  const app = Fastify();
  registerAdminApi(app);
  const res = await app.inject({ method: 'GET', url: `/admin/users/${userId}/model-access`, headers: { 'x-admin-key': 'test-admin-key' } });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json().deniedModels, [{ provider: 'groq', model: 'openai/gpt-oss-120b' }]);
});

test('GET returns effective provider modes matching enforcement (non-admin defaults to deny_all)', async () => {
  resetRuntimeTables();
  const { userId } = seedUserAndToken();
  // Explicit row for groq, nothing for anthropic.
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(userId, 'groq', 'allow_all');
  const app = Fastify();
  registerAdminApi(app);
  const res = await app.inject({ method: 'GET', url: `/admin/users/${userId}/model-access`, headers: { 'x-admin-key': 'test-admin-key' } });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  const eff = new Map<string, string>((body.effectiveProviderModes || []).map((m: any) => [m.provider, m.mode]));
  // Explicit row wins.
  assert.equal(eff.get('groq'), 'allow_all');
  // No row + non-admin + non-codex provider must surface as deny_all so the
  // dashboard agrees with proxy enforcement.
  assert.equal(eff.get('anthropic'), 'deny_all');
  // Codex is the documented non-admin default-on exception.
  assert.equal(eff.get('openai_codex'), 'allow_all');
  // Raw providerModes should still only contain the explicit row.
  assert.deepEqual(body.providerModes, [{ provider: 'groq', mode: 'allow_all' }]);
});

test('GET returns effective provider modes for admins (default allow_all)', async () => {
  resetRuntimeTables();
  const db = getDb();
  const adminId = Number(db.prepare("INSERT INTO users (email,role,is_admin,enabled) VALUES ('admin2@example.com','admin',1,1)").run().lastInsertRowid);
  const app = Fastify();
  registerAdminApi(app);
  const res = await app.inject({ method: 'GET', url: `/admin/users/${adminId}/model-access`, headers: { 'x-admin-key': 'test-admin-key' } });
  assert.equal(res.statusCode, 200, res.body);
  const eff = new Map<string, string>((res.json().effectiveProviderModes || []).map((m: any) => [m.provider, m.mode]));
  assert.equal(eff.get('anthropic'), 'allow_all');
  assert.equal(eff.get('xai'), 'allow_all');
});

test('deny_all blocks even unknown provider models', () => {
  resetRuntimeTables();
  const { userId, user } = seedUserAndToken();
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(userId, 'groq', 'deny_all');
  assert.equal(isModelAllowedForUser(user, 'groq', 'new-expensive-model').ok, false);
});

test('custom mode blocks unknown models and allows known ON models', () => {
  resetRuntimeTables();
  const { userId, user } = seedUserAndToken();
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(userId, 'groq', 'custom');
  assert.deepEqual(isModelAllowedForUser(user, 'groq', 'openai/gpt-oss-120b'), { ok: true });
  assert.equal(isModelAllowedForUser(user, 'groq', 'new-expensive-model').ok, false);
});

test('allow_all allows unknown provider models', () => {
  resetRuntimeTables();
  const { userId, user } = seedUserAndToken();
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(userId, 'groq', 'allow_all');
  assert.deepEqual(isModelAllowedForUser(user, 'groq', 'new-expensive-model'), { ok: true });
});

test('non-admin users default to Codex plus public OpenRouter HY3 only without explicit provider mode', () => {
  resetRuntimeTables();
  const { user } = seedUserAndToken();
  assert.deepEqual(isModelAllowedForUser(user, 'openai_codex', 'gpt-5.5'), { ok: true });
  assert.equal(isModelAllowedForUser(user, 'anthropic', 'claude-opus-4-7').ok, false);
  assert.equal(isModelAllowedForUser(user, 'groq', 'openai/gpt-oss-120b').ok, false);
  assert.equal(isModelAllowedForUser(user, 'kimi', 'kimi-k2.6').ok, false);
  assert.deepEqual(isModelAllowedForUser(user, 'openrouter', 'tencent/hy3:free'), { ok: true });
  assert.equal(isModelAllowedForUser(user, 'openrouter', 'google/gemini-2.5-flash').ok, false);
});

test('provider defaults still allow admins without explicit mode', () => {
  resetRuntimeTables();
  const { userId } = seedUserAndToken();
  getDb().prepare('UPDATE users SET role=?, is_admin=1 WHERE id=?').run('admin', userId);
  const admin = { id: userId, role: 'admin', isAdmin: true };
  assert.deepEqual(isModelAllowedForUser(admin, 'anthropic', 'claude-opus-4-7'), { ok: true });
  assert.deepEqual(isModelAllowedForUser(admin, 'groq', 'openai/gpt-oss-120b'), { ok: true });
  assert.deepEqual(isModelAllowedForUser(admin, 'openrouter', 'tencent/hy3:free'), { ok: true });
  assert.deepEqual(isModelAllowedForUser(admin, 'deepgram', 'nova-3'), { ok: true });
  assert.deepEqual(isModelAllowedForUser(admin, 'fusion', 'quality'), { ok: true });
});

test('Fusion defaults to disabled for non-admin users and can be enabled as a provider', () => {
  resetRuntimeTables();
  const { userId, user } = seedUserAndToken();
  assert.equal(isModelAllowedForUser(user, 'fusion', 'quality').ok, false);
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(userId, 'fusion', 'allow_all');
  assert.deepEqual(isModelAllowedForUser(user, 'fusion', 'quality'), { ok: true });
});

test('Fusion route honors provider access mode before panel execution', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('sp_fusion_denied');
  const app = Fastify();
  registerFusionProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/fusion/chat/completions', headers: { authorization: `Bearer ${token.raw}` }, payload: { model: 'fusion/quality', messages: [{ role: 'user', content: 'hi' }] } });
  assert.equal(res.statusCode, 403, res.body);
  assert.equal(res.json().error.code, 'model_not_allowed_for_user');
});

test('Fusion route preflights synthesizer access for multi-panel synthesis', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('sp_fusion_synth_denied');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'fusion', 'allow_all');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'groq', 'allow_all');
  const app = Fastify();
  registerFusionProxy(app);
  const res = await app.inject({
    method: 'POST',
    url: '/v1/fusion/chat/completions',
    headers: { authorization: `Bearer ${token.raw}` },
    payload: {
      model: 'fusion/custom',
      messages: [{ role: 'user', content: 'hi' }],
      fusion: {
        mode: 'synthesize',
        panel: ['groq/openai/gpt-oss-120b', 'groq/llama-3.1-8b-instant'],
        synthesizer: 'anthropic/claude-opus-4-8',
      },
    },
  });
  assert.equal(res.statusCode, 403, res.body);
  assert.equal(res.json().error.code, 'synthesizer_model_not_allowed');
});

test('Fusion preflight requires authorization for both Cerebras alias and effective runtime model', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('sp_fusion_cerebras_runtime_denied');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'fusion', 'allow_all');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'cerebras', 'allow_all');
  getDb().prepare('INSERT INTO user_model_denies (user_id,provider,model) VALUES (?,?,?)').run(token.userId, 'cerebras', 'gpt-oss-120b');
  const app = Fastify();
  registerFusionProxy(app);
  const res = await app.inject({
    method: 'POST',
    url: '/v1/fusion/chat/completions',
    headers: { authorization: `Bearer ${token.raw}` },
    payload: {
      model: 'fusion/custom',
      messages: [{ role: 'user', content: 'hi' }],
      fusion: {
        panel: ['cerebras/qwen-3-235b-a22b-instruct-2507'],
        synthesizer: 'cerebras/qwen-3-235b-a22b-instruct-2507',
      },
    },
  });
  assert.equal(res.statusCode, 403, res.body);
  assert.equal(res.json().error.code, 'no_accessible_panel_models');
  await app.close();
});

test('Fusion route rejects a fabricated provider/model before dispatch', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken('sp_fusion_fake_model');
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(token.userId, 'fusion', 'allow_all');
  const app = Fastify();
  registerFusionProxy(app);
  const res = await app.inject({
    method: 'POST',
    url: '/v1/fusion/chat/completions',
    headers: { authorization: `Bearer ${token.raw}` },
    payload: {
      model: 'fusion/custom',
      messages: [{ role: 'user', content: 'hi' }],
      fusion: {
        panel: ['gemini/not-a-real-model'],
        synthesizer: 'openai_codex/gpt-5.4',
      },
    },
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().error.code, 'invalid_fusion_config');
  assert.match(res.json().error.message, /Unknown canonical model/);
});

test('explicit allow_all mode returns allowed', () => {
  resetRuntimeTables();
  const { userId, user } = seedUserAndToken();
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(userId, 'groq', 'allow_all');
  assert.deepEqual(isModelAllowedForUser(user, 'groq', 'openai/gpt-oss-120b'), { ok: true });
});

test('denied user/provider/model returns blocked', () => {
  resetRuntimeTables();
  const { userId, user } = seedUserAndToken();
  getDb().prepare('INSERT INTO user_model_denies (user_id,provider,model) VALUES (?,?,?)').run(userId, 'groq', 'openai/gpt-oss-120b');
  const res = isModelAllowedForUser(user, 'groq', 'openai/gpt-oss-120b');
  assert.equal(res.ok, false);
});

test('per-model deny blocks public OpenRouter HY3 default model', () => {
  resetRuntimeTables();
  const { userId, user } = seedUserAndToken();
  getDb().prepare('INSERT INTO user_model_denies (user_id,provider,model) VALUES (?,?,?)').run(userId, 'openrouter', 'tencent/hy3:free');
  const res = isModelAllowedForUser(user, 'openrouter', 'tencent/hy3:free');
  assert.equal(res.ok, false);
});

test('per-model grant overrides deny', () => {
  resetRuntimeTables();
  const { userId, user } = seedUserAndToken();
  const now = Date.now();
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(userId, 'groq', 'allow_all');
  getDb().prepare('INSERT INTO user_model_denies (user_id,provider,model) VALUES (?,?,?)').run(userId, 'groq', 'openai/gpt-oss-120b');
  getDb().prepare('INSERT INTO user_grants (user_id,provider,model_pattern,valid_from,valid_until) VALUES (?,?,?,?,?)').run(userId, 'groq', 'openai/gpt-oss-120b', now - 1000, now + 3600_000);
  assert.deepEqual(isModelAllowedForUser(user, 'groq', 'openai/gpt-oss-120b'), { ok: true });
});

test('wildcard grant does not override deny', () => {
  resetRuntimeTables();
  const { userId, user } = seedUserAndToken();
  const now = Date.now();
  getDb().prepare('INSERT INTO user_provider_access_modes (user_id,provider,mode) VALUES (?,?,?)').run(userId, 'groq', 'allow_all');
  getDb().prepare('INSERT INTO user_model_denies (user_id,provider,model) VALUES (?,?,?)').run(userId, 'groq', 'openai/gpt-oss-120b');
  getDb().prepare('INSERT INTO user_grants (user_id,provider,model_pattern,valid_from,valid_until) VALUES (?,?,?,?,?)').run(userId, 'groq', '*', now - 1000, now + 3600_000);
  assert.equal(isModelAllowedForUser(user, 'groq', 'openai/gpt-oss-120b').ok, false);
});

test('Groq route returns 400 model_not_allowed_for_user when blocked', async () => {
  resetRuntimeTables();
  const token = seedUserAndToken();
  seedGroq();
  getDb().prepare('INSERT INTO user_model_denies (user_id,provider,model) VALUES (?,?,?)').run(token.userId, 'groq', 'openai/gpt-oss-120b');
  const app = Fastify();
  registerGroqProxy(app);
  const res = await app.inject({ method: 'POST', url: '/v1/groq/chat/completions', headers: { authorization: `Bearer ${token.raw}` }, payload: { model: 'openai/gpt-oss-120b', messages: [{ role: 'user', content: 'hi' }] } });
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().error.code, 'model_not_allowed_for_user');
});

test('/admin/users returns deniedModelCount', async () => {
  resetRuntimeTables();
  const { userId } = seedUserAndToken();
  getDb().prepare('INSERT INTO user_model_denies (user_id,provider,model) VALUES (?,?,?)').run(userId, 'groq', 'openai/gpt-oss-120b');
  const app = Fastify();
  registerAdminApi(app);
  const res = await app.inject({ method: 'GET', url: '/admin/users', headers: { 'x-admin-key': 'test-admin-key' } });
  assert.equal(res.statusCode, 200, res.body);
  const user = res.json().users.find((u: any) => u.id === userId);
  assert.equal(user.deniedModelCount, 1);
});
