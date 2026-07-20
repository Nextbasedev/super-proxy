# NBMG Monitoring System — Feature Checklist

## Summary

Internal observability system for the Nextbase Model Gateway: tracks cache efficiency,
token usage, cost (notional vs metered), and provider-pool reliability across all 14
providers. Consumed by Yash + Daxit via a read-only monitoring role in the existing admin
console, with tiered Discord alerting. Built on SQLite rollups — no new infrastructure.

**Key decisions:**
- Auth: personal API tokens + email allowlist (`MONITOR_ACCESS_EMAILS`); dm_don keeps root via dev admin key
- Billing split: anthropic/codex/kimi/glm/xai = flat-fee subscriptions → notional value + utilization; gemini/openrouter/groq/cerebras/deepgram = metered $
- Alerts: dedicated webhook (`DISCORD_MONITOR_WEBHOOK`); warn = silent, critical = ping Yash + Daxit, 1h cooldown
- Retention: raw 30d / hourly 6mo / daily forever (per-user kept at daily grain)
- Delivery: one PR train, all phases together; phases below are internal build order
- Companion design doc: [`MONITORING-SYSTEM.md`](./MONITORING-SYSTEM.md)

---

# Phase 1 — Instrumentation (Week 1)
*Goal: every request records complete, correctly-classified usage data; zero client-visible change.*

## Schema (`src/db/migrate.ts`)
1. [ ] `addColumn` × 6 on `usage_events`: `reasoning_tokens`, `ttft_ms`, `retry_count`, `retry_reason`, `unit`, `billing_mode` (all nullable, additive)
2. [ ] Indexes: `idx_usage_events_created`, `idx_usage_events_provider_created`, `idx_usage_events_user_created`
3. [ ] Migration is idempotent and safe on existing prod DB (follows existing `addColumn` guard pattern)

## recordUsage() (`src/proxy/usage.ts`)
4. [ ] Extend input type with the 6 new fields
5. [ ] Central `BILLING_MODE` map (anthropic/openai_codex/kimi/glm/xai = `flat_fee`, runpod = `self_hosted`, fish = `free_tier`, default `metered`); caller override allowed
6. [ ] Malformed/absent values degrade to NULL — never throw from the recording path

## Shared TTFT helper (`src/proxy/ttft.ts`)
7. [ ] `ttftTracker(started)` — `mark()` on first chunk, idempotent
8. [ ] Wire into every streaming pump: anthropic, openai, gemini, kimi, glm, groq, cerebras, openrouter, xai, runpod, fusion
9. [ ] Non-stream requests: `ttft_ms` = full-body receipt time (≈ latency)

## Per-proxy extraction fixes
10. [ ] **gemini.ts**: capture `usageMetadata.cachedContentTokenCount` → `cache_read_tokens`; record `input_tokens = promptTokenCount − cachedContentTokenCount` (uncached semantics, matching other providers)
11. [ ] **gemini.ts**: capture `usageMetadata.thoughtsTokenCount` → `reasoning_tokens`
12. [ ] **gemini.ts**: cost estimation prices cached tokens at cached rate (fix current overcount)
13. [ ] **gemini-live.ts**: same cache/thoughts extraction for session usage records
14. [ ] **openai.ts**: capture `output_tokens_details.reasoning_tokens` (Responses) + `completion_tokens_details.reasoning_tokens` (chat-compat)
15. [ ] **openai.ts**: plumb `retry_count`/`retry_reason` from strip-stale-reasoning retry and account-rotation loops
16. [ ] **xai.ts**: capture `completion_tokens_details.reasoning_tokens`; media endpoints set `unit` (`images`/`videos`/`seconds`/`chars`)
17. [ ] **groq/cerebras/openrouter/kimi/glm/runpod**: opportunistic `reasoning_tokens` extraction (safe if absent)
18. [ ] **deepgram.ts**: `unit: 'seconds'`; **fish.ts**: `unit: 'chars'` (values stay in `input_tokens` for cap compatibility)
19. [ ] **fusion.ts**: record `retry_count`/`retry_reason` on candidate fallback (reroutes countable)
20. [ ] **All proxies with rotation loops**: pass rotation attempt count as `retry_count`, reason as `retry_reason` (`rate_limited`/`account_rotation`/`stale_reasoning`/`upstream_error`)

