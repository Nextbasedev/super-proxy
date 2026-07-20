import type { FastifyInstance } from 'fastify';
import { getDashboardUser } from './auth/dashboard-auth.js';
import { getDb } from './db/index.js';
import { createProxyToken } from './utils/crypto.js';
import { requireProxyToken } from './auth/token-auth.js';
import { z } from 'zod';
import {
  validateProviderModel,
  RESERVED_PRESET_NAMES,
  parseProviderModel,
  resolveBuiltInPreset,
  resolveUserPreset,
  validateFusionConfig,
} from './fusion/presets.js';
import type { FusionPreset } from './fusion/types.js';
import { CATALOG_LISTING_CREATED_TS, MODEL_CATALOG, catalogEntryToListing } from './providers/model-catalog.js';
import { authorizeEffectiveModelForUser, isModelAllowedForUser } from './proxy/policy.js';

type PolicyUser = { id: number; role: string; isAdmin?: boolean };

function isFusionProviderModelViable(user: PolicyUser, providerModel: string): boolean {
  if (!validateProviderModel(providerModel).ok) return false;
  const [provider, model] = parseProviderModel(providerModel);
  return authorizeEffectiveModelForUser(user, provider, model).ok;
}

function isFusionPresetVisible(user: PolicyUser, alias: string, preset: FusionPreset): boolean {
  try {
    if (!isModelAllowedForUser(user, 'fusion', alias).ok) return false;
    if (!Array.isArray(preset?.panel) || !preset.panel.every((model) => typeof model === 'string')) return false;
    if (typeof preset.synthesizer !== 'string' || !validateFusionConfig(preset).ok) return false;
    return preset.panel.every((model) => isFusionProviderModelViable(user, model))
      && isFusionProviderModelViable(user, preset.synthesizer);
  } catch {
    return false;
  }
}

function fusionModelListing(alias: string, created: number): Record<string, unknown> {
  const catalog = MODEL_CATALOG.find((entry) => entry.provider === 'fusion' && entry.id === alias)
    ?? MODEL_CATALOG.find((entry) => entry.provider === 'fusion' && entry.id === 'custom')!;
  return {
    id: `fusion/${alias}`,
    object: 'model',
    created,
    owned_by: 'fusion',
    provider: 'fusion',
    endpoint: catalog.endpoint,
    api: catalog.api,
    streaming: catalog.streaming,
    non_streaming: catalog.non_streaming,
    input_modalities: catalog.input_modalities,
    output_modalities: catalog.output_modalities,
    capabilities: catalog.capabilities,
    interfaces: catalog.interfaces,
    direct_runtime_support: catalog.direct_runtime_support,
  };
}

