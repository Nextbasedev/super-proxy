# Super Proxy Monitoring System — Implementation Doc

Status: **draft / not implemented**
Branch: `feat/monitoring-system`
Author: Alan (2026-07-09)

Full observability layer for the Super Proxy: cache efficiency, token/cost
accounting, reliability, and saturation — built on the existing `usage_events` pipeline,
surfaced in the existing admin console, alerted via the existing Discord webhook.
**No new infrastructure** (no Prometheus/Grafana): SQLite rollups + admin API + console tab.

---

## 1. Current State (audited 2026-07-09)

### 1.1 What already exists

- **`usage_events` table** (`src/db/migrate.ts`): one row per request with
  `provider, endpoint, model, stream, status_code, input_tokens, output_tokens,
  cache_creation_tokens, cache_read_tokens, estimated_cost_usd, latency_ms, error,
  token_label, provider_account_label` + headroom compression columns
  (`tokens_before_compression, tokens_saved_compression, compression_ms, compression_status`).
- **`recordUsage()`** (`src/proxy/usage.ts`): single insert point, called by every proxy.
- **Cost estimation** (`src/proxy/cost.ts`): per-model retail prices incl. cache write/read
  rates for Anthropic-class models and Kimi; xAI media/TTS/STT deterministic estimates.
  Kimi + Codex costs are **notional** (flat-fee subscriptions), not billed spend.
- **Admin endpoints**: `/admin/usage` (grouped aggregate), `/admin/usage-events` (paged raw),
  `/admin/usage-events/:id/log`.
- **Governor** (`src/providers/governor.ts`): in-memory per-account in-flight counts,
  cooldowns, recent token/cost window; exposes a live snapshot for the admin UI.
- **`provider_health_events` table**: account status transitions with reason.
- **`alerts` table + `alert()`** (`src/utils/alerts.ts`): Discord webhook
  (`DISCORD_WEBHOOK_URL`) + DB row.

### 1.2 Provider data matrix (what each proxy actually parses today)

| Provider | Input/Output | Cache write | Cache read | Reasoning tokens | Notes |
|---|---|---|---|---|---|
| anthropic | ✅ | ✅ `cache_creation_input_tokens` | ✅ `cache_read_input_tokens` | n/a (in output) | Gold standard |
| openai_codex / openai | ✅ | n/a (implicit caching) | ✅ `input_tokens_details.cached_tokens` | ❌ `output_tokens_details.reasoning_tokens` dropped | Responses API |
| groq | ✅ | n/a | ✅ `input_tokens_details.cached_tokens` | ❌ | OpenAI-compat |
| cerebras | ✅ | n/a | ✅ same | ❌ | OpenAI-compat |
| openrouter | ✅ | n/a | ✅ same | ❌ | OpenAI-compat |
| xai | ✅ | n/a | ✅ + `prompt_tokens_details.cached_tokens` fallback | ❌ `completion_tokens_details.reasoning_tokens` dropped | Chat; media uses price estimates |
| kimi | ✅ | ✅ Anthropic-style | ✅ both styles | ❌ | Flat-fee → notional cost |
| glm | ✅ | ✅ Anthropic-style | ✅ both styles | ❌ | |
| runpod | ✅ | ✅ Anthropic-style | ✅ both styles | ❌ | Self-hosted |
| gemini | ✅ `promptTokenCount`/`candidatesTokenCount` | n/a | ❌ **`cachedContentTokenCount` dropped** | ❌ **`thoughtsTokenCount` dropped** | Biggest gap |
| gemini-live | ✅ per session | ❌ | ❌ | ❌ | WebSocket |
| deepgram | ⚠️ audio **seconds** stored in `input_tokens` | n/a | n/a | n/a | Unit mismatch |
| fish | ⚠️ **char count** stored in `input_tokens` | n/a | n/a | n/a | Unit mismatch |
| fusion | ✅ aggregated from sub-calls | ❌ | ❌ | ❌ | Virtual provider |

### 1.3 Gaps (data we can get but currently throw away)

