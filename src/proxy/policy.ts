import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { alert } from '../utils/alerts.js';
import { findCatalogModel, isKnownModel } from '../providers/model-catalog.js';

export function isFounder(role: string): boolean {
  return role === 'founder' || role === 'admin';
}

export interface ActiveGrant {
  id: number;
  user_id: number;
  provider: string;
  model_pattern: string | null;
  daily_usd: number | null;
  daily_tokens: number | null;
  valid_from: number;
  valid_until: number;
}

/**
 * Return the best active grant for (user, provider, model), or null. "Best" =
 * an exact `model_pattern` match wins over a wildcard `*`/NULL match; among
 * ties the row with the latest `valid_until` wins (most recently extended
 * grant). The caller treats a non-null result as the cap source for this call.
 */
export function findActiveGrant(
  userId: number,
  provider: string,
  model?: string,
  now: number = Date.now(),
): ActiveGrant | null {
  const rows = getDb().prepare(`
    SELECT id, user_id, provider, model_pattern, daily_usd, daily_tokens, valid_from, valid_until
    FROM user_grants
    WHERE user_id = ? AND provider = ?
      AND valid_from <= ? AND valid_until >= ?
    ORDER BY valid_until DESC, id DESC
  `).all(userId, provider, now, now) as ActiveGrant[];
  if (!rows.length) return null;
  if (model) {
    const exact = rows.find((r) => r.model_pattern && r.model_pattern !== '*' && r.model_pattern === model);
    if (exact) return exact;
  }
  // Wildcard / null pattern is a catch-all that allows any model for this provider.
  const wild = rows.find((r) => !r.model_pattern || r.model_pattern === '*');
  if (wild) return wild;
  // If only exact-model rows exist for other models, the user has no grant for
  // this specific model. Return null — the normal policy ladder applies.
  return null;
}


export type ProviderAccessMode = 'allow_all' | 'custom' | 'deny_all';

const PUBLIC_DEFAULT_MODELS: Record<string, Set<string>> = {
  // Free/fair-use OpenRouter model exposed to all users without enabling the
  // rest of OpenRouter by default. Explicit provider/model denies still win.
  openrouter: new Set(['tencent/hy3:free']),
};

/**
 * Computes the effective provider access mode for a user, using the exact same
 * fallback logic as request-time enforcement. Used both by the proxy policy
 * checks and by the admin API so the dashboard cannot disagree with the
 * gateway about whether a provider is enabled for a user.
 */
export function getEffectiveProviderMode(
  user: { id: number; role: string; isAdmin?: boolean },
  provider: string,
): ProviderAccessMode {
  const modeRow = getDb().prepare('SELECT mode FROM user_provider_access_modes WHERE user_id = ? AND provider = ?')
    .get(user.id, provider) as { mode?: ProviderAccessMode } | undefined;
  if (modeRow?.mode) return modeRow.mode;
  const nonAdminDefaultOff = !user.isAdmin && user.role !== 'admin' && provider !== 'openai_codex';
  return nonAdminDefaultOff ? 'deny_all' : 'allow_all';
}

export function isModelAllowedForUser(
  user: { id: number; role: string; isAdmin?: boolean },
  provider: string,
  model: string | undefined,
): { ok: true } | { ok: false; message: string } {
  if (!model || !model.trim()) return { ok: true };
  const explicitModeRow = getDb().prepare('SELECT mode FROM user_provider_access_modes WHERE user_id = ? AND provider = ?')
    .get(user.id, provider) as { mode?: ProviderAccessMode } | undefined;
  const explicitMode = explicitModeRow?.mode;
  if (explicitMode === 'deny_all') return { ok: false, message: `Provider ${provider} is not allowed for this user` };

  const denied = getDb().prepare('SELECT 1 FROM user_model_denies WHERE user_id = ? AND provider = ? AND model = ?')
    .get(user.id, provider, model);
  if (denied) {
    const grant = findActiveGrant(user.id, provider, model);
    if (grant?.model_pattern === model) return { ok: true };
    return { ok: false, message: `Model ${model} is not allowed for this user` };
  }

  if (PUBLIC_DEFAULT_MODELS[provider]?.has(model)) return { ok: true };

  const mode = explicitMode ?? getEffectiveProviderMode(user, provider);
  if (mode === 'deny_all') return { ok: false, message: `Provider ${provider} is not allowed for this user` };

  if (mode === 'custom' && !isKnownModel(provider, model)) {
    return { ok: false, message: `Model ${model} is not allowed for this user` };
  }
  return { ok: true };
}

