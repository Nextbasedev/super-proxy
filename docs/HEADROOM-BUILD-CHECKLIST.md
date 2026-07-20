# Super Proxy Headroom Compression — Build Checklist

## Summary

Gateway-level context compression for the Super Proxy model gateway. A shared Headroom Python sidecar compresses LLM request payloads (tool outputs, conversation history) before forwarding to upstream providers. 50-74% input token savings with zero accuracy loss, fully transparent to fleet users. Fallback-safe — if compression fails, requests proceed unchanged.

**Key decisions:**
- Headroom Python sidecar alongside Super Proxy (Docker compose, shared instance)
- OpenAI chat/completions + Anthropic messages + fusion entry-point (xAI Responses excluded)
- Global toggle + per-provider skip list + per-user dashboard override
- Compression metrics in existing `usage_events` table with `compression_status` enum
- 5s sync timeout, discard-if-bigger safety, graduated rollout (staging → leads → default)

**Validated test results (2026-07-03 staging):**
- Claude Sonnet 4.6: **74% savings, 5/5 accuracy**
- Kimi K2.6: **60-99% savings per case type**
- Lossless compression (JSON → schema+CSV, all records preserved)
- Zero latency overhead

---

# Phase 1 — Core Middleware
*Goal: Compression working on all chat/completions and messages routes with fallback safety*

## Headroom Sidecar
1. [ ] `sidecar/headroom/Dockerfile` — Headroom proxy container (`headroom-ai[proxy]`, Python 3.12-slim, `HEADROOM_TELEMETRY=off`)
2. [ ] `sidecar/headroom/docker-compose.yml` — sidecar compose (host network, port 8899, health check, restart policy, log volume)
3. [ ] Sidecar health check script — verify `:8899/health` returns `status: healthy`
4. [ ] Document sidecar startup in `docs/DEPLOY.md` (add to existing deploy runbook)

## Compression Middleware
5. [ ] `src/proxy/compress.ts` — Fastify preHandler hook with fallback-safe try/catch
6. [ ] `compressOpenAI()` — send `messages[]` to Headroom `/v1/compress`, get compressed messages back
7. [ ] 5-second `AbortSignal.timeout` on compress fetch — skip compression on timeout, log timeout event
8. [ ] Size guard — compare compressed vs original byte length, discard if compressed is larger, log `negative` status
9. [ ] Return `compressionResult` on request object (`tokens_before`, `tokens_saved`, `compression_ms`, `status`)
10. [ ] `compression_status` enum values: `compressed` | `skipped` | `timeout` | `error` | `negative` | `disabled`

## Anthropic Format Converter
11. [ ] `anthropicToOpenAI()` — convert `tool_use`/`tool_result` content blocks to OpenAI `tool_calls`/`tool` roles
12. [ ] `openAIToAnthropic()` — map compressed tool messages back into Anthropic content block structure
13. [ ] Handle `system` field (string or array of content blocks) → OpenAI system message
14. [ ] Preserve non-tool message structure (text blocks, images) unchanged through round-trip

## Route Registration
15. [ ] Hook middleware on all `*/chat/completions` routes (groq, cerebras, kimi, gemini, openrouter, runpod)
16. [ ] Hook middleware on all `*/messages` routes (anthropic, glm, kimi-anthropic)
17. [ ] Hook middleware on `/v1/fusion/chat/completions` (compress before fan-out)
18. [ ] Skip list — do NOT hook on audio, embeddings, TTS, STT, images, realtime, search, xai routes
19. [ ] Route detection logic: inspect `req.url` to determine format (OpenAI vs Anthropic)

## Config
20. [ ] `HEADROOM_ENABLED` env var (default: `false`) — global kill switch
21. [ ] `HEADROOM_URL` env var (default: `http://127.0.0.1:8899`) — sidecar address
22. [ ] `HEADROOM_TIMEOUT_MS` env var (default: `5000`) — compression timeout
23. [ ] `HEADROOM_MIN_TOKENS` env var (default: `500`) — pre-flight skip threshold
24. [ ] `HEADROOM_SKIP_PROVIDERS` env var (comma-separated provider names to bypass)
25. [ ] Add all config vars to `src/config.ts` with validation and typed defaults

---

# Phase 2 — Metrics & User Control
*Goal: Compression savings visible in DB, per-user opt-out working*

## Database Schema
26. [ ] Migration: add `tokens_before_compression` (INTEGER, nullable) to `usage_events`
27. [ ] Migration: add `tokens_saved_compression` (INTEGER, nullable) to `usage_events`
28. [ ] Migration: add `compression_ms` (INTEGER, nullable) to `usage_events`
29. [ ] Migration: add `compression_status` (TEXT, nullable) to `usage_events`
30. [ ] Migration: add `compression_enabled` (BOOLEAN, default `true`) to `users` table
31. [ ] Verify existing rows unaffected — all new columns nullable, no backfill needed