1. **Gemini cache tokens** — `usageMetadata.cachedContentTokenCount` → cache hit rate for
   Gemini is invisible.
2. **Reasoning tokens** — OpenAI `output_tokens_details.reasoning_tokens`, Gemini
   `thoughtsTokenCount`, xAI `completion_tokens_details.reasoning_tokens`. Billed as output;
   cost attribution is blind to how much of "output" is thinking.
3. **Time-to-first-token (TTFT)** — never measured on streams; only total `latency_ms`.
4. **Retry/fallback visibility** — pool rotation retries (e.g. codex encrypted-reasoning
   strip-and-retry) and fusion reroutes are not recorded as countable events.
5. **Unit mismatch** — deepgram seconds / fish chars in `input_tokens` pollute token sums.
6. **No rollups** — every dashboard query scans raw `usage_events`; degrades as table grows.
7. **No retention policy** — `usage_events` grows forever.
8. **No threshold alerting** on usage metrics (cost spikes, error spikes, cache collapse).

---

## 2. Design Overview

Four phases, each independently shippable:

```
Phase 1  Instrumentation   — capture the missing fields at recordUsage() time
Phase 2  Rollups+Retention — hourly/daily aggregate tables + pruning
Phase 3  Admin API + UI    — /admin/metrics/* endpoints + "Monitoring" console tab
Phase 4  Alerting          — threshold rules engine → Discord + alerts table
```

Principles:

- **One insert point stays one insert point.** All new fields flow through `recordUsage()`.
- **Deterministic aggregation, no sampling.** SQLite handles our volume fine with rollups.
- **Separate notional vs real spend.** A provider→billing-mode map keeps dashboards honest.
- **Additive schema only.** `addColumn()` migrations; no rewrites of `usage_events`.

---

## 3. Phase 1 — Instrumentation

### 3.1 Schema: new `usage_events` columns (all nullable, additive)

```ts
// src/db/migrate.ts — migration 2026070901
addColumn('usage_events', 'reasoning_tokens', 'INTEGER');   // subset of output_tokens
addColumn('usage_events', 'ttft_ms', 'INTEGER');            // time to first upstream byte/chunk
addColumn('usage_events', 'retry_count', 'INTEGER');        // upstream attempts - 1
addColumn('usage_events', 'retry_reason', 'TEXT');          // 'rate_limited' | 'stale_reasoning' | 'account_rotation' | ...
addColumn('usage_events', 'unit', 'TEXT');                  // NULL='tokens' | 'seconds' | 'chars' | 'images' | 'videos'
addColumn('usage_events', 'billing_mode', 'TEXT');          // NULL='metered' | 'flat_fee' | 'self_hosted' | 'free_tier'
```

Also add covering indexes (rollup + dashboard queries):

```sql
CREATE INDEX IF NOT EXISTS idx_usage_events_created ON usage_events(created_at);
CREATE INDEX IF NOT EXISTS idx_usage_events_provider_created ON usage_events(provider, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_events_user_created ON usage_events(user_id, created_at);
```

### 3.2 `recordUsage()` input extensions

```ts
reasoningTokens?: number;
ttftMs?: number;
retryCount?: number;
retryReason?: string;
unit?: 'tokens' | 'seconds' | 'chars' | 'images' | 'videos';
billingMode?: 'metered' | 'flat_fee' | 'self_hosted' | 'free_tier';
```

`billingMode` is derived centrally in `recordUsage()` from a static map (callers can
override):

```ts
const BILLING_MODE: Record<string, string> = {
  anthropic: 'flat_fee',       // Claude Code subscription accounts
  openai_codex: 'flat_fee',    // ChatGPT-plan pool accounts
  kimi: 'flat_fee',            // Kimi coding subscription
  glm: 'flat_fee',             // z.ai GLM Coding Plan
  xai: 'flat_fee',             // subscription accounts (confirmed by Yash)
  runpod: 'self_hosted',       // pod-hour cost, not per-token
  fish: 'free_tier',
  // metered (real $): gemini, openrouter, groq, cerebras, deepgram, openai (API)
};
```