export function registerSelfApi(app: FastifyInstance) {
  app.get('/v1/token/check', async (req, reply) => {
    const auth = await requireProxyToken(req, reply);
    if (!auth) return;
    return {
      ok: true,
      user: { email: auth.user.email, role: auth.user.role, isAdmin: auth.user.isAdmin },
      token: { id: auth.token.id, label: auth.token.label, prefix: auth.token.prefix },
    };
  });

  app.get('/api/me/summary', async (req, reply) => {
    const user = getDashboardUser(req);
    if (!user) { reply.code(401).send({ error: 'Not authenticated' }); return; }
    const db = getDb();
    const tokens = db.prepare(`SELECT id,label,token_prefix,enabled,cap_usd_daily,cap_tokens_daily,created_at,last_used_at FROM api_tokens WHERE user_id=? ORDER BY id DESC`).all(user.id);
    const usage = db.prepare(`SELECT provider, model, COUNT(*) requests, COALESCE(SUM(input_tokens+output_tokens+cache_creation_tokens+cache_read_tokens),0) tokens, COALESCE(SUM(estimated_cost_usd),0) usd FROM usage_events WHERE user_id=? AND created_at >= datetime('now','-1 day') GROUP BY provider,model ORDER BY requests DESC`).all(user.id);
    const limits = db.prepare(`
      SELECT COALESCE(ul.provider, rl.provider) provider, COALESCE(ul.daily_usd, rl.daily_usd) daily_usd, COALESCE(ul.daily_tokens, rl.daily_tokens) daily_tokens
      FROM users u
      LEFT JOIN role_limits rl ON rl.role=u.role
      LEFT JOIN user_limits ul ON ul.user_id=u.id AND ul.provider=rl.provider
      WHERE u.id=?
    `).all(user.id);
    return { user, tokens, usage, limits };
  });

  app.post('/api/me/tokens', async (req, reply) => {
    const user = getDashboardUser(req);
    if (!user) { reply.code(401).send({ error: 'Not authenticated' }); return; }
    const body = z.object({ label: z.string().min(1).max(80).default('personal') }).parse(req.body || {});
    const token = createProxyToken();
    const info = getDb().prepare('INSERT INTO api_tokens (user_id,label,token_hash,token_prefix) VALUES (?,?,?,?)').run(user.id, body.label, token.hash, token.prefix);
    return { id: Number(info.lastInsertRowid), token: token.raw, prefix: token.prefix, label: body.label };
  });

  app.delete('/api/me/tokens/:id', async (req, reply) => {
    const user = getDashboardUser(req);
    if (!user) { reply.code(401).send({ error: 'Not authenticated' }); return; }
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const owner = getDb().prepare('SELECT id FROM api_tokens WHERE id = ? AND user_id = ?').get(params.id, user.id) as any;
    if (!owner) { reply.code(404).send({ error: 'Token not found' }); return; }
    getDb().prepare('UPDATE usage_events SET token_id = NULL WHERE token_id = ?').run(params.id);
    getDb().prepare('DELETE FROM api_tokens WHERE id = ?').run(params.id);
    return { ok: true };
  });

  // ─── Fusion Preset CRUD ────────────────────────────────────────────────────

  // Zod schema for preset name: lowercase [a-z0-9-], 1-40 chars, not reserved
  const presetNameSchema = z
    .string()
    .min(1, 'Preset name must be at least 1 character')
    .max(40, 'Preset name must be at most 40 characters')
    .regex(/^[a-z0-9-]+$/, 'Preset name must contain only lowercase letters, digits, and hyphens')
    .refine((n) => !RESERVED_PRESET_NAMES.has(n), {
      message: `Preset name must not be a reserved name (${[...RESERVED_PRESET_NAMES].join(', ')})`,
    });

  // Zod schema for provider/model validation
  const providerModelSchema = z.string().superRefine((val, ctx) => {
    const result = validateProviderModel(val);
    if (!result.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.message });
    }
  });

  const presetBodySchema = z.object({
    name: presetNameSchema,
    panel: z
      .array(providerModelSchema)
      .min(1, 'panel must have at least 1 model')
      .max(8, 'panel can have at most 8 models'),
    synthesizer: providerModelSchema,
    panel_max_tokens: z.number().int().positive().optional().default(4096),
    synthesizer_max_tokens: z.number().int().positive().optional().default(8192),
    panel_timeout_ms: z.number().int().positive().optional().default(120000),
    thinking: z.record(z.string(), z.any()).optional(),
  });

  const presetUpdateBodySchema = presetBodySchema.omit({ name: true });

  function formatPreset(row: any) {
    return {
      id: row.id,
      name: row.name,
      panel: JSON.parse(row.panel_models_json),
      synthesizer: row.synthesizer_model,
      panel_max_tokens: row.panel_max_tokens,
      synthesizer_max_tokens: row.synthesizer_max_tokens,
      panel_timeout_ms: row.panel_timeout_ms,
      thinking: tryParseJson(row.thinking_overrides_json, undefined),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  // GET /api/me/fusion-presets — list all user's saved presets
  app.get('/api/me/fusion-presets', async (req, reply) => {
    const user = getDashboardUser(req);
    if (!user) { reply.code(401).send({ error: 'Not authenticated' }); return; }
    const rows = getDb()
      .prepare('SELECT id, name, panel_models_json, synthesizer_model, panel_max_tokens, synthesizer_max_tokens, panel_timeout_ms, thinking_overrides_json, created_at, updated_at FROM fusion_presets WHERE user_id = ? ORDER BY created_at ASC')
      .all(user.id);
    return { presets: rows.map(formatPreset) };
  });

  // POST /api/me/fusion-presets — create a new preset
  app.post('/api/me/fusion-presets', async (req, reply) => {
    const user = getDashboardUser(req);
    if (!user) { reply.code(401).send({ error: 'Not authenticated' }); return; }

    let body: z.infer<typeof presetBodySchema>;
    try {
      body = presetBodySchema.parse(req.body);
    } catch (err: any) {
      reply.code(400).send({ error: 'Validation failed', details: err.errors ?? err.message });
      return;
    }

    const db = getDb();

    // Check max 20 presets per user
    const count = (db.prepare('SELECT COUNT(*) as cnt FROM fusion_presets WHERE user_id = ?').get(user.id) as { cnt: number }).cnt;
    if (count >= 20) {
      reply.code(400).send({ error: 'You have reached the maximum of 20 saved fusion presets.' });
      return;
    }

    // Check for duplicate name
    const existing = db.prepare('SELECT id FROM fusion_presets WHERE user_id = ? AND name = ?').get(user.id, body.name);
    if (existing) {
      reply.code(409).send({ error: `A preset named "${body.name}" already exists.` });
      return;
    }

    const info = db.prepare(
      'INSERT INTO fusion_presets (user_id, name, panel_models_json, synthesizer_model, panel_max_tokens, synthesizer_max_tokens, panel_timeout_ms, thinking_overrides_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      user.id,
      body.name,
      JSON.stringify(body.panel),
      body.synthesizer,
      body.panel_max_tokens,
      body.synthesizer_max_tokens,
      body.panel_timeout_ms,
      body.thinking ? JSON.stringify(body.thinking) : null,
    );

    const created = db.prepare('SELECT id, name, panel_models_json, synthesizer_model, panel_max_tokens, synthesizer_max_tokens, panel_timeout_ms, thinking_overrides_json, created_at, updated_at FROM fusion_presets WHERE id = ?').get(info.lastInsertRowid);
    reply.code(201).send(formatPreset(created));
  });

  // PUT /api/me/fusion-presets/:name — update an existing preset (name is immutable)
  app.put('/api/me/fusion-presets/:name', async (req, reply) => {
    const user = getDashboardUser(req);
    if (!user) { reply.code(401).send({ error: 'Not authenticated' }); return; }

    const params = z.object({ name: z.string() }).parse(req.params);

    let body: z.infer<typeof presetUpdateBodySchema>;
    try {
      body = presetUpdateBodySchema.parse(req.body);
    } catch (err: any) {
      reply.code(400).send({ error: 'Validation failed', details: err.errors ?? err.message });
      return;
    }

    const db = getDb();
    const existing = db.prepare('SELECT id FROM fusion_presets WHERE user_id = ? AND name = ?').get(user.id, params.name);
    if (!existing) {
      reply.code(404).send({ error: `Preset "${params.name}" not found.` });
      return;
    }

    db.prepare(
      'UPDATE fusion_presets SET panel_models_json = ?, synthesizer_model = ?, panel_max_tokens = ?, synthesizer_max_tokens = ?, panel_timeout_ms = ?, thinking_overrides_json = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND name = ?'
    ).run(
      JSON.stringify(body.panel),
      body.synthesizer,
      body.panel_max_tokens,
      body.synthesizer_max_tokens,
      body.panel_timeout_ms,
      body.thinking ? JSON.stringify(body.thinking) : null,
      user.id,
      params.name,
    );

    const updated = db.prepare('SELECT id, name, panel_models_json, synthesizer_model, panel_max_tokens, synthesizer_max_tokens, panel_timeout_ms, thinking_overrides_json, created_at, updated_at FROM fusion_presets WHERE user_id = ? AND name = ?').get(user.id, params.name);
    return formatPreset(updated);
  });

  // DELETE /api/me/fusion-presets/:name — delete a preset
  app.delete('/api/me/fusion-presets/:name', async (req, reply) => {
    const user = getDashboardUser(req);
    if (!user) { reply.code(401).send({ error: 'Not authenticated' }); return; }

    const params = z.object({ name: z.string() }).parse(req.params);
    const db = getDb();
    const existing = db.prepare('SELECT id FROM fusion_presets WHERE user_id = ? AND name = ?').get(user.id, params.name);
    if (!existing) {
      reply.code(404).send({ error: `Preset "${params.name}" not found.` });
      return;
    }

    db.prepare('DELETE FROM fusion_presets WHERE user_id = ? AND name = ?').run(user.id, params.name);
    return { ok: true };
  });

  // ─── GET /api/me/fusion-available-models — models eligible for fusion panel/synthesizer ─

  app.get('/api/me/fusion-available-models', async (req, reply) => {
    reply.header('cache-control', 'private, no-store');
    const user = getDashboardUser(req);
    if (!user) { reply.code(401).send({ error: 'Not authenticated' }); return; }

    const models = MODEL_CATALOG
      .filter((entry) => validateProviderModel(`${entry.provider}/${entry.id}`).ok)
      .filter((entry) => authorizeEffectiveModelForUser(user, entry.provider, entry.id).ok)
      .map((entry) => ({ id: `${entry.provider}/${entry.id}`, provider: entry.provider, model: entry.id }));
    return { models };
  });

  // ─── GET /v1/models — OpenAI-compatible model list (includes fusion presets) ─

  app.get('/v1/models', async (req, reply) => {
    reply.header('cache-control', 'private, no-store');
    const auth = await requireProxyToken(req, reply);
    if (!auth) return;

    const CREATED_TS = CATALOG_LISTING_CREATED_TS;

    // Fusion aliases are request-policy filtered and only advertised when all
    // currently configured panel/synthesizer models are exactly routable and
    // callable by this user.
    const models: Array<Record<string, unknown>> = [];
    for (const alias of ['max', 'quality', 'budget'] as const) {
      const preset = resolveBuiltInPreset(`fusion/${alias}`)!;
      if (isFusionPresetVisible(auth.user, alias, preset)) {
        models.push(fusionModelListing(alias, CREATED_TS));
      }
    }

    // Preserve the historical Fusion listing above for compatibility. Canonical
    // Fusion aliases are not appended again. Every real provider model is
    // filtered through the same policy used by request-time proxy enforcement.
    // Shared serializer with /v1/<provider>/models (catalogEntryToListing);
    // fusion_routable is a root-listing extra.
    for (const entry of MODEL_CATALOG) {
      if (entry.provider === 'fusion') continue;
      if (!authorizeEffectiveModelForUser(auth.user, entry.provider, entry.id).ok) continue;
      models.push(catalogEntryToListing(entry, {
        fusion_routable: validateProviderModel(`${entry.provider}/${entry.id}`).ok,
      }));
    }

    // User's custom fusion presets
    const db = getDb();
    const rows = db.prepare(
      'SELECT name, created_at FROM fusion_presets WHERE user_id = ? ORDER BY created_at ASC',
    ).all(auth.user.id) as Array<{ name: string; created_at: string }>;

    for (const row of rows) {
      const preset = resolveUserPreset(auth.user.id, row.name);
      if (!preset || !isFusionPresetVisible(auth.user, row.name, preset)) continue;
      const createdEpoch = Math.floor(new Date(row.created_at + 'Z').getTime() / 1000) || CREATED_TS;
      models.push(fusionModelListing(row.name, createdEpoch));
    }

    return { object: 'list', data: models };
  });

  // ─── GET /api/me/fusion-calls — Fusion call history for dashboard ────────────

  app.get('/api/me/fusion-calls', async (req, reply) => {
    const user = getDashboardUser(req);
    if (!user) { reply.code(401).send({ error: 'Not authenticated' }); return; }

    const db = getDb();
    const rows = db.prepare(`
      SELECT f.id, f.parent_usage_event_id, f.preset, f.panel_models_json,
             f.synthesizer_model, f.panel_succeeded, f.panel_failed,
             f.failed_models_json, f.synthesizer_succeeded, f.synthesizer_skipped,
             f.total_latency_ms, f.panel_latency_ms, f.synthesizer_latency_ms,
             f.created_at,
             u.estimated_cost_usd, u.model AS usage_model
      FROM fusion_calls f
      LEFT JOIN usage_events u ON u.id = f.parent_usage_event_id
      WHERE f.user_id = ?
      ORDER BY f.created_at DESC
      LIMIT 50
    `).all(user.id) as Array<any>;

    const calls = rows.map((r) => ({
      id: r.id,
      preset: r.preset,
      panel_models: tryParseJson(r.panel_models_json, []),
      synthesizer_model: r.synthesizer_model,
      panel_succeeded: r.panel_succeeded,
      panel_failed: r.panel_failed,
      failed_models: tryParseJson(r.failed_models_json, []),
      synthesizer_succeeded: r.synthesizer_succeeded,
      synthesizer_skipped: r.synthesizer_skipped,
      total_latency_ms: r.total_latency_ms,
      panel_latency_ms: r.panel_latency_ms,
      synthesizer_latency_ms: r.synthesizer_latency_ms,
      estimated_cost_usd: r.estimated_cost_usd,
      created_at: r.created_at,
    }));

    return { calls };
  });
}

function tryParseJson(str: string | null | undefined, fallback: any): any {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}