## Usage Recording
32. [ ] Pass `compressionResult` from middleware to each provider proxy's `recordUsage()` call
33. [ ] Update `recordUsage()` in `src/proxy/usage.ts` to write compression columns
34. [ ] Log compression stats in Fastify request logger (`tokens_saved`, `status`, `ms`)

## Per-User Override
35. [ ] Read `compression_enabled` from user record during auth middleware (already loaded on every request)
36. [ ] Pass user preference to compression middleware — skip if user opted out, set status `disabled`
37. [ ] Cache user preference in-memory (same pattern as existing user field lookups, no extra DB query)

## Dashboard UI
38. [ ] Add "Context Compression" toggle to user settings in Super Proxy admin dashboard
39. [ ] `PATCH /admin/users/:id` — accept `compression_enabled` field
40. [ ] Display compression status on user detail page (enabled/disabled)

---

# Phase 3 — Fusion & Testing
*Goal: Fusion entry-point compression working, full test coverage*

## Fusion Integration
41. [ ] Compress `messages[]` at fusion entry point before preset resolution and panel dispatch
42. [ ] Ensure compressed messages flow to all panel calls (compress once, use N times)
43. [ ] Set `x-headroom-compressed: true` internal header on panel sub-requests to prevent double-compression
44. [ ] Verify synthesizer receives panel responses correctly (compression is request-side only, never touches responses)

## Unit Tests
45. [ ] `src/compress.test.ts` — OpenAI format: compress messages, verify `tokens_saved > 0`
46. [ ] `src/compress.test.ts` — OpenAI format: size guard discards when compressed is larger
47. [ ] `src/compress.test.ts` — OpenAI format: timeout simulation returns original messages + `timeout` status
48. [ ] `src/compress.test.ts` — Anthropic format: `anthropicToOpenAI` round-trip with tool_use/tool_result
49. [ ] `src/compress.test.ts` — Anthropic format: system as string + system as content block array
50. [ ] `src/compress.test.ts` — Anthropic format: multi-tool round-trip (2+ tool_use blocks in one assistant message)
51. [ ] `src/compress.test.ts` — Headroom unreachable: verify passthrough + `error` status
52. [ ] `src/compress.test.ts` — Skip conditions: small payload below `MIN_TOKENS`, skipped provider, user opt-out
53. [ ] `src/compress.test.ts` — Fusion: compressed messages reach panel calls, `x-headroom-compressed` prevents re-compression
54. [ ] `src/compress.test.ts` — Migration: compression columns nullable, existing rows unaffected

## Integration Tests
55. [ ] End-to-end with real sidecar: OpenAI format (groq or kimi `/chat/completions`)
56. [ ] End-to-end with real sidecar: Anthropic format (anthropic `/v1/messages`)
57. [ ] Streaming: verify SSE response unaffected by request-side compression
58. [ ] Fallback: stop Headroom sidecar mid-test, verify passthrough with `error` status
59. [ ] Per-user bypass: user with `compression_enabled=false` gets uncompressed request

---

# Phase 4 — Production Deployment & Rollout
*Goal: Live on production Super Proxy with graduated rollout*

## Sidecar Deployment
60. [ ] Deploy Headroom sidecar container on production Super Proxy server
61. [ ] Verify health check, resource usage (RAM, CPU) under idle
62. [ ] Configure Docker restart policy (`unless-stopped`) and log rotation for sidecar
63. [ ] Add sidecar health to existing Super Proxy monitoring (health endpoint check)

## Graduated Rollout
64. [ ] Enable `HEADROOM_ENABLED=true` on production Super Proxy
65. [ ] Stage 1: Enable for staging group users only (set `compression_enabled=true` per-user in DB)
66. [ ] Monitor: check `compression_status` distribution, `tokens_saved` totals, error/timeout rate
67. [ ] Stage 2: Enable for leads group users
68. [ ] Monitor: same checks, verify no quality complaints
69. [ ] Stage 3: Enable globally (set `compression_enabled=true` as default for all users)

## Production Hardening
70. [ ] Load test: 10 concurrent requests through compression middleware — verify sidecar stability
71. [ ] Verify compression under sustained load (sidecar memory stays bounded, response time stable)
72. [ ] Set Docker `--memory` limit on sidecar container (2GB cap) with restart on OOM
73. [ ] Document runbook: "Headroom sidecar down" → requests pass through automatically, restart sidecar to resume compression
74. [ ] Document runbook: "Compression quality complaint" → disable per-user via dashboard toggle