**Consequence:** almost all heavy chat traffic is subscription. "Cost" for those providers
means **notional retail value** (what the subscription absorbed) + **subscription
utilization** (are accounts near plan limits — cooldown/429 frequency per flat-fee
account). Real-dollar budget alerts apply ONLY to metered providers.

```ts
```

### 3.3 Per-proxy extraction changes

- **gemini.ts / gemini-live.ts**: capture `usageMetadata.cachedContentTokenCount` →
  `cacheReadTokens`; `usageMetadata.thoughtsTokenCount` → `reasoningTokens`. Note: Gemini's
  `promptTokenCount` **includes** cached tokens — record `inputTokens = promptTokenCount -
  cachedContentTokenCount` so column semantics match Anthropic/OpenAI (input = uncached).
  Update Gemini cost estimation to price cached tokens at the cached rate.
- **openai.ts**: capture `output_tokens_details.reasoning_tokens` (Responses API) and
  `completion_tokens_details.reasoning_tokens` (chat-compat) → `reasoningTokens`.
  Pass `retryCount/retryReason` from the existing strip-stale-reasoning retry path and
  account-rotation loops.
- **xai.ts**: capture `completion_tokens_details.reasoning_tokens`. Media endpoints set
  `unit: 'images' | 'videos' | 'seconds' | 'chars'` as appropriate.
- **groq/cerebras/openrouter/kimi/glm/runpod**: opportunistically read
  `completion_tokens_details.reasoning_tokens` (harmless if absent).
- **deepgram.ts**: set `unit: 'seconds'`. **fish.ts**: set `unit: 'chars'`.
  (Values stay in `input_tokens` for cap compatibility — the `unit` column lets the
  monitoring layer exclude them from token sums.)
- **All streaming paths**: record `ttftMs` = time from upstream fetch dispatch to first
  received chunk (streams) or full-body receipt (non-stream ≈ latency). One shared helper:

```ts
// src/proxy/ttft.ts
export function ttftTracker(started: number) {
  let ttft: number | undefined;
  return { mark: () => { if (ttft === undefined) ttft = Date.now() - started; },
           get: () => ttft };
}
```

Call `mark()` on the first chunk in each proxy's existing SSE pump — every proxy already
has exactly one such loop.

### 3.4 Fusion attribution

Fusion sub-calls already record their own usage rows via the underlying provider proxies
(with `parent_usage_event_id` linkage where present). Add `retry_count`/`retry_reason` when
fusion falls back from its primary candidate so reroutes are countable.

---

## 4. Phase 2 — Rollups & Retention

### 4.1 `usage_rollup_hourly` table

```sql
CREATE TABLE IF NOT EXISTS usage_rollup_hourly (
  bucket TEXT NOT NULL,              -- '2026-07-09T14' (UTC hour)
  provider TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  user_id INTEGER,                   -- NULL row = all users (pre-aggregated)
  billing_mode TEXT NOT NULL DEFAULT 'metered',
  requests INTEGER NOT NULL DEFAULT 0,
  errors_4xx INTEGER NOT NULL DEFAULT 0,
  errors_429 INTEGER NOT NULL DEFAULT 0,
  errors_5xx INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  tokens_saved_compression INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  cache_saved_usd REAL NOT NULL DEFAULT 0,   -- see 4.3
  latency_ms_sum INTEGER NOT NULL DEFAULT 0, -- for mean
  latency_ms_p50 INTEGER,                    -- computed from raw at rollup time
  latency_ms_p95 INTEGER,
  ttft_ms_p50 INTEGER,
  ttft_ms_p95 INTEGER,
  retry_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, provider, model, user_id, billing_mode)
);
CREATE TABLE IF NOT EXISTS usage_rollup_daily ( /* same shape, bucket='2026-07-09' */ );
```