export type EffectiveModelAuthorization =
  | { ok: true; effectiveModel: string }
  | { ok: false; message: string };

/**
 * Authorize both a known catalog alias and the runtime model it resolves to.
 * For unknown-model proxy fallbacks, callers pass the already-resolved default
 * as `unknownFallbackModel`; only that effective default is authorized, which
 * preserves the historical unknown-model fallback policy.
 */
export function authorizeEffectiveModelForUser(
  user: { id: number; role: string; isAdmin?: boolean },
  provider: string,
  requestedModel: string,
  unknownFallbackModel: string = requestedModel,
): EffectiveModelAuthorization {
  const catalogEntry = findCatalogModel(provider, requestedModel);
  if (!catalogEntry) {
    const allowed = isModelAllowedForUser(user, provider, unknownFallbackModel);
    return allowed.ok ? { ok: true, effectiveModel: unknownFallbackModel } : allowed;
  }

  const requestedAllowed = isModelAllowedForUser(user, provider, requestedModel);
  if (!requestedAllowed.ok) return requestedAllowed;

  const effectiveModel = catalogEntry.direct_runtime_support
    ? requestedModel
    : catalogEntry.runtime_model || requestedModel;
  if (effectiveModel !== requestedModel) {
    const effectiveAllowed = isModelAllowedForUser(user, provider, effectiveModel);
    if (!effectiveAllowed.ok) return effectiveAllowed;
  }
  return { ok: true, effectiveModel };
}

export function shouldLogBody(user: { role: string; id: number }): boolean {
  // Explicit per-user `full_body_logging=1` always wins (privacy default for
  // founders/admins is off, but an admin who explicitly enables logging on
  // their own row clearly wants the data captured for diagnostics).
  const row = getDb().prepare('SELECT full_body_logging FROM users WHERE id = ?').get(user.id) as any;
  if (row?.full_body_logging) return true;
  if (isFounder(user.role)) return false;
  return false;
}

export function logRequestResponse(input: { usageEventId: number; userId: number; requestBody: unknown; responseText: string }) {
  const expires = new Date(Date.now() + config.requestLogRetentionDays * 24 * 3600_000).toISOString();
  try {
    getDb().prepare('INSERT INTO request_logs (usage_event_id,user_id,request_json,response_text,expires_at) VALUES (?,?,?,?,?)')
      .run(input.usageEventId, input.userId, JSON.stringify(redact(input.requestBody)), redactText(input.responseText), expires);
  } catch (err) {
    void alert('error', 'request_logging_failed', 'Request/response logging failed', { userId: input.userId, usageEventId: input.usageEventId, error: String(err) });
  }
}

