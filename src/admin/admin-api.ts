import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { createProxyToken, maskSecret } from '../utils/crypto.js';
import { audit } from './audit.js';
import { requireDashboardAdmin } from '../auth/dashboard-auth.js';
import { config } from '../config.js';
import { startPkce, consumePkce, parseOAuthCodeAndState } from '../utils/pkce.js';
import { extractAccountIdFromJwt } from '../utils/jwt.js';
import { getGovernorSnapshot } from '../providers/governor.js';
import { invalidateCompressionCache, getHeadroomSettings, setAppSetting } from '../proxy/compress.js';
import { ensureFreshCodexAccount, getCodexInFlightSnapshot, getCodexBucketCooldownSnapshot, clearCodexCooldowns } from '../providers/codex-pool.js';
import { getGroqLiveCounters } from '../providers/groq-pool.js';
import { getCerebrasLiveCounters } from '../providers/cerebras-pool.js';
import { DEFAULT_KIMI_MAX_IN_FLIGHT, getKimiInFlightSnapshot } from '../providers/kimi-pool.js';
import { DEFAULT_GLM_ACCOUNT_MAX_IN_FLIGHT, getGlmInFlightSnapshot } from '../providers/glm-pool.js';
import { DEFAULT_GEMINI_MAX_IN_FLIGHT, getGeminiInFlightSnapshot } from '../providers/gemini-pool.js';
import { DEFAULT_RUNPOD_MAX_IN_FLIGHT, getRunpodInFlightSnapshot } from '../providers/runpod-pool.js';
import { DEFAULT_DEEPGRAM_MAX_IN_FLIGHT } from '../providers/deepgram-pool.js';
import { KNOWN_MODELS_BY_PROVIDER, KNOWN_PROVIDERS, isKnownModel } from '../providers/known-models.js';
import { getEffectiveProviderMode } from '../proxy/policy.js';

function requireAdmin(req: FastifyRequest, reply: FastifyReply): { id: number } | null {
  return requireDashboardAdmin(req, reply);
}

function tableById(table: string, id: number) { return getDb().prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id); }

// Providers whose per-user access mode (allow_all/custom/deny_all) is actually
// enforced by policy.ts. The dashboard posts a mode row for EVERY provider it
// lists, including search-only ones (e.g. 'serper') that have no model catalog,
// no enforcement path, and are absent from KNOWN_PROVIDERS. We persist modes
// ONLY for enforced providers and silently drop the rest, so the PUT tolerates
// dashboard/server provider-list drift instead of 500-ing the whole save AND we
// never store a misleading mode that is silently unenforced (e.g. serper).
const MODE_PROVIDERS = new Set<string>(KNOWN_PROVIDERS as readonly string[]);

