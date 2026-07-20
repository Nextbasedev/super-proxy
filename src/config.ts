import 'dotenv/config';

/** Daily-cap lookback in checkLooseLimit is `datetime('now','-1 day')`. */
export const MIN_MONITOR_RETENTION_RAW_DAYS = 1;

export function resolveMonitorRetentionRawDays(raw: string | undefined): number {
  if (raw == null || String(raw).trim() === '') return 30;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 30;
  return Math.max(MIN_MONITOR_RETENTION_RAW_DAYS, n);
}

export function resolveMonitorRetentionHourlyDays(raw: string | undefined): number {
  if (raw == null || String(raw).trim() === '') return 180;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 180;
  return Math.max(1, n);
}

export const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 8080),
  databasePath: process.env.DATABASE_PATH || './data/super-proxy.sqlite',
  adminEmail: process.env.ADMIN_EMAIL || 'admin@localhost',
  firebaseProjectId: process.env.FIREBASE_PROJECT_ID || '',
  anthropicUpstreamUrl: process.env.ANTHROPIC_UPSTREAM_URL || 'https://api.anthropic.com',
  openaiUpstreamUrl: process.env.OPENAI_UPSTREAM_URL || 'https://chatgpt.com/backend-api',
  openaiPlatformUpstreamUrl: process.env.OPENAI_PLATFORM_UPSTREAM_URL || 'https://api.openai.com/v1',
  groqUpstreamUrl: process.env.GROQ_UPSTREAM_URL || 'https://api.groq.com/openai/v1',
  cerebrasUpstreamUrl: process.env.CEREBRAS_UPSTREAM_URL || 'https://api.cerebras.ai/v1',
  kimiUpstreamUrl: process.env.KIMI_UPSTREAM_URL || 'https://api.kimi.com/coding/v1',
  glmUpstreamUrl: process.env.GLM_UPSTREAM_URL || 'https://api.z.ai/api/anthropic',
  geminiUpstreamUrl: process.env.GEMINI_UPSTREAM_URL || 'https://generativelanguage.googleapis.com/v1beta',
  openrouterUpstreamUrl: process.env.OPENROUTER_UPSTREAM_URL || 'https://openrouter.ai/api/v1',
  deepgramUpstreamUrl: process.env.DEEPGRAM_UPSTREAM_URL || 'https://api.deepgram.com/v1',
  fishUpstreamUrl: process.env.FISH_UPSTREAM_URL || 'https://api.fish.audio',
  fishMaxInFlight: Number(process.env.FISH_MAX_IN_FLIGHT || 4),
  xaiUpstreamUrl: process.env.XAI_UPSTREAM_URL || 'https://api.x.ai/v1',
  // Optional forward proxy for xAI upstream traffic only (e.g. US HTTP proxy).
  // Set to clear region gates on models like grok-4.5 when the gateway host IP
  // is in an unsupported region. Empty = direct connection.
  xaiProxyUrl: process.env.XAI_PROXY_URL || '',
  // Runpod Serverless: base URL is computed from RUNPOD_ENDPOINT_ID per-account.
  // RUNPOD_UPSTREAM_BASE_URL lets ops point at a non-default Runpod region/host.
  runpodUpstreamBaseUrl: process.env.RUNPOD_UPSTREAM_BASE_URL || 'https://api.runpod.ai/v2',
  runpodApiKey: process.env.RUNPOD_API_KEY || '',
  runpodEndpointId: process.env.RUNPOD_ENDPOINT_ID || '',
  runpodConcurrencyLimit: Number(process.env.RUNPOD_CONCURRENCY_LIMIT || 4),
  // Headroom context compression sidecar
  headroomEnabled: process.env.HEADROOM_ENABLED === 'true',
  headroomUrl: process.env.HEADROOM_URL || 'http://127.0.0.1:8899',
  headroomTimeoutMs: Number(process.env.HEADROOM_TIMEOUT_MS || 5000),
  headroomMinTokens: Number(process.env.HEADROOM_MIN_TOKENS || 500),
  headroomSkipProviders: new Set((process.env.HEADROOM_SKIP_PROVIDERS || '').split(',').map(s => s.trim()).filter(Boolean)),
  /**
   * Phase 2: route GLM stream parsing through the normalized event adapter.
   * DEFAULT FALSE — when off, `src/proxy/glm.ts` keeps the pre-Phase-2 path
   * (absorbSseUsage + sawCompletion). When true, usage + terminal classification
   * come from `src/normalize/glm.ts` with billing-parity guarantees.
   */
  normalizeGlm: process.env.NORMALIZE_GLM === 'true',
  /**
   * Phase 3: route Kimi stream parsing through the normalized event adapter.
   * DEFAULT FALSE — when off, `src/proxy/kimi.ts` keeps the pre-Phase-3 path
   * (absorbSseUsage + sawCompletion). When true, usage + terminal classification
   * come from `src/normalize/kimi.ts` with billing-parity guarantees (esp. cacheRead).
   */
  normalizeKimi: process.env.NORMALIZE_KIMI === 'true',
  /**
   * Kimi context caching: forward a `prompt_cache_key` to the Moonshot/Kimi
   * upstream so the Kimi Code Plan can associate successive requests in the
   * same coding session and serve a cached prompt prefix.
   *
   * Per Kimi docs (api/chat `prompt_cache_key`): "Used to cache responses for
   * similar requests to optimize cache hit rates. Coding Agents: typically a
   * session id / task id representing a single session; if the session is
   * exited and later resumed, the value should remain the same. For the Kimi
   * Code Plan, this field is REQUIRED to improve cache hit rates." We already
   * derive a conversation id from client headers but historically dropped it
   * before the upstream call, so cache hits were ~1%.
   *
   * DEFAULT TRUE — the field is additive (a documented request param) and does
   * not change response/billing semantics; it only lets upstream caching
   * engage. Set KIMI_FORWARD_CACHE_KEY=false to fall back to the pre-fix shape.
   */
  kimiForwardCacheKey: (process.env.KIMI_FORWARD_CACHE_KEY ?? 'true') === 'true',
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
  openaiCodexClientId: process.env.OPENAI_CODEX_CLIENT_ID || '',
  requestLogRetentionDays: Number(process.env.REQUEST_LOG_RETENTION_DAYS || 30),
  // Monitoring rollups & retention (docs/MONITORING-SYSTEM.md §4)
  monitorRetentionEnabled: (process.env.MONITOR_RETENTION_ENABLED ?? 'false') === 'true',
  // Floor = daily-cap lookback in checkLooseLimit (`datetime('now','-1 day')`).
  // Never allow raw retention shorter than that window or NaN from bad env.
  monitorRetentionRawDays: resolveMonitorRetentionRawDays(process.env.MONITOR_RETENTION_RAW_DAYS),
  monitorRetentionHourlyDays: resolveMonitorRetentionHourlyDays(process.env.MONITOR_RETENTION_HOURLY_DAYS),
  // Emails allowed READ-ONLY access to /admin/metrics/* via their API token
  // (monitor role, below root admin). Comma-separated, case-insensitive.
  monitorAccessEmails: new Set((process.env.MONITOR_ACCESS_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)),
  // Phase 4 alerting (docs/MONITORING-SYSTEM.md §6). Dedicated webhook — NEVER
  // hardcode the URL; warn = silent embed, critical = ping MONITOR_PING ids.
  monitorWebhookUrl: process.env.DISCORD_MONITOR_WEBHOOK || '',
  monitorPingDiscordIds: (process.env.MONITOR_PING_DISCORD_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
  // Metered daily budget (USD). 0/absent = daily_budget rule disabled until a
  // budget is confirmed via monitor_meta (dashboard suggestion flow).
  monitorDailyBudgetUsd: Number(process.env.MONITOR_DAILY_BUDGET_USD || 0) || 0,
  firebaseWebConfig: process.env.FIREBASE_WEB_CONFIG || '',
  globalAnthropicMaxInFlight: Number(process.env.ANTHROPIC_MAX_IN_FLIGHT || 10),
  // Default-off, explicit cross-provider capacity fallback. The target model is
  // validated against the GLM allowlist before any internal relay is attempted.
  crossProviderFallbackEnabled: process.env.CROSS_PROVIDER_FALLBACK_ENABLED === 'true',
  crossProviderFallbackAnthropicToGlmModel: process.env.CROSS_PROVIDER_FALLBACK_ANTHROPIC_TO_GLM_MODEL || '',
};