Percentiles are exact (sorted scan of the hour's raw rows at rollup time) — cheap at our
volume, impossible to reconstruct later once raw rows are pruned, hence stored.

### 4.2 Rollup job

`src/monitoring/rollup.ts`, `setInterval` in `server.ts` (like existing background loops):

- Every **5 min**: upsert the current + previous hour buckets from raw
  `usage_events` (idempotent `INSERT ... ON CONFLICT DO UPDATE` full-recompute per bucket —
  no incremental drift).
- Every **hour**: recompute today + yesterday daily buckets from hourly.
- Excludes non-token units from token columns (`unit IS NULL OR unit='tokens'`); non-token
  usage still counts in `requests`/`errors`/`cost`.
- Guard with a simple in-process mutex; skip if previous run still active.

### 4.3 Cache savings computation

At rollup time, per provider/model:

```
would_have_paid = cache_read_tokens × input_price
actually_paid   = cache_read_tokens × cache_read_price   (0 where provider gives free caching)
cache_saved_usd = would_have_paid − actually_paid − (cache_creation_tokens × (cache_write_price − input_price))
```

Uses the price tables in `src/proxy/cost.ts` (export a `getRates(provider, model)` helper
so rollup and per-request estimation share one source of truth). For flat-fee providers
this is notional, flagged by `billing_mode`.

### 4.4 Retention

Config (env-overridable, defaults):

```ts
retentionRawDays: 30,       // usage_events rows older than this are deleted
retentionHourlyDays: 180,   // hourly rollups
                            // daily rollups kept forever
```

Daily prune job (same interval loop): `DELETE FROM usage_events WHERE created_at <
datetime('now', '-30 days')` in batches of 5 000 (avoid long write locks). `request_logs`
already expire via `expires_at` — prune loop enforces it too if not already enforced.
**Rule:** a bucket is only prunable after its hourly + daily rollups are written (prune
cutoff must trail rollup high-water mark).

---

## 5. Phase 3 — Admin API & Console UI

### 5.1 Endpoints (all admin-authed, same pattern as existing `/admin/*`)

```
GET /admin/metrics/overview?range=24h|7d|30d
  → totals: requests, tokens (by class), cost (metered vs notional split),
    cache hit rate, cache $ saved, compression $ saved, error rate, avg/p95 latency & TTFT,
    retry count; plus per-provider breakdown rows.

GET /admin/metrics/timeseries?metric=<name>&range=…&interval=hour|day&provider=&model=&userId=
  → [{bucket, value}] for charting. Metrics: requests, tokens_in, tokens_out,
    reasoning_tokens, cache_hit_rate, cache_saved_usd, cost_usd, error_rate,
    latency_p50/p95, ttft_p50/p95, retries, compression_saved.

GET /admin/metrics/cache?range=…
  → per provider/model: hit rate, read/write ratio, $ saved, trend vs previous period.

GET /admin/metrics/top?dimension=user|model|token|account&by=cost|tokens|requests|errors&range=…&limit=10

GET /admin/metrics/reliability?range=…
  → error breakdown by class (429/4xx/5xx) per provider, retry counts by reason,
    pool snapshot (active vs cooldown accounts — joins governor snapshot +
    provider_accounts), recent provider_health_events.

GET /admin/metrics/burn?month=YYYY-MM
  → month-to-date metered spend, per-provider, linear projection to month end.
```

Range→source selection: `24h` → hourly rollups, `7d/30d` → daily (+today's hourly).
Current partial hour served from raw `usage_events` (cheap: indexed, small window).

### 5.2 Console tab

New "Monitoring" tab in `public/index.html` / `console.js` (follow the existing tab
pattern; no build step — plain JS):

- **Overview cards**: cost today (metered/notional split), tokens today, cache hit rate,
  error rate, active pool accounts — each with 7-day sparkline.
- **Charts** (existing chart approach in console; otherwise inline SVG sparklines —
  no new deps): cost/day stacked by provider; cache hit rate/day per provider;
  latency & TTFT p95 per provider; error rate with 429 overlay.
- **Cache panel**: per provider/model table — hit %, read/write ratio, $ saved.
- **Top-N panel**: dimension selector (user/model/token/account) × metric selector.
- **Reliability panel**: error classes, retries by reason, pool health,
  recent health events.

### 5.3 Serialization notes

- All money as USD floats rounded to 6 dp (matches `roundUsd`).
- Notional cost NEVER summed with metered in a single number anywhere in API responses —
  always `{metered, notional, selfHosted}` objects. UI may show a combined "equivalent
  value" figure, explicitly labeled.

---

## 6. Phase 4 — Alerting

### 6.1 Rules engine

`src/monitoring/alert-rules.ts`, evaluated every 5 min after rollup, using rollup + raw
data. Rules are code (deterministic thresholds), config-overridable via env:

| Rule | Default trigger | Cooldown |
|---|---|---|
| `cost_spike` | metered spend last 1h > 3× avg of same hour over prior 7 days AND > $5 | 6h per provider |
| `daily_budget` | metered spend today > `MONITOR_DAILY_BUDGET_USD` (default $100) crossing 80%/100% | once per threshold/day |
| `error_spike` | provider error rate (5xx+429) > 20% over last 15 min with ≥ 20 requests | 1h per provider |
| `rate_limit_pressure` | 429 share > 10% over last hour with ≥ 30 requests | 2h per provider |
| `cache_collapse` | provider cache hit rate < 50% of its 7-day avg with ≥ 100k input tokens/h | 6h per provider |
| `latency_degraded` | p95 latency last 15 min > 2.5× 7-day p95, ≥ 20 requests | 1h per provider |
| `pool_low` | active accounts ≤ 1 for a provider with >0 traffic in last 24h | 6h per provider |
| `rollup_stalled` | newest hourly bucket older than 2h | 6h global |

### 6.2 Delivery

Reuse `alert(level, type, message, metadata)` (`src/utils/alerts.ts`) → Discord webhook +
`alerts` table row. Cooldown state in a small `alert_cooldowns` table
(`rule, scope, last_fired_at`) so restarts don't re-spam. Severity: `warn` for pressure
rules, `error` for budget-100%, error_spike, pool_low, rollup_stalled.

---

## 7. File Plan

```
src/db/migrate.ts                      ~ add columns + indexes + 3 tables (rollup×2, alert_cooldowns)
src/proxy/usage.ts                     ~ extend recordUsage() input + insert + billing-mode map
src/proxy/ttft.ts                      + shared TTFT tracker helper
src/proxy/cost.ts                      ~ export getRates(provider, model) for rollup reuse
src/proxy/gemini.ts, gemini-live.ts    ~ cache + thoughts token extraction, cost fix
src/proxy/openai.ts                    ~ reasoning tokens, retry count/reason plumb-through
src/proxy/xai.ts                       ~ reasoning tokens, media units
src/proxy/{groq,cerebras,openrouter,kimi,glm,runpod}.ts  ~ reasoning tokens (opportunistic), TTFT
src/proxy/{deepgram,fish}.ts           ~ unit column
src/proxy/fusion.ts                    ~ fallback retry attribution
src/monitoring/rollup.ts               + rollup + retention jobs
src/monitoring/alert-rules.ts          + threshold rules engine
src/monitoring/metrics-api.ts          + /admin/metrics/* endpoints (registered from admin-api.ts)
src/server.ts                          ~ start rollup/alert interval loops
src/config.ts                          ~ retention + budget + threshold env knobs
public/index.html, console.js          ~ Monitoring tab
src/monitoring.test.ts                 + rollup math, cache-savings calc, percentiles, retention guard
src/alert-rules.test.ts                + each rule: fire / no-fire / cooldown cases
```

## 8. Testing Strategy

- **Unit**: rollup aggregation math (incl. idempotent re-run), cache-savings formula per
  provider pricing shape, percentile computation, unit-exclusion (deepgram seconds / fish
  chars never pollute token sums), billing-mode derivation, retention high-water-mark guard.
- **Per-proxy extraction**: extend existing provider test files (`src/gemini.test.ts`,
  `src/openai.test.ts`, `src/xai.test.ts`, …) with fixtures containing
  `cachedContentTokenCount`, `thoughtsTokenCount`, `reasoning_tokens` details — assert the
  recorded row fields. Streaming fixtures assert `ttft_ms` is set and < `latency_ms`.
- **Alert rules**: table-driven fire / no-fire / cooldown-respected cases per rule with a
  seeded in-memory DB.
- **API**: response-shape tests for each `/admin/metrics/*` endpoint incl. the
  metered/notional split invariant (never summed together).
- Full existing suite must stay green (`npm test`).

## 9. Rollout Plan

1. **PR 1 — Phase 1 (instrumentation)**: schema columns + recordUsage + proxy extraction +
   TTFT. Zero behavior change for clients; new columns simply start filling. Deploy, let
   real data accumulate for a day, sanity-check values in sqlite before building on top.
2. **PR 2 — Phase 2 (rollups + retention)**: ship rollup job with retention **disabled by
   default** (`MONITOR_RETENTION_ENABLED=false`); verify rollup numbers match ad-hoc raw
   queries for a few days, then flip retention on.
3. **PR 3 — Phase 3 (API + console tab)**: read-only; safe.
4. **PR 4 — Phase 4 (alerting)**: start with generous thresholds; tighten after a week of
   observed baselines.

Each PR independently revertible; nothing mutates existing request-path behavior except
added field extraction (wrapped in optional chaining — malformed upstream usage payloads
degrade to NULLs, never throw).

## 10. Explicit Non-Goals

- No Prometheus/Grafana/OTel — single-node SQLite is sufficient at current volume;
  revisit if Super Proxy becomes multi-node.
- No per-request tracing UI beyond the existing `request_logs` viewer.
- No billing reconciliation against provider invoices (future: manual monthly check of
  metered totals vs invoices).
- No client-visible usage API changes (`/v1/*` responses untouched).

## 11. Product Decisions (discovery session 2026-07-09, with Yash)

1. **Access model:** new `monitor` role below root admin. Root admin (dm_don, dev admin
   key) keeps everything. Monitor access = read-only `/admin/metrics/*` + monitoring tab,
   granted by email allowlist env `MONITOR_ACCESS_EMAILS=monitor@example.com,admin@example.com,admin@localhost`.
   Auth = personal API tokens (Option A): token → user → email → allowlist check via new
   `requireMonitor()` guard. Every monitor view audited in `admin_audit_logs`.
2. **Priorities:** cost/utilization + pool health + cache efficiency are ALL first-class
   (shared overview screen). Incident drill-down is secondary (mostly exists already).
3. **Billing reality (corrected):** anthropic, openai_codex, kimi, glm, xai are all
   subscription/flat-fee. Metered $ = gemini, openrouter, groq, cerebras, deepgram only.
4. **Alert delivery:** dedicated Discord webhook, env `DISCORD_MONITOR_WEBHOOK` (secret —
   never hardcode; Yash provided value out-of-band). Tiering: **warn** = silent post
   (cache collapse, latency degraded, 429 pressure, budget 80%); **critical** = ping
   Yash + Daxit via `MONITOR_PING_DISCORD_IDS` with 1h cooldown (pool ≤1 active with
   traffic, error rate >20%, budget 100%, rollup stalled). Discord IDs: Yash
   1323867867950874740, Daxit 653579252934901810.
5. **Budget thresholds:** unknown baseline (Option D) — ship `daily_budget` DISABLED;
   after 7 days of metered baselines, dashboard auto-suggests threshold (p95 daily × 1.5)
   for confirmation.
6. **Retention:** Option A — raw 30d, hourly 6mo, daily forever; per-user granularity
   preserved at daily grain permanently.
7. **Competitive additions (Helicone/LiteLLM-inspired):** per-request cost column in the
   existing usage-events feed + weekly Monday Discord digest (spend, top models, cache
   trend, incidents). Skipped: everything else — already covered.
8. **Build scope:** Option A — full build as one PR train, ship when complete (all phases
   reviewed/merged together; phases remain the internal build order).

## 12. Feature Checklist

See [`MONITORING-CHECKLIST.md`](./MONITORING-CHECKLIST.md) — the phased build checklist
generated from this discovery session.