export function checkLooseLimit(
  user: { id: number; role: string },
  provider: string,
  token?: { id: number },
  model?: string,
): { ok: true } | { ok: false; message: string } {
  // Token-level caps apply to everyone (including admin/founder) because they're
  // explicit per-token guardrails. User/role caps still skip for admin/founder.
  // Token caps even override a generous grant (explicit guardrail).
  if (token?.id) {
    const t = getDb().prepare('SELECT cap_usd_daily, cap_tokens_daily FROM api_tokens WHERE id = ?').get(token.id) as any;
    if (t?.cap_usd_daily || t?.cap_tokens_daily) {
      const usedT = getDb().prepare(`
        SELECT COALESCE(SUM(estimated_cost_usd),0) usd,
               COALESCE(SUM(input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens),0) tokens
        FROM usage_events
        WHERE token_id = ? AND provider = ? AND created_at >= datetime('now','-1 day')
      `).get(token.id, provider) as any;
      if (t.cap_usd_daily && usedT.usd >= t.cap_usd_daily) return { ok: false, message: `Token-level daily $ cap reached for ${provider}` };
      if (t.cap_tokens_daily && usedT.tokens >= t.cap_tokens_daily) return { ok: false, message: `Token-level daily token cap reached for ${provider}` };
    }
  }

  // Time-bounded grant override. If an active grant matches (user, provider,
  // model), its caps replace the user/role ladder for this call. NULL grant
  // caps mean "unlimited for this provider/model" (still bounded by the
  // token-level cap above). Founders/admins continue to bypass user/role
  // caps; if they happen to have a grant, the grant’s caps still apply (a
  // founder wouldn’t normally have a grant, but the semantics are consistent).
  const grant = findActiveGrant(user.id, provider, model);
  if (grant) {
    if (grant.daily_usd == null && grant.daily_tokens == null) return { ok: true };
    const used = getDb().prepare(`
      SELECT COALESCE(SUM(estimated_cost_usd),0) usd,
             COALESCE(SUM(input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens),0) tokens
      FROM usage_events
      WHERE user_id = ? AND provider = ? AND created_at >= datetime('now','-1 day')
    `).get(user.id, provider) as any;
    if (grant.daily_usd != null && used.usd >= grant.daily_usd) return { ok: false, message: `Grant daily $ cap reached for ${provider}` };
    if (grant.daily_tokens != null && used.tokens >= grant.daily_tokens) return { ok: false, message: `Grant daily token cap reached for ${provider}` };
    return { ok: true };
  }

  if (isFounder(user.role)) return { ok: true };
  const limit = getDb().prepare(`
    SELECT COALESCE(ul.daily_usd, rl.daily_usd) daily_usd, COALESCE(ul.daily_tokens, rl.daily_tokens) daily_tokens
    FROM users u
    LEFT JOIN user_limits ul ON ul.user_id = u.id AND ul.provider = ?
    LEFT JOIN role_limits rl ON rl.role = u.role AND rl.provider = ?
    WHERE u.id = ?
  `).get(provider, provider, user.id) as any;
  if (!limit?.daily_usd && !limit?.daily_tokens) return { ok: true };
  const used = getDb().prepare(`
    SELECT COALESCE(SUM(estimated_cost_usd),0) usd, COALESCE(SUM(input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens),0) tokens
    FROM usage_events
    WHERE user_id = ? AND provider = ? AND created_at >= datetime('now','-1 day')
  `).get(user.id, provider) as any;
  if (limit.daily_usd && used.usd >= limit.daily_usd) return { ok: false, message: `Daily ${provider} cost limit reached` };
  if (limit.daily_tokens && used.tokens >= limit.daily_tokens) return { ok: false, message: `Daily ${provider} token limit reached` };
  return { ok: true };
}

// Keys whose VALUES are likely secrets (case-insensitive exact-ish match).
// We deliberately do NOT match every key containing the substring "token"
// because legit JSON-schema/config fields (e.g. `max_tokens`, `tokenCap`,
// `pageToken`, `maxTokens`, `gatewayToken` property schemas) carry numbers
// or schema objects, not secrets. Redacting those corrupts the logged body
// and makes the replay/audit useless.
const SECRET_KEY_RE = /^(authorization|api[_-]?key|x[_-]api[_-]key|access[_-]?token|refresh[_-]?token|bearer|password|secret|client[_-]?secret|x[_-]admin[_-]key|x[_-]anthropic[_-]key|x[_-]gateway[_-]token|nbmg[_-]?token)$/i;

function looksLikeSecret(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return /^(?:sk-ant-|nbmg_|Bearer\s+|sk-[A-Za-z0-9]{20,})/.test(value);
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k)) {
        // Only redact when the value is actually a string. Schema objects with
        // these exact names are rare; if encountered, preserve structure.
        out[k] = typeof v === 'string' ? '[REDACTED]' : redact(v);
      } else if (looksLikeSecret(v)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redact(v);
      }
    }
    return out;
  }
  if (typeof value === 'string') return redactText(value);
  return value;
}

function redactText(text: string): string {
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, '[REDACTED_ANTHROPIC_KEY]')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/nbmg_[A-Za-z0-9_-]+/g, '[REDACTED_PROXY_TOKEN]');
}

export function enforceAfterUsage(
  user: { id: number; role: string },
  provider: string,
  token?: { id: number },
  model?: string,
): void {
  const state = checkLooseLimit(user, provider, token, model);
  if (state.ok) return;
  void alert('warn', 'user_limit_exceeded', state.message, { userId: user.id, tokenId: token?.id, provider, model });
}