## Cost single-source-of-truth (`src/proxy/cost.ts`)
21. [ ] Export `getRates(provider, model)` returning `{input, output, cacheWrite?, cacheRead?}` for reuse by rollup/savings math
22. [ ] Existing per-request estimation refactored to use `getRates` (no behavior change)

## Phase 1 tests
23. [ ] Fixture tests per provider asserting recorded row fields (extend existing `*.test.ts` files): gemini cached+thoughts, openai/xai reasoning, unit tagging, billing-mode derivation
24. [ ] Streaming fixtures assert `ttft_ms` set and `< latency_ms`
25. [ ] Migration test: run against copy of pre-migration schema, verify columns + indexes

---

# Phase 2 — Rollups & Retention (Week 1–2)
*Goal: aggregate tables answer any dashboard query in <50ms regardless of raw table size; disk growth bounded.*

## Tables (`src/db/migrate.ts`)
26. [ ] `usage_rollup_hourly` (PK: bucket, provider, model, user_id, billing_mode) — requests, error classes (4xx/429/5xx), token classes (input/output/reasoning/cache-write/cache-read/compression-saved), cost_usd, cache_saved_usd, latency sum + exact p50/p95, ttft p50/p95, retry_count
27. [ ] `usage_rollup_daily` (same shape, daily bucket)
28. [ ] `alert_cooldowns` (rule, scope, last_fired_at)
29. [ ] `monitor_meta` key-value table (rollup high-water mark, baseline-suggestion state)

## Rollup job (`src/monitoring/rollup.ts`)
30. [ ] 5-min interval: full-recompute upsert of current + previous hourly buckets (idempotent, no incremental drift)
31. [ ] Hourly: recompute today + yesterday daily buckets from hourly
32. [ ] Exact percentiles computed from raw rows at rollup time (stored — irrecoverable after pruning)
33. [ ] Token columns exclude non-token units (`unit IS NULL OR unit='tokens'`); non-token usage still counted in requests/errors/cost
34. [ ] Cache savings formula per provider/model via `getRates`: `read×(input_price−read_price) − creation×(write_price−input_price)`; flat-fee rows flagged notional via `billing_mode`
35. [ ] In-process mutex; skip run if previous still active; log + alert on repeated failure

## Retention (`src/monitoring/rollup.ts`, same loop)
36. [ ] Daily prune: raw `usage_events` >30d deleted in 5,000-row batches (no long write locks)
37. [ ] Hourly rollups pruned >180d; daily kept forever
38. [ ] Prune cutoff strictly trails rollup high-water mark (never delete un-rolled-up data)
39. [ ] `request_logs` expiry enforcement (per existing `expires_at`) folded into prune loop
40. [ ] Config knobs in `src/config.ts`: `MONITOR_RETENTION_RAW_DAYS` (30), `MONITOR_RETENTION_HOURLY_DAYS` (180), `MONITOR_RETENTION_ENABLED` (default true in the single PR train — validated in staging first)

## Phase 2 tests
41. [ ] Rollup math vs hand-computed fixtures; idempotent re-run produces identical rows
42. [ ] Percentile correctness (odd/even counts, single row, empty bucket)
43. [ ] Unit exclusion: deepgram seconds / fish chars never pollute token sums
44. [ ] Cache-savings formula per pricing shape (anthropic-style write+read, openai-style read-only, no-cache provider)
45. [ ] Retention: high-water-mark guard blocks premature prune; batch deletion terminates

---

# Phase 3 — Monitor Role, API & Console (Week 2–3)
*Goal: Yash + Daxit log in with their tokens and answer cost/health/efficiency questions in two clicks.*