export function registerAdminApi(app: FastifyInstance) {

  app.get('/admin/known-models', async (req, reply) => {
    const actor = requireAdmin(req, reply); if (!actor) return;
    return { providers: KNOWN_MODELS_BY_PROVIDER };
  });

  app.get('/admin/users/:id/model-access', async (req, reply) => {
    const actor = requireAdmin(req, reply); if (!actor) return;
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const user = tableById('users', params.id);
    if (!user) { reply.code(404).send({ error: 'User not found' }); return; }
    const deniedModels = getDb().prepare('SELECT provider, model FROM user_model_denies WHERE user_id = ? ORDER BY provider, model').all(params.id);
    const providerModes = getDb().prepare('SELECT provider, mode FROM user_provider_access_modes WHERE user_id = ? ORDER BY provider').all(params.id);
    // `effectiveProviderModes` mirrors what the proxy actually enforces at
    // request time, including the non-admin default-off ladder. Without this
    // the dashboard could render `allow_all` for a provider while the gateway
    // was actually denying every request.
    const userRow = user as any;
    const userCtx = { id: userRow.id, role: userRow.role, isAdmin: !!userRow.is_admin };
    const effectiveProviderModes = (KNOWN_PROVIDERS as readonly string[]).map((provider) => ({
      provider,
      mode: getEffectiveProviderMode(userCtx, provider),
    }));
    return { deniedModels, providerModes, effectiveProviderModes };
  });

  app.put('/admin/users/:id/model-access', async (req, reply) => {
    const actor = requireAdmin(req, reply); if (!actor) return;
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const body = z.object({
      deniedModels: z.array(z.object({ provider: z.enum(KNOWN_PROVIDERS), model: z.string().min(1) })),
      // providerModes provider is validated loosely (z.string) then filtered to a
      // server-side allowlist below. The dashboard sends a mode row for EVERY
      // provider it knows (incl. search-only providers like 'serper' that have no
      // model list and are absent from KNOWN_PROVIDERS). Using z.enum(KNOWN_PROVIDERS)
      // here made the whole PUT 500 on any provider the server doesn't model,
      // bricking all model-access saves. Loose validate + allowlist filter is
      // drift-proof: unknown providers are ignored, not rejected.
      providerModes: z.array(z.object({ provider: z.string().min(1).max(40), mode: z.enum(['allow_all', 'custom', 'deny_all']) })).optional(),
    }).parse(req.body);
    const user = tableById('users', params.id);
    if (!user) { reply.code(404).send({ error: 'User not found' }); return; }
    const seen = new Set<string>();
    const deniedModels = [] as { provider: string; model: string }[];
    for (const row of body.deniedModels) {
      const model = row.model.trim();
      if (!isKnownModel(row.provider, model)) { reply.code(400).send({ error: `Unknown model ${row.provider}/${model}` }); return; }
      const key = `${row.provider}:::${model}`;
      if (!seen.has(key)) { seen.add(key); deniedModels.push({ provider: row.provider, model }); }
    }
    const before = getDb().prepare('SELECT provider, model FROM user_model_denies WHERE user_id = ? ORDER BY provider, model').all(params.id);
    const beforeModes = getDb().prepare('SELECT provider, mode FROM user_provider_access_modes WHERE user_id = ? ORDER BY provider').all(params.id);
    const tx = getDb().transaction(() => {
      getDb().prepare('DELETE FROM user_model_denies WHERE user_id = ?').run(params.id);
      const ins = getDb().prepare('INSERT INTO user_model_denies (user_id, provider, model, created_by_user_id) VALUES (?,?,?,?)');
      for (const d of deniedModels) ins.run(params.id, d.provider, d.model, actor.id || null);
      if (body.providerModes) {
        getDb().prepare('DELETE FROM user_provider_access_modes WHERE user_id = ?').run(params.id);
        const insMode = getDb().prepare('INSERT INTO user_provider_access_modes (user_id, provider, mode, created_by_user_id, updated_at) VALUES (?,?,?,?,CURRENT_TIMESTAMP)');
        const seenMode = new Set<string>();
        for (const m of body.providerModes) {
          // Persist modes only for providers whose access mode policy.ts enforces
          // (KNOWN_PROVIDERS). Silently skip anything else (e.g. search-only
          // 'serper', or a future dashboard-only provider) so provider-list drift
          // can never 500 the whole save, and we never store an unenforced mode.
          if (!MODE_PROVIDERS.has(m.provider) || seenMode.has(m.provider)) continue;
          seenMode.add(m.provider);
          insMode.run(params.id, m.provider, m.mode, actor.id || null);
        }
      }
    });
    tx();
    const after = getDb().prepare('SELECT provider, model FROM user_model_denies WHERE user_id = ? ORDER BY provider, model').all(params.id);
    const afterModes = getDb().prepare('SELECT provider, mode FROM user_provider_access_modes WHERE user_id = ? ORDER BY provider').all(params.id);
    audit({ actorUserId: actor.id, action: 'replace_user_model_access', targetType: 'user_model_access', targetId: params.id, before: { deniedModels: before, providerModes: beforeModes }, after: { deniedModels: after, providerModes: afterModes } });
    return { ok: true, deniedModels: after, providerModes: afterModes };
  });

  app.get('/admin/users', async (req, reply) => {
    const actor = requireAdmin(req, reply); if (!actor) return;
    const users = getDb().prepare('SELECT id,email,name,role,enabled,is_admin,full_body_logging,compression_enabled,created_at FROM users ORDER BY id').all() as any[];
    const tokens = getDb().prepare('SELECT id,user_id,label,token_prefix,enabled,cap_usd_daily,cap_tokens_daily,created_at,last_used_at FROM api_tokens ORDER BY id').all() as any[];
    const byUser = new Map<number, any[]>();
    for (const t of tokens) {
      const arr = byUser.get(t.user_id) || [];
      arr.push(t);
      byUser.set(t.user_id, arr);
    }
    const now = Date.now();
    const grantCounts = new Map<number, number>();
    for (const g of getDb().prepare('SELECT user_id, COUNT(*) n FROM user_grants WHERE valid_from <= ? AND valid_until >= ? GROUP BY user_id').all(now, now) as any[]) {
      grantCounts.set(g.user_id, g.n);
    }
    const deniedModelCounts = new Map<number, number>();
    for (const d of getDb().prepare('SELECT user_id, COUNT(*) n FROM user_model_denies GROUP BY user_id').all() as any[]) {
      deniedModelCounts.set(d.user_id, d.n);
    }
    // Normalise snake_case columns to camelCase so the dashboard reads the
    // real values (`isAdmin`, `fullBodyLogging`). Without this the toggles
    // always render off regardless of the actual DB state.
    const normalised = users.map((u) => ({
      ...u,
      enabled: !!u.enabled,
      isAdmin: !!u.is_admin,
      fullBodyLogging: !!u.full_body_logging,
      compressionEnabled: u.compression_enabled !== 0,
      activeGrantCount: grantCounts.get(u.id) || 0,
      deniedModelCount: deniedModelCounts.get(u.id) || 0,
      tokens: byUser.get(u.id) || [],
    }));
    return { users: normalised };
  });

  app.get('/admin/users/:id/tokens', async (req, reply) => {
    const actor = requireAdmin(req, reply); if (!actor) return;
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const tokens = getDb().prepare('SELECT id,user_id,label,token_prefix,enabled,cap_usd_daily,cap_tokens_daily,created_at,last_used_at FROM api_tokens WHERE user_id = ? ORDER BY id').all(params.id);
    return { tokens };
  });

  app.post('/admin/users', async (req, reply) => {
    const actor = requireAdmin(req, reply); if (!actor) return;
    const body = z.object({ email: z.string().email(), name: z.string().optional(), role: z.enum(['admin','founder','developer','member']).default('member'), isAdmin: z.boolean().default(false), fullBodyLogging: z.boolean().default(false) }).parse(req.body);
    const info = getDb().prepare('INSERT INTO users (email,name,role,is_admin,full_body_logging) VALUES (?,?,?,?,?)').run(body.email.toLowerCase(), body.name || null, body.role, body.isAdmin ? 1 : 0, body.fullBodyLogging ? 1 : 0);
    const after = tableById('users', Number(info.lastInsertRowid));
    audit({ actorUserId: actor.id, action: 'create_user', targetType: 'user', targetId: Number(info.lastInsertRowid), after });
    return { id: Number(info.lastInsertRowid) };
  });

  app.delete('/admin/users/:id', async (req, reply) => {
    const actor = requireAdmin(req, reply); if (!actor) return;
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const before = tableById('users', params.id) as any;
    if (!before) { reply.code(404).send({ error: 'User not found' }); return; }
    if (params.id === actor.id) { reply.code(400).send({ error: 'Cannot delete the currently signed-in admin' }); return; }
    const tx = getDb().transaction(() => {
      getDb().prepare('DELETE FROM request_logs WHERE user_id = ?').run(params.id);
      getDb().prepare('UPDATE usage_events SET user_id = NULL WHERE user_id = ?').run(params.id);
      getDb().prepare('DELETE FROM api_tokens WHERE user_id = ?').run(params.id);
      getDb().prepare('DELETE FROM user_limits WHERE user_id = ?').run(params.id);
      getDb().prepare('DELETE FROM users WHERE id = ?').run(params.id);
    });
    tx();
    audit({ actorUserId: actor.id, action: 'delete_user', targetType: 'user', targetId: params.id, before });
    return { ok: true };
  });

  app.patch('/admin/users/:id', async (req, reply) => {
    const actor = requireAdmin(req, reply); if (!actor) return;
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const body = z.object({ role: z.enum(['admin','founder','developer','member']).optional(), enabled: z.boolean().optional(), isAdmin: z.boolean().optional(), fullBodyLogging: z.boolean().optional(), compressionEnabled: z.boolean().optional(), name: z.string().optional() }).parse(req.body);
    const before = tableById('users', params.id);
    if (!before) { reply.code(404).send({ error: 'User not found' }); return; }
    const sets: string[] = [], vals: any[] = [];
    if (body.role) { sets.push('role = ?'); vals.push(body.role); }
    if (body.enabled !== undefined) { sets.push('enabled = ?'); vals.push(body.enabled ? 1 : 0); }
    if (body.isAdmin !== undefined) { sets.push('is_admin = ?'); vals.push(body.isAdmin ? 1 : 0); }
    if (body.fullBodyLogging !== undefined) { sets.push('full_body_logging = ?'); vals.push(body.fullBodyLogging ? 1 : 0); }
    if (body.compressionEnabled !== undefined) { sets.push('compression_enabled = ?'); vals.push(body.compressionEnabled ? 1 : 0); invalidateCompressionCache(); }
    if (body.name !== undefined) { sets.push('name = ?'); vals.push(body.name); }
    if (sets.length) getDb().prepare(`UPDATE users SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...vals, params.id);
    if (body.enabled === false) getDb().prepare('UPDATE api_tokens SET enabled = 0 WHERE user_id = ?').run(params.id);
    const after = tableById('users', params.id);
    audit({ actorUserId: actor.id, action: 'update_user', targetType: 'user', targetId: params.id, before, after });
    return { ok: true, user: after };
  });

  app.post('/admin/users/:id/tokens', async (req, reply) => {
    const actor = requireAdmin(req, reply); if (!actor) return;
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const body = z.object({ label: z.string().min(1).max(80), capUsdDaily: z.number().nullable().optional(), capTokensDaily: z.number().int().nullable().optional() }).parse(req.body);
    const token = createProxyToken();
    const info = getDb().prepare('INSERT INTO api_tokens (user_id,label,token_hash,token_prefix,cap_usd_daily,cap_tokens_daily) VALUES (?,?,?,?,?,?)').run(params.id, body.label, token.hash, token.prefix, body.capUsdDaily || null, body.capTokensDaily || null);
    audit({ actorUserId: actor.id, action: 'create_token', targetType: 'api_token', targetId: Number(info.lastInsertRowid), after: { userId: params.id, label: body.label, prefix: token.prefix } });
    return { id: Number(info.lastInsertRowid), token: token.raw, prefix: token.prefix };
  });

  app.delete('/admin/tokens/:id', async (req, reply) => {
    const actor = requireAdmin(req, reply); if (!actor) return;
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const before = tableById('api_tokens', params.id) as any;
    if (!before) { reply.code(404).send({ error: 'Token not found' }); return; }
    getDb().prepare('UPDATE usage_events SET token_id = NULL WHERE token_id = ?').run(params.id);
    getDb().prepare('DELETE FROM api_tokens WHERE id = ?').run(params.id);
    audit({ actorUserId: actor.id, action: 'delete_token', targetType: 'api_token', targetId: params.id, before: { userId: before.user_id, label: before.label, prefix: before.token_prefix } });
    return { ok: true };
  });

  app.patch('/admin/tokens/:id', async (req, reply) => {
    const actor = requireAdmin(req, reply); if (!actor) return;
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const body = z.object({ enabled: z.boolean().optional(), capUsdDaily: z.number().nullable().optional(), capTokensDaily: z.number().int().nullable().optional() }).parse(req.body);
    const before = tableById('api_tokens', params.id);
    const sets: string[] = [], vals: any[] = [];
    if (body.enabled !== undefined) { sets.push('enabled = ?'); vals.push(body.enabled ? 1 : 0); }
    if (body.capUsdDaily !== undefined) { sets.push('cap_usd_daily = ?'); vals.push(body.capUsdDaily); }
    if (body.capTokensDaily !== undefined) { sets.push('cap_tokens_daily = ?'); vals.push(body.capTokensDaily); }
    if (sets.length) getDb().prepare(`UPDATE api_tokens SET ${sets.join(', ')} WHERE id = ?`).run(...vals, params.id);
    const after = tableById('api_tokens', params.id);
    audit({ actorUserId: actor.id, action: 'update_token', targetType: 'api_token', targetId: params.id, before, after });
    return { ok: true };
  });

  app.get('/admin/provider-accounts', async (req, reply) => {
    const actor = requireAdmin(req, reply); if (!actor) return;
    // Cooldowns are time-bound. Clear expired persisted cooldown states before
    // rendering so the dashboard does not show accounts as "cooldown" after
    // the governor already considers them eligible again.
    getDb().prepare(`UPDATE provider_accounts SET status='active', cooldown_until=0, updated_at=CURRENT_TIMESTAMP WHERE status='cooldown' AND COALESCE(cooldown_until,0) <= ?`).run(Date.now());
    const accounts = getDb().prepare('SELECT id,provider,label,owner_email,secret,enabled,status,max_in_flight,cooldown_until,expires_at,last_used_at,last_refresh_at,consecutive_failures,notes,risk_notes,quota_notes,created_at FROM provider_accounts ORDER BY provider,label').all() as any[];
    const snap = getGovernorSnapshot();
    const codexSnap = getCodexInFlightSnapshot();
    const codexCooldownSnap = getCodexBucketCooldownSnapshot();
    const kimiSnap = getKimiInFlightSnapshot();
    const glmSnap = getGlmInFlightSnapshot();
    const geminiSnap = getGeminiInFlightSnapshot();
    const runpodSnap = getRunpodInFlightSnapshot();
    const lastEventByAcct = new Map<number, { status: string; reason: string | null; created_at: string }>();
    const lastQuotaByAcct = new Map<number, string>();
    for (const ev of getDb().prepare("SELECT provider_account_id id, status, reason, created_at FROM provider_health_events WHERE provider_account_id IS NOT NULL ORDER BY id DESC").all() as any[]) {
      if (!lastEventByAcct.has(ev.id)) lastEventByAcct.set(ev.id, ev);
    }
    for (const a of getDb().prepare("SELECT target_id id, MAX(created_at) at FROM admin_audit_logs WHERE action='check_provider_quota' AND target_type='provider_account' GROUP BY target_id").all() as any[]) {
      const idn = Number(a.id);
      if (Number.isFinite(idn)) lastQuotaByAcct.set(idn, a.at);
    }
    return { accounts: accounts.map((a) => {
      const ev = lastEventByAcct.get(a.id);
      return {
        ...a,
        masked_secret: maskSecret(a.secret),
        secret: undefined,
        live_in_flight: a.provider === 'openai_codex'
          ? (codexSnap[a.id] ?? 0)
          : a.provider === 'kimi'
            ? (kimiSnap[a.id] ?? 0)
            : a.provider === 'glm'
            ? (glmSnap[a.id] ?? 0)
            : a.provider === 'gemini'
              ? (geminiSnap[a.id] ?? 0)
              : a.provider === 'runpod'
              ? (runpodSnap[a.id] ?? 0)
              : (snap[a.id]?.inFlight ?? 0),
        live_recent_count: snap[a.id]?.recentCount ?? 0,
        live_cooldown_until: snap[a.id]?.cooldownUntil ?? 0,
        // Codex cooldowns live in `codex_bucket_cooldowns`, not provider_accounts.
        // Surface them so the dashboard does not falsely show a rate-limited
        // Codex account as fully active.
        codex_bucket_cooldowns: a.provider === 'openai_codex' ? (codexCooldownSnap[a.id] ?? []) : undefined,
        codex_cooldown_until: a.provider === 'openai_codex'
          ? (codexCooldownSnap[a.id] ?? []).reduce((mx, c) => Math.max(mx, c.cooldown_until || 0), 0)
          : undefined,
        last_quota_check: lastQuotaByAcct.get(a.id) || null,
        last_event_status: ev?.status || null,
        last_event_reason: ev?.reason || null,
        last_event_at: ev?.created_at || null,
      };
    }) };
  });

  app.get('/admin/provider-accounts/:id/events', async (req, reply) => {
    const actor = requireAdmin(req, reply); if (!actor) return;
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const events = getDb().prepare('SELECT id,status,reason,detail,created_at FROM provider_health_events WHERE provider_account_id = ? ORDER BY id DESC LIMIT 100').all(params.id);
    return { events };
  });



  app.post('/admin/provider-accounts/codex/oauth/start', async (req, reply) => {
    const actor = requireAdmin(req, reply); if (!actor) return;
    const body = z.object({ label: z.string().optional(), emailHint: z.string().email().optional() }).parse(req.body || {});
    const ownerKey = `codex-pool:${body.label || body.emailHint || 'pool'}`;
    const flow = startPkce(ownerKey);
    const params = new URLSearchParams({
      client_id: config.openaiCodexClientId,
      response_type: 'code',
      redirect_uri: 'http://localhost:1455/auth/callback',
      scope: 'openid profile email offline_access',
      code_challenge: flow.codeChallenge,
      code_challenge_method: 'S256',
      state: flow.state,
      prompt: 'login',
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      originator: 'codex_cli_rs',
    });
    audit({ actorUserId: actor.id, action: 'start_codex_oauth', targetType: 'provider_account', targetId: body.label || body.emailHint || 'pool' });
    return { ok: true, authUrl: `https://auth.openai.com/oauth/authorize?${params.toString()}`, state: flow.state, expiresAt: new Date(flow.createdAt + 10 * 60_000).toISOString() };
  });

  app.post('/admin/provider-accounts/codex/oauth/callback', async (req, reply) => {
    const actor = requireAdmin(req, reply); if (!actor) return;
    const body = z.object({ code: z.string().min(1), state: z.string().optional(), label: z.string().min(1).optional(), email: z.string().email().optional(), maxInFlight: z.number().int().positive().optional() }).parse(req.body || {});
    const parsed = parseOAuthCodeAndState(body.code, body.state);
    const ownerKey = `codex-pool:${body.label || body.email || 'pool'}`;
    const flow = consumePkce(parsed.state, ownerKey);
    if (!flow) { reply.code(400).send({ error: 'OAuth session not found or expired. Start OAuth again.' }); return; }
    const tokenRes = await fetch('https://auth.openai.com/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: config.openaiCodexClientId, redirect_uri: 'http://localhost:1455/auth/callback', code: parsed.code, code_verifier: flow.codeVerifier }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!tokenRes.ok) {
      const detail = await tokenRes.text().catch(() => '');
      reply.code(400).send({ error: `Token exchange failed (${tokenRes.status})`, detail: detail.slice(0, 300) });
      return;
    }
    const tokenData = await tokenRes.json() as any;
    const accessToken = tokenData.access_token || '';
    const refreshToken = tokenData.refresh_token || '';
    const accountId = extractAccountIdFromJwt(accessToken);
    if (!accessToken || !refreshToken || !accountId) { reply.code(400).send({ error: 'OAuth response missing access token, refresh token, or ChatGPT account id' }); return; }
    const expiresAt = Date.now() + Number(tokenData.expires_in || 3600) * 1000;
    const label = body.label || body.email || accountId.slice(0, 10);
    const existing = getDb().prepare('SELECT id FROM provider_accounts WHERE provider=? AND account_id=?').get('openai_codex', accountId) as any;
    let id: number;
    if (existing?.id) {
      id = Number(existing.id);
      getDb().prepare(`UPDATE provider_accounts SET label=?, owner_email=?, secret=?, refresh_secret=?, expires_at=?, max_in_flight=?, status='active', enabled=1, cooldown_until=0, consecutive_failures=0, notes='refreshed via Codex OAuth', updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(label, body.email || null, accessToken, refreshToken, expiresAt, body.maxInFlight || 50, id);
    } else {
      const info = getDb().prepare(`INSERT INTO provider_accounts (provider,label,owner_email,secret,refresh_secret,account_id,expires_at,max_in_flight,status,notes)
        VALUES ('openai_codex',?,?,?,?,?,?,?,'active','onboarded via Codex OAuth')`).run(label, body.email || null, accessToken, refreshToken, accountId, expiresAt, body.maxInFlight || 50);
      id = Number(info.lastInsertRowid);
    }
    const row = getDb().prepare('SELECT id,label,owner_email,account_id,status FROM provider_accounts WHERE id=?').get(id) as any;
    audit({ actorUserId: actor.id, action: 'complete_codex_oauth', targetType: 'provider_account', targetId: id, after: { label, email: body.email, accountId: accountId.slice(0, 8), status: 'active' } });
    return { ok: true, account: row };
  });

  app.get('/admin/kimi', async (req, reply) => {
    const actor = requireAdmin(req, reply); if (!actor) return;
    const inFlight = getKimiInFlightSnapshot();
    const accounts = getDb().prepare(`
      SELECT pa.id,pa.provider,pa.label,pa.owner_email,pa.secret,pa.enabled,pa.status,pa.max_in_flight,pa.cooldown_until,pa.last_used_at,pa.notes,pa.created_at,
             COUNT(e.id) AS requests_24h,
             COALESCE(SUM(e.input_tokens+e.output_tokens+e.cache_creation_tokens+e.cache_read_tokens),0) AS tokens_24h
      FROM provider_accounts pa
      LEFT JOIN usage_events e ON e.provider_account_id = pa.id AND e.provider='kimi' AND e.created_at >= datetime('now','-1 day')
      WHERE pa.provider='kimi'
      GROUP BY pa.id
      ORDER BY pa.label, pa.id
    `).all() as any[];
    return { accounts: accounts.map((a) => ({ ...a, secret: maskSecret(a.secret), inFlight: inFlight[a.id] || 0, maxInFlight: a.max_in_flight || DEFAULT_KIMI_MAX_IN_FLIGHT })) };
  });

  app.get('/admin/runpod', async (req, reply) => {
    const actor = requireAdmin(req, reply); if (!actor) return;
    const inFlight = getRunpodInFlightSnapshot();
    const accounts = getDb().prepare(`
      SELECT pa.id,pa.provider,pa.label,pa.owner_email,pa.secret,pa.account_id,pa.enabled,pa.status,pa.max_in_flight,pa.cooldown_until,pa.last_used_at,pa.notes,pa.created_at,
             COUNT(e.id) AS requests_24h,
             COALESCE(SUM(e.input_tokens+e.output_tokens+e.cache_creation_tokens+e.cache_read_tokens),0) AS tokens_24h
      FROM provider_accounts pa
      LEFT JOIN usage_events e ON e.provider_account_id = pa.id AND e.provider='runpod' AND e.created_at >= datetime('now','-1 day')
      WHERE pa.provider='runpod'
      GROUP BY pa.id
      ORDER BY pa.label, pa.id
    `).all() as any[];
    return { accounts: accounts.map((a) => ({ ...a, secret: maskSecret(a.secret), inFlight: inFlight[a.id] || 0, maxInFlight: a.max_in_flight || DEFAULT_RUNPOD_MAX_IN_FLIGHT, endpointId: a.account_id })) };
  });

  app.post('/admin/runpod/:id/clear-cooldowns', async (req, reply) => {
    const actor = requireAdmin(req, reply); if (!actor) return;
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const before = tableById('provider_accounts', params.id) as any;
    if (!before || before.provider !== 'runpod') { reply.code(404).send({ error: 'Runpod account not found' }); return; }
    getDb().prepare("UPDATE provider_accounts SET status='active', cooldown_until=0, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(params.id);
    const after = tableById('provider_accounts', params.id);
    audit({ actorUserId: actor.id, action: 'clear_runpod_cooldown', targetType: 'provider_account', targetId: params.id, before, after });
    return { ok: true, account: after };
  });

  // Clears Codex bucket cooldowns (codex_bucket_cooldowns) for an account.
  // Unlike other providers, Codex rate-limits are tracked per account+model
  // bucket and are invisible to provider_accounts.status. NOTE: clearing here
  // does NOT reset upstream OpenAI/ChatGPT quota; if quota is still exhausted
  // the next request will 429 and re-cooldown.
  app.post('/admin/codex/:id/clear-cooldowns', async (req, reply) => {
    const actor = requireAdmin(req, reply); if (!actor) return;
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const before = tableById('provider_accounts', params.id) as any;
    if (!before || before.provider !== 'openai_codex') { reply.code(404).send({ error: 'Codex account not found' }); return; }
    const cleared = clearCodexCooldowns(params.id);
    const after = tableById('provider_accounts', params.id);
    audit({ actorUserId: actor.id, action: 'clear_codex_cooldown', targetType: 'provider_account', targetId: params.id, before, after: { ...(after as any), clearedBucketCooldowns: cleared } });
    return { ok: true, clearedBucketCooldowns: cleared, account: after };
  });

  app.post('/admin/kimi/:id/clear-cooldowns', async (req, reply) => {
    const actor = requireAdmin(req, reply); if (!actor) return;
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const before = tableById('provider_accounts', params.id) as any;
    if (!before || before.provider !== 'kimi') { reply.code(404).send({ error: 'Kimi account not found' }); return; }
    getDb().prepare("UPDATE provider_accounts SET status='active', cooldown_until=0, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(params.id);
    const after = tableById('provider_accounts', params.id);
    audit({ actorUserId: actor.id, action: 'clear_kimi_cooldown', targetType: 'provider_account', targetId: params.id, before, after });
    return { ok: true, account: after };
  });

  app.post('/admin/provider-accounts', async (req, reply) => {
    const actor = requireAdmin(req, reply); if (!actor) return;
    const body = z.object({
      provider: z.enum(['anthropic','openai_codex','openai','groq','cerebras','kimi','glm','gemini','openrouter','deepgram','fish','xai','runpod','serper']),
      label: z.string().min(1),
      ownerEmail: z.string().email().nullable().optional(),
      secret: z.string().min(1),
      refreshSecret: z.string().nullable().optional(),
      accountId: z.string().nullable().optional(),
      expiresAt: z.number().int().nullable().optional(),
      maxInFlight: z.number().int().positive().nullable().optional(),
      notes: z.string().nullable().optional(),
      riskNotes: z.string().nullable().optional(),
      quotaNotes: z.string().nullable().optional(),
    }).parse(req.body);
    const defaultMaxInFlight = body.maxInFlight || (body.provider === 'openai_codex' ? 50 : body.provider === 'kimi' ? DEFAULT_KIMI_MAX_IN_FLIGHT : body.provider === 'glm' ? DEFAULT_GLM_ACCOUNT_MAX_IN_FLIGHT : body.provider === 'gemini' ? DEFAULT_GEMINI_MAX_IN_FLIGHT : body.provider === 'deepgram' ? DEFAULT_DEEPGRAM_MAX_IN_FLIGHT : body.provider === 'runpod' ? DEFAULT_RUNPOD_MAX_IN_FLIGHT : null);
    const info = getDb().prepare(`INSERT INTO provider_accounts (provider,label,owner_email,secret,refresh_secret,account_id,expires_at,max_in_flight,notes,risk_notes,quota_notes) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(body.provider, body.label, body.ownerEmail || null, body.secret, body.refreshSecret || null, body.accountId || null, body.expiresAt || 0, defaultMaxInFlight, body.notes || null, body.riskNotes || null, body.quotaNotes || null);
    audit({ actorUserId: actor.id, action: 'create_provider_account', targetType: 'provider_account', targetId: Number(info.lastInsertRowid), after: { ...body, secret: maskSecret(body.secret), refreshSecret: body.refreshSecret ? maskSecret(body.refreshSecret) : undefined } });
    return { id: Number(info.lastInsertRowid), secret: maskSecret(body.secret) };
  });

  app.patch('/admin/provider-accounts/:id', async (req, reply) => {
    const actor = requireAdmin(req, reply); if (!actor) return;
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const body = z.object({ enabled: z.boolean().optional(), status: z.string().optional(), maxInFlight: z.number().int().positive().nullable().optional(), notes: z.string().nullable().optional(), riskNotes: z.string().nullable().optional(), quotaNotes: z.string().nullable().optional() }).parse(req.body);
    const before = tableById('provider_accounts', params.id);
    const map: Record<string,string> = { enabled: 'enabled', status: 'status', maxInFlight: 'max_in_flight', notes: 'notes', riskNotes: 'risk_notes', quotaNotes: 'quota_notes' };
    const sets: string[] = [], vals: any[] = [];
    for (const [k, col] of Object.entries(map)) if ((body as any)[k] !== undefined) { sets.push(`${col} = ?`); vals.push(typeof (body as any)[k] === 'boolean' ? ((body as any)[k] ? 1 : 0) : (body as any)[k]); }
    if (sets.length) getDb().prepare(`UPDATE provider_accounts SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...vals, params.id);
    const after = tableById('provider_accounts', params.id);
    audit({ actorUserId: actor.id, action: 'update_provider_account', targetType: 'provider_account', targetId: params.id, before, after });
    return { ok: true };
  });





  app.get('/admin/provider-accounts/:id/secret', async (req, reply) => {
    const actor = requireAdmin(req, reply); if (!actor) return;
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const row = getDb().prepare('SELECT id,label,provider,secret FROM provider_accounts WHERE id = ?').get(params.id) as any;
    if (!row) { reply.code(404).send({ error: 'Account not found' }); return; }
    audit({ actorUserId: actor.id, action: 'reveal_provider_secret', targetType: 'provider_account', targetId: params.id, after: { label: row.label, provider: row.provider } });
    return { id: row.id, label: row.label, provider: row.provider, secret: row.secret };
  });

  app.delete('/admin/provider-accounts/:id', async (req, reply) => {
    const actor = requireAdmin(req, reply); if (!actor) return;
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const before = tableById('provider_accounts', params.id);
    if (!before) { reply.code(404).send({ error: 'Account not found' }); return; }
    getDb().prepare('DELETE FROM provider_accounts WHERE id = ?').run(params.id);
    audit({ actorUserId: actor.id, action: 'delete_provider_account', targetType: 'provider_account', targetId: params.id, before });
    return { ok: true };
  });

  app.get('/admin/groq', async (req, reply) => {
    const actor = requireAdmin(req, reply); if (!actor) return;
    const accounts = getDb().prepare(`SELECT id,provider,label,owner_email,enabled,status,cooldown_until,last_used_at,notes,quota_notes,created_at FROM provider_accounts WHERE provider='groq' ORDER BY label,id`).all() as any[];
    const cooldowns = getDb().prepare('SELECT account_id,model,cooldown_until,reason FROM groq_model_cooldowns WHERE cooldown_until > ? ORDER BY cooldown_until DESC').all(Date.now()) as any[];
    return { accounts: accounts.map((a) => ({ ...a, counters: getGroqLiveCounters(a.id), cooldowns: cooldowns.filter((c) => c.account_id === a.id) })) };
  });

  app.put('/admin/groq/:id/limits', async (req, reply) => {
    const actor = requireAdmin(req, reply); if (!actor) return;
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const body = z.object({ model: z.string().min(1), rpm: z.number().int().positive().nullable().optional(), rpd: z.number().int().positive().nullable().optional(), tpm: z.number().int().positive().nullable().optional(), tpd: z.number().int().positive().nullable().optional() }).parse(req.body);
    const acct = getDb().prepare("SELECT id FROM provider_accounts WHERE id=? AND provider='groq'").get(params.id);
    if (!acct) { reply.code(404).send({ error: 'Groq account not found' }); return; }
    const before = getDb().prepare('SELECT * FROM groq_limits WHERE account_id=? AND model=?').get(params.id, body.model);
    getDb().prepare(`INSERT INTO groq_limits (account_id,model,rpm,rpd,tpm,tpd) VALUES (?,?,?,?,?,?) ON CONFLICT(account_id,model) DO UPDATE SET rpm=excluded.rpm,rpd=excluded.rpd,tpm=excluded.tpm,tpd=excluded.tpd`)
      .run(params.id, body.model, body.rpm ?? null, body.rpd ?? null, body.tpm ?? null, body.tpd ?? null);
    const after = getDb().prepare('SELECT * FROM groq_limits WHERE account_id=? AND model=?').get(params.id, body.model);
    audit({ actorUserId: actor.id, action: 'update_groq_limit', targetType: 'groq_limit', targetId: `${params.id}:${body.model}`, before, after });
    return { ok: true, limit: after };
  });

  app.delete('/admin/groq/:id/limits/:model', async (req, reply) => {
    const actor = requireAdmin(req, reply); if (!actor) return;
    const params = z.object({ id: z.coerce.number().int().positive(), model: z.string().min(1) }).parse(req.params);
    const before = getDb().prepare('SELECT * FROM groq_limits WHERE account_id=? AND model=?').get(params.id, params.model);
    getDb().prepare('DELETE FROM groq_limits WHERE account_id=? AND model=?').run(params.id, params.model);
    audit({ actorUserId: actor.id, action: 'delete_groq_limit', targetType: 'groq_limit', targetId: `${params.id}:${params.model}`, before });
    return { ok: true };
  });

  app.post('/admin/groq/:id/clear-cooldowns', async (req, reply) => {
    const actor = requireAdmin(req, reply); if (!actor) return;
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const result = getDb().prepare('DELETE FROM groq_model_cooldowns WHERE account_id=?').run(params.id);
    audit({ actorUserId: actor.id, action: 'clear_groq_cooldowns', targetType: 'provider_account', targetId: params.id, after: { cleared: result.changes } });
    return { ok: true, cleared: result.changes };
  });

  app.get('/admin/cerebras', async (req, reply) => {
    const actor = requireAdmin(req, reply); if (!actor) return;
    const accounts = getDb().prepare(`SELECT id,provider,label,owner_email,enabled,status,cooldown_until,last_used_at,notes,quota_notes,created_at FROM provider_accounts WHERE provider='cerebras' ORDER BY label,id`).all() as any[];
    const cooldowns = getDb().prepare('SELECT account_id,model,cooldown_until,reason FROM cerebras_model_cooldowns WHERE cooldown_until > ? ORDER BY cooldown_until DESC').all(Date.now()) as any[];
    return { accounts: accounts.map((a) => ({ ...a, counters: getCerebrasLiveCounters(a.id), cooldowns: cooldowns.filter((c) => c.account_id === a.id) })) };
  });

  app.put('/admin/cerebras/:id/limits', async (req, reply) => {
    const actor = requireAdmin(req, reply); if (!actor) return;
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const body = z.object({ model: z.string().min(1), rpm: z.number().int().positive().nullable().optional(), rpd: z.number().int().positive().nullable().optional(), tpm: z.number().int().positive().nullable().optional(), tpd: z.number().int().positive().nullable().optional() }).parse(req.body);
    const acct = getDb().prepare("SELECT id FROM provider_accounts WHERE id=? AND provider='cerebras'").get(params.id);
    if (!acct) { reply.code(404).send({ error: 'Cerebras account not found' }); return; }
    const before = getDb().prepare('SELECT * FROM cerebras_limits WHERE account_id=? AND model=?').get(params.id, body.model);
    getDb().prepare(`INSERT INTO cerebras_limits (account_id,model,rpm,rpd,tpm,tpd) VALUES (?,?,?,?,?,?) ON CONFLICT(account_id,model) DO UPDATE SET rpm=excluded.rpm,rpd=excluded.rpd,tpm=excluded.tpm,tpd=excluded.tpd`)
      .run(params.id, body.model, body.rpm ?? null, body.rpd ?? null, body.tpm ?? null, body.tpd ?? null);
    const after = getDb().prepare('SELECT * FROM cerebras_limits WHERE account_id=? AND model=?').get(params.id, body.model);
    audit({ actorUserId: actor.id, action: 'update_cerebras_limit', targetType: 'cerebras_limit', targetId: `${params.id}:${body.model}`, before, after });
    return { ok: true, limit: after };
  });

  app.delete('/admin/cerebras/:id/limits/:model', async (req, reply) => {
    const actor = requireAdmin(req, reply); if (!actor) return;
    const params = z.object({ id: z.coerce.number().int().positive(), model: z.string().min(1) }).parse(req.params);
    const before = getDb().prepare('SELECT * FROM cerebras_limits WHERE account_id=? AND model=?').get(params.id, params.model);
    getDb().prepare('DELETE FROM cerebras_limits WHERE account_id=? AND model=?').run(params.id, params.model);
    audit({ actorUserId: actor.id, action: 'delete_cerebras_limit', targetType: 'cerebras_limit', targetId: `${params.id}:${params.model}`, before });
    return { ok: true };
  });

  app.post('/admin/cerebras/:id/clear-cooldowns', async (req, reply) => {
    const actor = requireAdmin(req, reply); if (!actor) return;
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const result = getDb().prepare('DELETE FROM cerebras_model_cooldowns WHERE account_id=?').run(params.id);
    audit({ actorUserId: actor.id, action: 'clear_cerebras_cooldowns', targetType: 'provider_account', targetId: params.id, after: { cleared: result.changes } });
    return { ok: true, cleared: result.changes };
  });

  // In-memory throttle: at most one quota probe per account per 30s.
  const quotaCheckLastAt = new Map<number, number>();
  app.post('/admin/provider-accounts/:id/quota', async (req, reply) => {
    const actor = requireAdmin(req, reply); if (!actor) return;
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const last = quotaCheckLastAt.get(params.id) || 0;
    const sinceMs = Date.now() - last;
    if (sinceMs < 30_000) {
      reply.code(429).send({ error: 'Quota check throttled', retryInMs: 30_000 - sinceMs });
      return;
    }
    quotaCheckLastAt.set(params.id, Date.now());
    const row = getDb().prepare('SELECT id,label,provider,secret,refresh_secret,account_id,expires_at,max_in_flight,status,cooldown_until FROM provider_accounts WHERE id = ?').get(params.id) as any;
    if (!row) { reply.code(404).send({ error: 'Account not found' }); return; }
    const out: any = { id: row.id, label: row.label, provider: row.provider, httpStatus: null, headers: {}, checkedAt: new Date().toISOString() };
    try {
      let res: Response;
      if (row.provider === 'anthropic') {
        res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${row.secret}`,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
            'user-agent': 'claude-cli/2.1.2 (external, cli)',
            'x-app': 'cli',
            'anthropic-dangerous-direct-browser-access': 'true',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ model: 'claude-sonnet-4-5-20250929', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
          signal: AbortSignal.timeout(30_000),
        });
      } else if (row.provider === 'kimi') {
        res = await fetch(`${config.kimiUpstreamUrl}/models`, {
          method: 'GET',
          headers: { authorization: `Bearer ${row.secret}`, accept: 'application/json' },
          signal: AbortSignal.timeout(30_000),
        });
      } else if (row.provider === 'openai_codex') {
        const fresh = await ensureFreshCodexAccount(row);
        if (!fresh) {
          out.error = 'Codex account refresh failed';
          return out;
        }
        res = await fetch('https://chatgpt.com/backend-api/codex/responses', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${fresh.secret}`,
            'content-type': 'application/json',
            accept: 'text/event-stream',
            ...(fresh.account_id ? { 'chatgpt-account-id': fresh.account_id } : {}),
            originator: 'codex_cli_rs',
            'openai-beta': 'responses=experimental',
          },
          body: JSON.stringify({
            model: 'gpt-5.5',
            input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
            instructions: 'You are a helpful assistant.',
            store: false,
            stream: true,
          }),
          signal: AbortSignal.timeout(30_000),
        });
        // Drain the SSE stream a tiny bit to capture rate-limit headers, then abort.
        try { await res.body?.cancel(); } catch {}
      } else if (row.provider === 'groq') {
        res = await fetch('https://api.groq.com/openai/v1/models', {
          method: 'GET',
          headers: { authorization: `Bearer ${row.secret}` },
          signal: AbortSignal.timeout(30_000),
        });
      } else if (row.provider === 'runpod') {
        const endpointId = row.account_id || config.runpodEndpointId;
        if (!endpointId) return { ...out, error: 'Runpod account missing endpoint id' };
        res = await fetch(`${config.runpodUpstreamBaseUrl.replace(/\/$/, '')}/${endpointId}/openai/v1/models`, {
          method: 'GET',
          headers: { authorization: `Bearer ${row.secret}`, accept: 'application/json' },
          signal: AbortSignal.timeout(30_000),
        });
      } else if (row.provider === 'cerebras') {
        res = await fetch(`${config.cerebrasUpstreamUrl}/models`, {
          method: 'GET',
          headers: { authorization: `Bearer ${row.secret}`, accept: 'application/json' },
          signal: AbortSignal.timeout(30_000),
        });
      } else {
        return { ...out, message: `Live quota check not implemented for provider "${row.provider}"` };
      }
      out.httpStatus = res.status;
      for (const [k, v] of res.headers.entries()) {
        const lk = k.toLowerCase();
        if (lk.startsWith('anthropic-ratelimit-') || lk.startsWith('x-ratelimit') || lk === 'retry-after') out.headers[k] = v;
      }
      if (!res.ok && Object.keys(out.headers).length === 0) {
        try { out.error = (await res.text()).slice(0, 300); } catch {}
      }
      getDb().prepare('UPDATE provider_accounts SET quota_notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(JSON.stringify(out.headers).slice(0, 2000), row.id);
      audit({ actorUserId: actor.id, action: 'check_provider_quota', targetType: 'provider_account', targetId: params.id, after: { label: row.label, provider: row.provider, httpStatus: out.httpStatus } });
      return out;
    } catch (err: any) {
      out.error = String(err?.message || err);
      return out;
    }
  });

  app.get('/admin/limits', async (req, reply) => {
    const actor = requireAdmin(req, reply); if (!actor) return;
    return {
      roleLimits: getDb().prepare('SELECT * FROM role_limits ORDER BY role,provider').all(),
      userLimits: getDb().prepare('SELECT ul.*, u.email FROM user_limits ul JOIN users u ON u.id=ul.user_id ORDER BY u.email,ul.provider').all(),
    };
  });

  app.put('/admin/limits/role', async (req, reply) => {
    const actor = requireAdmin(req, reply); if (!actor) return;
    const body = z.object({ role: z.enum(['admin','founder','developer','member']), provider: z.string(), dailyUsd: z.number().nullable().optional(), dailyTokens: z.number().int().nullable().optional() }).parse(req.body);
    const before = getDb().prepare('SELECT * FROM role_limits WHERE role=? AND provider=?').get(body.role, body.provider);
    getDb().prepare(`INSERT INTO role_limits (role,provider,daily_usd,daily_tokens) VALUES (?,?,?,?) ON CONFLICT(role,provider) DO UPDATE SET daily_usd=excluded.daily_usd,daily_tokens=excluded.daily_tokens`).run(body.role, body.provider, body.dailyUsd ?? null, body.dailyTokens ?? null);
    const after = getDb().prepare('SELECT * FROM role_limits WHERE role=? AND provider=?').get(body.role, body.provider);
    audit({ actorUserId: actor.id, action: 'update_role_limit', targetType: 'role_limit', targetId: `${body.role}:${body.provider}`, before, after });
    return { ok: true, limit: after };
  });

  app.put('/admin/limits/user', async (req, reply) => {
    const actor = requireAdmin(req, reply); if (!actor) return;
    const body = z.object({ userId: z.number().int().positive(), provider: z.string(), dailyUsd: z.number().nullable().optional(), dailyTokens: z.number().int().nullable().optional() }).parse(req.body);
    const before = getDb().prepare('SELECT * FROM user_limits WHERE user_id=? AND provider=?').get(body.userId, body.provider);
    getDb().prepare(`INSERT INTO user_limits (user_id,provider,daily_usd,daily_tokens) VALUES (?,?,?,?) ON CONFLICT(user_id,provider) DO UPDATE SET daily_usd=excluded.daily_usd,daily_tokens=excluded.daily_tokens`).run(body.userId, body.provider, body.dailyUsd ?? null, body.dailyTokens ?? null);
    const after = getDb().prepare('SELECT * FROM user_limits WHERE user_id=? AND provider=?').get(body.userId, body.provider);
    audit({ actorUserId: actor.id, action: 'update_user_limit', targetType: 'user_limit', targetId: `${body.userId}:${body.provider}`, before, after });
    return { ok: true, limit: after };
  });

  // ─── Time-bounded grants ──────────────────────────────────────────────
  const GRANT_PROVIDERS = ['anthropic','openai_codex','openai','groq','cerebras','kimi','glm','gemini','openrouter','deepgram','fish','xai','runpod','serper'] as const;
  const GRANT_MAX_DURATION_MS = 30 * 24 * 3600 * 1000;

  function decorateGrant(row: any) {
    const now = Date.now();
    const active = row.valid_from <= now && row.valid_until >= now;
    const pending = row.valid_from > now;
    const expired = row.valid_until < now;
    const status = active ? 'active' : pending ? 'pending' : 'expired';
    return {
      ...row,
      active,
      status,
      expires_in_ms: expired ? 0 : Math.max(0, row.valid_until - now),
      starts_in_ms: pending ? Math.max(0, row.valid_from - now) : 0,
    };
  }

  app.get('/admin/grants', async (req, reply) => {
    const actor = requireAdmin(req, reply); if (!actor) return;
    const q = z.object({ userId: z.coerce.number().int().positive().optional(), activeOnly: z.coerce.boolean().optional() }).parse(req.query || {});
    const where: string[] = [];
    const params: any[] = [];
    if (q.userId) { where.push('g.user_id = ?'); params.push(q.userId); }
    if (q.activeOnly) { where.push('g.valid_from <= ? AND g.valid_until >= ?'); params.push(Date.now(), Date.now()); }
    const sql = `
      SELECT g.id, g.user_id, u.email, g.provider, g.model_pattern, g.daily_usd, g.daily_tokens,
             g.valid_from, g.valid_until, g.reason, g.created_by_user_id, cb.email AS created_by_email,
             g.created_at
      FROM user_grants g
      LEFT JOIN users u  ON u.id  = g.user_id
      LEFT JOIN users cb ON cb.id = g.created_by_user_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY g.valid_until DESC, g.id DESC
    `;
    const rows = getDb().prepare(sql).all(...params) as any[];
    return { grants: rows.map(decorateGrant) };
  });

  app.post('/admin/grants', async (req, reply) => {
    const actor = requireAdmin(req, reply); if (!actor) return;
    const body = z.object({
      userId: z.number().int().positive(),
      provider: z.enum(GRANT_PROVIDERS),
      modelPattern: z.string().min(1).max(120).default('*'),
      dailyUsd: z.number().nonnegative().nullable().optional(),
      dailyTokens: z.number().int().nonnegative().nullable().optional(),
      validFrom: z.number().int().nonnegative().nullable().optional(),
      validUntil: z.number().int().positive(),
      reason: z.string().max(500).nullable().optional(),
    }).parse(req.body);
    const user = tableById('users', body.userId) as any;
    if (!user) { reply.code(404).send({ error: 'User not found' }); return; }
    const now = Date.now();
    const validFrom = body.validFrom == null || body.validFrom === 0 ? now : body.validFrom;
    if (body.validUntil <= now) { reply.code(400).send({ error: 'validUntil must be in the future' }); return; }
    if (body.validUntil <= validFrom) { reply.code(400).send({ error: 'validUntil must be after validFrom' }); return; }
    if (body.validUntil - validFrom > GRANT_MAX_DURATION_MS) { reply.code(400).send({ error: 'Grant window cannot exceed 30 days' }); return; }
    const info = getDb().prepare(`
      INSERT INTO user_grants (user_id, provider, model_pattern, daily_usd, daily_tokens, valid_from, valid_until, reason, created_by_user_id)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(body.userId, body.provider, body.modelPattern, body.dailyUsd ?? null, body.dailyTokens ?? null, validFrom, body.validUntil, body.reason || null, actor.id || null);
    const row = getDb().prepare('SELECT * FROM user_grants WHERE id = ?').get(Number(info.lastInsertRowid));
    audit({ actorUserId: actor.id, action: 'create_user_grant', targetType: 'user_grant', targetId: Number(info.lastInsertRowid), after: row });
    return { id: Number(info.lastInsertRowid), grant: decorateGrant(row) };
  });

  app.patch('/admin/grants/:id', async (req, reply) => {
    const actor = requireAdmin(req, reply); if (!actor) return;
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const body = z.object({
      dailyUsd: z.number().nonnegative().nullable().optional(),
      dailyTokens: z.number().int().nonnegative().nullable().optional(),
      validUntil: z.number().int().positive().optional(),
      reason: z.string().max(500).nullable().optional(),
    }).parse(req.body);
    const before = tableById('user_grants', params.id) as any;
    if (!before) { reply.code(404).send({ error: 'Grant not found' }); return; }
    if (body.validUntil !== undefined) {
      if (body.validUntil <= Date.now()) { reply.code(400).send({ error: 'validUntil must be in the future' }); return; }
      if (body.validUntil - before.valid_from > GRANT_MAX_DURATION_MS) { reply.code(400).send({ error: 'Grant window cannot exceed 30 days' }); return; }
    }
    const map: Record<string, string> = { dailyUsd: 'daily_usd', dailyTokens: 'daily_tokens', validUntil: 'valid_until', reason: 'reason' };
    const sets: string[] = [];
    const vals: any[] = [];
    for (const [k, col] of Object.entries(map)) if ((body as any)[k] !== undefined) { sets.push(`${col} = ?`); vals.push((body as any)[k]); }
    if (sets.length) getDb().prepare(`UPDATE user_grants SET ${sets.join(', ')} WHERE id = ?`).run(...vals, params.id);
    const after = tableById('user_grants', params.id);
    audit({ actorUserId: actor.id, action: 'update_user_grant', targetType: 'user_grant', targetId: params.id, before, after });
    return { ok: true, grant: decorateGrant(after) };
  });

  app.delete('/admin/grants/:id', async (req, reply) => {
    const actor = requireAdmin(req, reply); if (!actor) return;
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const before = tableById('user_grants', params.id) as any;
    if (!before) { reply.code(404).send({ error: 'Grant not found' }); return; }
    getDb().prepare('DELETE FROM user_grants WHERE id = ?').run(params.id);
    audit({ actorUserId: actor.id, action: 'delete_user_grant', targetType: 'user_grant', targetId: params.id, before });
    return { ok: true };
  });

  app.post('/admin/test-as-user', async (req, reply) => {
    const actor = requireAdmin(req, reply); if (!actor) return;
    const body = z.object({ userId: z.number().int().positive(), provider: z.enum(['anthropic','openai_codex','openai','groq','cerebras','kimi','glm','gemini','openrouter','deepgram','fish','xai','runpod','serper']), dryRun: z.boolean().default(true), model: z.string().optional() }).parse(req.body);
    const user = getDb().prepare('SELECT id,email,role,enabled FROM users WHERE id=?').get(body.userId) as any;
    if (!user) { reply.code(404).send({ error: 'User not found' }); return; }
    const accounts = getDb().prepare('SELECT id,label,status,enabled,cooldown_until,max_in_flight FROM provider_accounts WHERE provider=? ORDER BY id').all(body.provider);
    const usage = getDb().prepare(`SELECT COUNT(*) requests, COALESCE(SUM(estimated_cost_usd),0) usd, COALESCE(SUM(input_tokens+output_tokens+cache_creation_tokens+cache_read_tokens),0) tokens FROM usage_events WHERE user_id=? AND provider=? AND created_at >= datetime('now','-1 day')`).get(body.userId, body.provider);
    const result = { dryRun: body.dryRun, user, provider: body.provider, model: body.model, accounts, usage };
    audit({ actorUserId: actor.id, action: body.dryRun ? 'dry_run_test_as_user' : 'real_test_as_user_requested', targetType: 'user', targetId: body.userId, after: result });
    return result;
  });

  app.get('/admin/usage', async (req, reply) => {
    const actor = requireAdmin(req, reply); if (!actor) return;
    const q = z.object({
      range: z.enum(['1h','24h','7d','30d','all']).default('24h'),
    }).parse(req.query as any);
    const since = q.range === 'all'
      ? "datetime('1970-01-01')"
      : q.range === '1h'  ? "datetime('now','-1 hour')"
      : q.range === '24h' ? "datetime('now','-1 day')"
      : q.range === '7d'  ? "datetime('now','-7 day')"
      :                     "datetime('now','-30 day')";
    const usage = getDb().prepare(`
      SELECT u.email,
             e.provider,
             e.model,
             e.provider_account_id,
             pa.label AS provider_account_label,
             COUNT(*) requests,
             SUM(e.input_tokens+e.output_tokens+e.cache_creation_tokens+e.cache_read_tokens) tokens,
             SUM(e.cache_read_tokens) cache_read_tokens,
             SUM(e.cache_creation_tokens) cache_creation_tokens,
             SUM(e.estimated_cost_usd) usd,
             AVG(e.latency_ms) avg_latency_ms
      FROM usage_events e
      LEFT JOIN users u ON u.id = e.user_id
      LEFT JOIN provider_accounts pa ON pa.id = e.provider_account_id
      WHERE e.created_at >= ${since}
      GROUP BY u.email, e.provider, e.model, e.provider_account_id, pa.label
      ORDER BY requests DESC
    `).all();
    return { usage, range: q.range };
  });

  app.get('/admin/usage-events', async (req, reply) => {
    const actor = requireAdmin(req, reply); if (!actor) return;
    const q = z.object({
      userId: z.coerce.number().int().positive().optional(),
      provider: z.string().optional(),
      model: z.string().optional(),
      range: z.enum(['1h','24h','7d','30d','all']).default('24h'),
      limit: z.coerce.number().int().min(1).max(500).default(100),
      onlyErrors: z.coerce.boolean().optional(),
    }).parse(req.query as any);
    const since = q.range === 'all'
      ? "datetime('1970-01-01')"
      : q.range === '1h'  ? "datetime('now','-1 hour')"
      : q.range === '24h' ? "datetime('now','-1 day')"
      : q.range === '7d'  ? "datetime('now','-7 day')"
      :                     "datetime('now','-30 day')";
    const where: string[] = [`e.created_at >= ${since}`];
    const params: any[] = [];
    if (q.userId)      { where.push('e.user_id = ?');           params.push(q.userId); }
    if (q.provider)    { where.push('e.provider = ?');          params.push(q.provider); }
    if (q.model)       { where.push('e.model = ?');             params.push(q.model); }
    if (q.onlyErrors)  { where.push('e.status_code >= 400');     }
    const events = getDb().prepare(`
      SELECT e.id, e.created_at, e.user_id, u.email, e.token_id, e.token_label,
             e.provider, e.model, e.endpoint, e.stream, e.status_code,
             e.input_tokens, e.output_tokens, e.cache_creation_tokens, e.cache_read_tokens,
             e.estimated_cost_usd, e.latency_ms, e.error,
             e.provider_account_id, e.provider_account_label,
             EXISTS(SELECT 1 FROM request_logs rl WHERE rl.usage_event_id = e.id) AS has_log
      FROM usage_events e
      LEFT JOIN users u ON u.id = e.user_id
      WHERE ${where.join(' AND ')}
      ORDER BY e.id DESC
      LIMIT ?
    `).all(...params, q.limit);
    return { events };
  });

  app.get('/admin/usage-events/:id/log', async (req, reply) => {
    const actor = requireAdmin(req, reply); if (!actor) return;
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const row = getDb().prepare('SELECT id, usage_event_id, user_id, request_json, response_text, expires_at, created_at FROM request_logs WHERE usage_event_id = ?').get(params.id) as any;
    if (!row) { reply.code(404).send({ error: 'No body log for this event (full_body_logging disabled or expired)' }); return; }
    audit({ actorUserId: actor.id, action: 'view_request_log', targetType: 'usage_event', targetId: params.id });
    let request: any = null;
    try { request = JSON.parse(row.request_json || 'null'); } catch { request = row.request_json; }
    return { id: row.id, usage_event_id: row.usage_event_id, user_id: row.user_id, request, response: row.response_text, expires_at: row.expires_at, created_at: row.created_at };
  });

  app.get('/admin/sticky-routing', async (req, reply) => {
    const actor = requireAdmin(req, reply); if (!actor) return;
    const q = z.object({
      provider: z.string().optional(),
      hours: z.coerce.number().int().min(1).max(168).default(24),
    }).parse(req.query as any);
    const where: string[] = [`e.created_at >= datetime('now','-${q.hours} hour')`, 'e.user_id IS NOT NULL', 'e.token_id IS NOT NULL', 'e.provider_account_id IS NOT NULL'];
    const params: any[] = [];
    if (q.provider) { where.push('e.provider = ?'); params.push(q.provider); }
    // For each (user_id, token_id, provider) the sticky hash assigns to ONE account if pool size is stable.
    // Count distinct accounts per session-key, anything > 1 means stickiness broke or the pool changed.
    const rows = getDb().prepare(`
      SELECT e.provider, e.user_id, u.email, e.token_id, e.token_label,
             COUNT(*) requests,
             COUNT(DISTINCT e.provider_account_id) distinct_accounts,
             GROUP_CONCAT(DISTINCT pa.label) accounts
      FROM usage_events e
      LEFT JOIN users u ON u.id = e.user_id
      LEFT JOIN provider_accounts pa ON pa.id = e.provider_account_id
      WHERE ${where.join(' AND ')}
      GROUP BY e.provider, e.user_id, e.token_id
      HAVING requests >= 2
      ORDER BY requests DESC
      LIMIT 200
    `).all(...params);
    const stable = rows.filter((r: any) => r.distinct_accounts === 1).length;
    const split = rows.filter((r: any) => r.distinct_accounts > 1).length;
    return { sessions: rows, stable, split, hours: q.hours };
  });

  app.get('/admin/audit-logs', async (req, reply) => {
    const actor = requireAdmin(req, reply); if (!actor) return;
    const rows = getDb().prepare(`
      SELECT a.id, a.actor_user_id, u.email AS actor_email, a.action, a.target_type, a.target_id,
             a.before_json, a.after_json, a.created_at
      FROM admin_audit_logs a
      LEFT JOIN users u ON u.id = a.actor_user_id
      ORDER BY a.id DESC LIMIT 200
    `).all() as any[];
    const safeParse = (s: any) => {
      if (s == null) return null;
      try { return JSON.parse(s); } catch { return s; }
    };
    return { logs: rows.map(r => ({ ...r, before: safeParse(r.before_json), after: safeParse(r.after_json) })) };
  });

  app.get('/admin/alerts', async (req, reply) => {
    const actor = requireAdmin(req, reply); if (!actor) return;
    return { alerts: getDb().prepare('SELECT * FROM alerts ORDER BY id DESC LIMIT 200').all() };
  });

  app.patch('/admin/alerts/:id', async (req, reply) => {
    const actor = requireAdmin(req, reply); if (!actor) return;
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const body = z.object({ resolved: z.boolean() }).parse(req.body);
    const before = tableById('alerts', params.id) as any;
    if (!before) { reply.code(404).send({ error: 'Alert not found' }); return; }
    if (body.resolved) {
      getDb().prepare("UPDATE alerts SET resolved = 1, resolved_at = CURRENT_TIMESTAMP WHERE id = ?").run(params.id);
    } else {
      getDb().prepare('UPDATE alerts SET resolved = 0, resolved_at = NULL WHERE id = ?').run(params.id);
    }
    const after = tableById('alerts', params.id);
    audit({ actorUserId: actor.id, action: body.resolved ? 'resolve_alert' : 'unresolve_alert', targetType: 'alert', targetId: params.id, before, after });
    return { ok: true, alert: after };
  });

  app.post('/admin/alerts/resolve-all', async (req, reply) => {
    const actor = requireAdmin(req, reply); if (!actor) return;
    const result = getDb().prepare("UPDATE alerts SET resolved = 1, resolved_at = CURRENT_TIMESTAMP WHERE resolved = 0").run();
    audit({ actorUserId: actor.id, action: 'resolve_alerts_bulk', targetType: 'alert', targetId: 'bulk', after: { count: result.changes } });
    return { ok: true, resolved: result.changes };
  });

  // ─── Headroom compression settings ──────────────────────────────────────

  app.get('/admin/headroom', async (req, reply) => {
    const actor = requireAdmin(req, reply); if (!actor) return;
    return getHeadroomSettings();
  });

  app.patch('/admin/headroom', async (req, reply) => {
    const actor = requireAdmin(req, reply); if (!actor) return;
    const body = z.object({
      enabled: z.boolean().optional(),
      skipProviders: z.array(z.string()).optional(),
    }).parse(req.body);
    const before = getHeadroomSettings();
    if (body.enabled !== undefined) {
      setAppSetting('headroom.enabled', body.enabled ? 'true' : 'false');
    }
    if (body.skipProviders !== undefined) {
      setAppSetting('headroom.skipProviders', body.skipProviders.join(','));
    }
    const after = getHeadroomSettings();
    audit({ actorUserId: actor.id, action: 'update_headroom_settings', targetType: 'settings', targetId: 'headroom', before, after });
    return { ok: true, ...after };
  });
}