---

# Later (Not in V1)
- [ ] Port SmartCrusher (JSON → schema+CSV) natively to TypeScript — eliminate Python dependency
- [ ] xAI Responses API support (convert `input` items to OpenAI messages format for compression)
- [ ] Compression savings chart on Super Proxy admin dashboard (per-user, per-provider, daily trends)
- [ ] Discord/Telegram alerting on compression anomaly spikes (>5% timeout rate in 5 min window)
- [ ] Headroom CCR (reversible retrieval) for IntelligentContext turn-dropping in long sessions
- [ ] Per-provider compression config (different thresholds/settings for different upstream providers)
- [ ] A/B testing infrastructure (50% compressed, 50% direct, compare answer quality metrics)
- [ ] Cost savings report: map token savings → dollar savings per user/month using provider pricing

---

# Build Summary

| Phase | Scope | Items |
|-------|-------|-------|
| **Phase 1** | Core middleware + sidecar + Anthropic converter + route registration + config | 25 |
| **Phase 2** | DB schema + usage recording + per-user override + dashboard toggle | 15 |
| **Phase 3** | Fusion integration + unit tests + integration tests | 19 |
| **Phase 4** | Production deploy + graduated rollout + hardening + runbooks | 15 |
| **Later** | Native port, xAI, dashboards, alerting, A/B, cost reports | 8 |
| **Total** | | **82** |

---

# Provider Compatibility Matrix

| Provider | Route | Format | Compressible | Notes |
|----------|-------|--------|-------------|-------|
| anthropic | `/v1/messages` | Anthropic | ✅ Yes | Format converter handles tool_use/tool_result |
| openai | `/v1/chat/completions` | OpenAI | ✅ Yes | Images/realtime/responses routes excluded |
| groq | `/v1/groq/chat/completions` | OpenAI | ✅ Yes | Audio/embeddings routes excluded |
| cerebras | `/v1/cerebras/chat/completions` | OpenAI | ✅ Yes | Embeddings route excluded |
| kimi | `/v1/kimi/chat/completions`, `/v1/kimi/messages` | Both | ✅ Yes | Both OpenAI and Anthropic routes |
| glm | `/v1/glm/messages` | Anthropic | ✅ Yes | Same as Anthropic format |
| gemini | `/v1/gemini/chat/completions` | OpenAI | ✅ Yes | TTS/files/embeddings routes excluded |
| openrouter | `/v1/openrouter/chat/completions` | OpenAI | ✅ Yes | Standard OpenAI format |
| runpod | `/v1/runpod/chat/completions` | OpenAI | ✅ Yes | Standard OpenAI format |
| fusion | `/v1/fusion/chat/completions` | OpenAI | ✅ Yes | Compress once at entry, panels get compressed context |
| xai | `/v1/xai/responses` | Responses | ❌ Excluded | Different `input` format, deferred to Later |
| gemini-live | `/v1/gemini/realtime` | WebSocket | ❌ N/A | Real-time relay, no request-level messages |
| deepgram | `/v1/deepgram/listen` | Audio | ❌ N/A | Binary audio payload |
| fish | `/v1/fish/tts` | Audio | ❌ N/A | Text-to-speech |
| search | `/v1/search` | Custom | ❌ N/A | Search proxy, not LLM chat |

---

# Decision Log

| # | Question | Decision | Rationale |
|---|----------|----------|-----------|
| 1 | Deployment model | Headroom Python sidecar | Full compression engine, auto-updates, proven in staging. No need to maintain a TS fork. |
| 2 | API format support | Chat/completions + Anthropic + fusion (xAI excluded) | Covers 10/15 providers. xAI Responses API has different structure, deferred. |
| 3 | Toggle granularity | Global + per-provider skip + per-user override | Per-user via dashboard toggle in DB. No per-request headers. |
| 4 | Metrics tracking | Compression columns in `usage_events` | Same row, same write. Queryable without separate table. |
| 5 | Negative savings | Discard + log `negative` status | Never make things worse. Log for threshold tuning. |
| 6 | Timeout | 5s sync with logged timeout events | Compression takes 0.1-0.5s typical. 5s is generous. Timeouts get `timeout` status in DB. |
| 7 | User opt-out | Dashboard toggle (`compression_enabled` in `users` table) | Admin-controlled, auditable, no client-side headers. |
| 8 | Rollout | Graduated: staging → leads → default | Mirrors existing agent-runtime group rollout. Each stage soaks before expansion. |
| 9 | Anomaly logging | `compression_status` enum in `usage_events` | Single column captures all states. Dashboard can query `WHERE compression_status = 'timeout'`. |