## Monitor access (`src/admin/admin-api.ts` or new guard module)
46. [ ] `MONITOR_ACCESS_EMAILS` env (comma-separated, lowercased) in `src/config.ts`
47. [ ] `requireMonitor()` guard: root admin key always passes; else bearer token → user → email ∈ allowlist; 403 otherwise
48. [ ] Monitor access is READ-ONLY: guard only ever applied to GET metrics endpoints; no reuse on mutating routes
49. [ ] Audit log entry (`admin_audit_logs`) per monitor-authenticated request (actor = token's user)
50. [ ] Console login: token field stored in localStorage (existing console pattern), monitor users see ONLY the Monitoring tab

## Metrics API (`src/monitoring/metrics-api.ts`)
51. [ ] `GET /admin/metrics/overview?range=24h|7d|30d` — totals + per-provider rows; cost ALWAYS split `{metered, notional, selfHosted}` (never summed in one number)
52. [ ] `GET /admin/metrics/timeseries?metric=…&range=…&interval=hour|day&provider=&model=&userId=` — buckets for charting (requests, tokens in/out/reasoning, cache_hit_rate, cache_saved_usd, cost_usd, error_rate, latency p50/p95, ttft p50/p95, retries, compression_saved)
53. [ ] `GET /admin/metrics/cache?range=…` — per provider/model: hit rate, read/write ratio, $ saved, trend vs previous period
54. [ ] `GET /admin/metrics/top?dimension=user|model|token|account&by=cost|tokens|requests|errors&range=…&limit=`
55. [ ] `GET /admin/metrics/reliability?range=…` — error classes per provider, retries by reason, pool snapshot (governor + provider_accounts join: active/cooldown/dead per provider), recent `provider_health_events`
56. [ ] `GET /admin/metrics/utilization?range=…` — flat-fee subscription utilization: per account notional value absorbed, 429/cooldown frequency, near-limit indicator
57. [ ] `GET /admin/metrics/burn?month=…` — metered-only MTD spend + linear projection
58. [ ] Range→source routing: 24h → hourly rollups, 7d/30d → daily + today's hourly; current partial hour from raw (indexed, small window)
59. [ ] Zod-validated query params on every endpoint (existing admin pattern)

## Console — Monitoring tab (`public/index.html`, `console.js`; no build step, no new deps)
60. [ ] Overview cards with 7-day sparklines: metered spend today, notional value today, tokens today, cache hit rate, error rate, active pool accounts
61. [ ] Charts (inline SVG): cost/day stacked by provider (metered vs notional visually distinct); cache hit rate per provider; latency + TTFT p95; error rate with 429 overlay
62. [ ] Cache panel: provider/model table — hit %, read/write ratio, $ saved, trend arrows
63. [ ] Pool health panel: per provider — active/cooldown/dead accounts, in-flight, utilization bar for flat-fee accounts
64. [ ] Top-N panel: dimension × metric selectors
65. [ ] Reliability panel: error classes, retries by reason, recent health events feed
66. [ ] Budget suggestion card: after ≥7d of metered baselines, show suggested `daily_budget` (p95 × 1.5) with one-click confirm (writes to `monitor_meta`)
67. [ ] **Cost column in existing usage-events feed** (`/admin/usage-events` already returns `estimated_cost_usd` — surface it + billing-mode badge)
68. [ ] Range selector (24h/7d/30d) shared across all panels
69. [ ] Graceful empty states (fresh deploy with no rollups yet)

## Phase 3 tests
70. [ ] `requireMonitor()`: root passes, allowlisted email passes, non-allowlisted 403, disabled token 403, monitor token on mutating admin route 403
71. [ ] Response-shape tests per endpoint incl. metered/notional-never-summed invariant
72. [ ] Range→source routing correctness (bucket boundaries, partial-hour merge)

---

# Phase 4 — Alerting & Digest (Week 3)
*Goal: problems find Yash + Daxit; monitoring itself is monitored.*

## Delivery (`src/utils/alerts.ts` extension or `src/monitoring/alert-send.ts`)
73. [ ] `DISCORD_MONITOR_WEBHOOK` env (secret; never hardcoded) + `MONITOR_PING_DISCORD_IDS` env (Yash 1323867867950874740 + Daxit 653579252934901810)
74. [ ] Severity tiers: `warn` = embed only; `critical` = embed + `<@id>` content line + `allowed_mentions`
75. [ ] DB-backed cooldowns via `alert_cooldowns` (restart-safe); every fire also writes `alerts` table row
76. [ ] Fallback: if monitor webhook unset, route to existing `DISCORD_WEBHOOK_URL` as warn-only

## Rules engine (`src/monitoring/alert-rules.ts`, evaluated post-rollup every 5 min)
77. [ ] `pool_low` (critical): provider ≤1 active account with traffic in last 24h — 6h cooldown
78. [ ] `error_spike` (critical): provider error rate (5xx+429) >20% over 15 min, ≥20 requests — 1h cooldown
79. [ ] `daily_budget` (warn at 80%, critical at 100%): metered spend vs confirmed budget; DISABLED until budget confirmed via dashboard — once per threshold/day
80. [ ] `cost_spike` (warn): metered spend last 1h >3× same-hour 7d average AND >$5 — 6h cooldown
81. [ ] `rate_limit_pressure` (warn): 429 share >10% over 1h, ≥30 requests — 2h cooldown
82. [ ] `cache_collapse` (warn): provider cache hit rate <50% of its 7d average with ≥100k input tokens/h — 6h cooldown
83. [ ] `latency_degraded` (warn): p95 last 15 min >2.5× 7d p95, ≥20 requests — 1h cooldown
84. [ ] `rollup_stalled` (critical): newest hourly bucket >2h old — 6h cooldown (self-monitoring)
85. [ ] All thresholds env-overridable; rules are deterministic code (no LLM-as-guardrail)

## Weekly digest (`src/monitoring/digest.ts`)
86. [ ] Monday 09:00 IST post to monitor webhook: WTD metered spend + notional value, top 5 models by tokens, cache hit trend vs prior week, incident count (critical alerts fired), pool utilization summary
87. [ ] Digest schedule state in `monitor_meta` (no duplicate posts on restart)

## Phase 4 tests
88. [ ] Table-driven per rule: fires on trigger fixture, silent on below-threshold, respects cooldown, respects disabled state
89. [ ] Severity routing: warn never pings, critical pings with correct `allowed_mentions`
90. [ ] Digest content assembly from rollup fixtures; schedule-state dedupe

---

# Later Phase (Not in V1)
- [ ] Google OAuth login for monitor role (replace token paste for Daxit-friendly UX)
- [ ] Per-user self-serve usage/cache stats in user portal
- [ ] Programmatic metrics API for Ampere middleware (billing/limits integration)
- [ ] Invoice reconciliation: monthly metered totals vs actual provider invoices
- [ ] Anomaly detection on per-user patterns (abuse tie-in)
- [ ] Rollup-informed smart routing hints for fusion (cheapest healthy provider)

---

# Build Summary

| Phase | Scope | Timeline | Items |
|---|---|---|---|
| 1 — Instrumentation | Schema + recordUsage + 14-proxy extraction + TTFT + cost refactor | Week 1 | 25 |
| 2 — Rollups & Retention | Aggregate tables + 5-min job + savings math + pruning | Week 1–2 | 20 |
| 3 — Role, API & Console | Monitor auth + 7 endpoints + full Monitoring tab | Week 2–3 | 27 |
| 4 — Alerting & Digest | 8 deterministic rules + tiered Discord delivery + weekly digest | Week 3 | 18 |
| **Total** | One PR train (per decision #8), phases = build order | ~3 weeks | **90** |

**Deploy prerequisite:** `MONITOR_PING_DISCORD_IDS=1323867867950874740,653579252934901810` set in prod env.
