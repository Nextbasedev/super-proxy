# Fusion — Feature Checklist

## Summary

Fusion is a multi-model deliberation feature for the Super Proxy. A user sends one request, the gateway fans it out to a panel of models in parallel, collects their answers, then a synthesizer model compares and writes a better final answer. Available to all Nextbase team members via any OpenAI-compatible client.

- **Stack:** TypeScript, Fastify, SQLite — same as the existing gateway
- **Audience:** Nextbase team (internal), all roles
- **Clients:** OpenClaw, Cursor, curl, any OpenAI-compat client
- **Architecture:** Two layers — panel (parallel) → synthesizer
- **Modes:** `synthesize` (default, final answer) and `compare` (raw side-by-side responses)
- **Presets:** Built-in (`quality`, `budget`), user-saved custom presets, inline per-request config
- **Cost controls:** No special treatment — existing per-token/per-user daily caps apply
- **Latency tolerance:** No constraint — quality over speed

---

# Phase 1 — Core Engine (Week 1–2)
*Goal: You can call `POST /v1/fusion/chat/completions` with a built-in preset and get a synthesized multi-model response.*

## Types & Config
1. [ ] `src/fusion/types.ts` — `FusionConfig`, `PanelResult`, `FusionResponse`, `FusionMode` types
2. [ ] `src/fusion/presets.ts` — Built-in preset definitions (`quality`: Sonnet + GPT-5.5 + Gemini Flash, `budget`: Gemini Flash + Groq Llama 70B + Cerebras GPT-OSS)
3. [ ] Preset resolution logic: `fusion` → `fusion/quality`, `fusion/budget` → resolve to panel + synthesizer config
4. [ ] Validation: 1–8 panel models, valid `provider/model` format, known provider prefix

## Request Translation
5. [ ] `src/fusion/translate.ts` — Convert `/chat/completions` messages to Anthropic `/v1/messages` format (extract system prompt, strip system role from messages)
6. [ ] Convert `/chat/completions` messages to OpenAI Codex `/v1/responses` format (messages → input items, system → instructions)
7. [ ] Pass-through for OpenAI-compat providers (Gemini, Groq, Cerebras, Kimi, xAI, OpenRouter) — messages as-is, set `max_tokens`, `stream: false`
8. [ ] Provider routing map: resolve `provider/model` prefix → internal endpoint URL

## Response Extraction
9. [ ] `src/fusion/extract.ts` — Extract text content from Anthropic response (`content[].text`)
10. [ ] Extract text from OpenAI Responses format (`output[].content[].text`, SSE delta parsing)
11. [ ] Extract text from OpenAI-compat response (`choices[0].message.content`)
12. [ ] Extract usage (input/output tokens) from each provider's response shape

## Synthesizer
13. [ ] `src/fusion/synthesizer.ts` — Synthesizer system prompt template (compare panel responses, find consensus/contradictions/unique insights/blind spots, write authoritative answer)
14. [ ] Build synthesizer request: inject panel responses into prompt, format as the target provider's request shape
15. [ ] Handle synthesizer streaming: forward SSE chunks to client as `chat.completion.chunk` events

## Orchestrator
16. [ ] `src/proxy/fusion.ts` — Route handler for `POST /v1/fusion/chat/completions`
17. [ ] Auth via `requireProxyToken` (same as every endpoint)
18. [ ] Resolve preset from `model` field (`fusion`, `fusion/quality`, `fusion/budget`)
19. [ ] Merge inline `fusion` body config over preset defaults (body always wins)
20. [ ] Pre-flight model access check: drop panel models the user can't access, fail if none remain
21. [ ] Panel phase: `Promise.allSettled` — fan out to N panel models via `app.inject()` in parallel
22. [ ] Each `app.inject()` call: set `Authorization` header from user's token, set `x-fusion-depth: 1`, translate request body, set per-call timeout
23. [ ] Collect panel results: extract text + usage from successful calls, record failures
24. [ ] Abort if all panel models failed → `503` with `fusion_error: all_panels_failed`
25. [ ] Single panel shortcut: if only 1 model succeeded, return its response directly (skip synthesizer)
26. [ ] Synthesizer phase: build prompt with panel responses, call synthesizer model via `app.inject()`
27. [ ] Non-streaming: collect synthesizer response, build `/chat/completions` response shape, return
28. [ ] Streaming: pipe synthesizer SSE through to client as `chat.completion.chunk` events
29. [ ] Synthesizer failure fallback: return the longest/first panel response as the answer
30. [ ] Build `fusion` metadata object in response (panel models, succeeded/failed, latency breakdown)
31. [ ] Recursion protection: reject requests with `x-fusion-depth >= 1`

## Usage & Cost
32. [ ] Sub-call usage events: recorded automatically by existing proxy handlers (no new code)
33. [ ] Parent usage event: record one `usage_event` with `provider: 'fusion'`, `endpoint: '/v1/fusion/chat/completions'`, summed tokens and cost
34. [ ] `estimateCost` in `cost.ts`: add `fusion` provider that returns 0 (real cost is in sub-call events)

## Registration
35. [ ] Register `POST /v1/fusion/chat/completions` in `server.ts`
36. [ ] Add `'fusion'` to known providers list (virtual — no pool accounts, just for usage events)

## Tests
37. [ ] Unit tests: `translate.ts` — Anthropic, Codex, OpenAI-compat translations
38. [ ] Unit tests: `extract.ts` — content extraction from each response format
39. [ ] Unit tests: `presets.ts` — preset resolution, validation, merge logic
40. [ ] Integration test: full fusion call with mocked `app.inject()` responses

---

# Phase 2 — Compare Mode & Custom Presets (Week 3)
*Goal: Users can run `fusion/custom` with saved presets, and use compare mode to see raw side-by-side responses.*

## Compare Mode
41. [ ] Support `fusion.mode: "compare"` in request body (default: `"synthesize"`)
42. [ ] Compare mode: skip synthesizer entirely, return all panel responses in the response body
43. [ ] Compare response shape: `choices` array with one entry per panel model, each containing the model's response
44. [ ] Compare metadata: model name, latency, success/failure per panel member
45. [ ] Compare mode streaming: stream each panel response sequentially as separate chunks with model labels (or return non-streamed)

## Database — Presets & Call Metadata
46. [ ] Migration: `fusion_presets` table (`user_id`, `name`, `panel_models_json`, `synthesizer_model`, `panel_max_tokens`, `synthesizer_max_tokens`, `panel_timeout_ms`, `UNIQUE(user_id, name)`)
47. [ ] Migration: `fusion_calls` table (parent usage event ref, preset name, panel/synthesizer models, succeeded/failed counts, latency breakdown)
48. [ ] Validate preset names: lowercase `[a-z0-9-]`, 1–40 chars, reject reserved names (`quality`, `budget`, `custom`)
49. [ ] Max 20 presets per user

## Preset CRUD API
50. [ ] `GET /api/me/fusion-presets` — list user's saved presets
51. [ ] `POST /api/me/fusion-presets` — create preset (validate name, panel 1–8, synthesizer required, known provider prefixes)
52. [ ] `PUT /api/me/fusion-presets/:name` — update preset (name immutable)
53. [ ] `DELETE /api/me/fusion-presets/:name` — delete preset
54. [ ] Register endpoints in `self-api.ts`
55. [ ] Model access NOT checked at save time — checked at call time (graceful skip)

## Preset Resolution in Orchestrator
56. [ ] Extend preset resolution: `fusion/<name>` → DB lookup by `(user_id, name)`
57. [ ] `fusion/custom` without `fusion` body → `400` error
58. [ ] Unknown preset name (not built-in, not in DB) → `400` error with helpful message
59. [ ] Record preset name in `fusion_calls` table for audit

## Tests
60. [ ] Preset CRUD: create, list, update, delete, validation errors, reserved name rejection, max limit
61. [ ] Compare mode: verify no synthesizer call, correct multi-choice response shape
62. [ ] Custom preset resolution: DB lookup, merge with inline overrides, missing preset error

---

# Phase 3 — Model Discovery & Dashboard (Week 4)
*Goal: Fusion models appear in `/v1/models`, dashboard shows preset management and fusion call history.*

## `/v1/models` Endpoint
63. [ ] Add or extend `GET /v1/models` to return a model list (if it doesn't exist yet)
64. [ ] Include `fusion/quality` and `fusion/budget` as static entries
65. [ ] Include the authenticated user's custom preset names as `fusion/<name>` entries
66. [ ] Model list entries include metadata: `id`, `object: "model"`, `owned_by: "nextbase-fusion"`, description with panel model names
67. [ ] Auth required — user's custom presets are only visible to them

## Dashboard — Preset Management (Minimal)
68. [ ] New "Fusion Presets" section in the dashboard (alongside existing "My API Tokens")
69. [ ] List view: show all user's presets with name, panel models, synthesizer, created date
70. [ ] Create form: text input for name, text inputs for panel models (comma-separated or one-per-line), text input for synthesizer, optional number inputs for max_tokens/timeout
71. [ ] Edit: inline edit or modal with same form, pre-filled
72. [ ] Delete: confirm dialog, then delete
73. [ ] Validation feedback: show errors for invalid names, too many panel models, unknown provider prefixes
74. [ ] Show built-in presets (`quality`, `budget`) as read-only reference — users can see what's in them

## Dashboard — Fusion Call History (Minimal)
75. [ ] New "Fusion Calls" section (or tab within usage)
76. [ ] Table: timestamp, preset used, panel models, succeeded/failed count, synthesizer model, total latency, total cost
77. [ ] Sortable by date, filterable by preset name
78. [ ] Click to expand: show per-panel-model latency and status, synthesizer status
79. [ ] Pull data from `fusion_calls` table joined with parent `usage_events`

## Tests
80. [ ] `/v1/models` returns fusion entries, includes user presets, excludes other users' presets
81. [ ] Dashboard preset CRUD works end-to-end (if UI tests exist)

---

# Phase 4 — Polish & Edge Cases (Week 5)
*Goal: Production-hardened with proper error messages, alerts, and documentation.*

## Error Handling Polish
82. [ ] Clear error messages for every failure mode: all panels failed, synthesizer failed, no panel models accessible, recursion detected, invalid preset, `fusion/custom` without config
83. [ ] Synthesizer timeout: if synthesizer takes too long, return best panel response as fallback
84. [ ] Panel timeout: per-call `panel_timeout_ms` enforced via `AbortSignal.timeout()` on each `app.inject()`
85. [ ] Handle edge case: user's token gets disabled mid-fusion (sub-calls start failing after panel phase started)

## Alerts
86. [ ] Discord alert when all panel models fail (potential pool-wide issue)
87. [ ] Discord alert when fusion synthesizer fails (potential model issue)
88. [ ] Alert if a user's fusion calls have >50% panel failure rate in the last hour

## Streaming Progress Events
89. [ ] Send `fusion.progress` SSE event before synthesizer starts: `{"object":"fusion.progress","phase":"panel","status":"3/3 models responded"}`
90. [ ] Send progress on partial panel completion: `{"object":"fusion.progress","phase":"panel","status":"2/3 models responded (1 failed)"}`
91. [ ] Clients that don't understand `fusion.progress` silently skip it (standard SSE behavior)

## Documentation
92. [ ] Update `docs/ROUTING-CONFIG.md` with fusion setup instructions (model name, example curl)
93. [ ] Update `docs/SPEC.md` with fusion as a feature
94. [ ] Add `public/skills/fusion/SKILL.md` — usage guide for AI coding assistants
95. [ ] Inline code comments on the orchestration flow

## Logging & Audit
96. [ ] Force-log fusion calls when any panel model fails (for debugging pool health)
97. [ ] Force-log when synthesizer falls back to panel response
98. [ ] `fusion_calls` rows include enough data to reconstruct what happened without reading usage_events

---

# Later (Not in V1)
- [ ] **Web search in panel calls** — inject `tools: [{type: "web_search"}]` into panel calls via `/v1/search`
- [ ] **Multi-turn conversation** — pass full message history through fusion (works but expensive)
- [ ] **Custom synthesizer prompts** — let users customize the synthesis instructions
- [ ] **Caching** — cache panel results for identical prompts within a time window
- [ ] **Fusion analytics dashboard** — charts, trends, cost-per-preset, model comparison metrics
- [ ] **Admin preset management** — admins create org-wide presets visible to all users
- [ ] **Weighted panel** — some panel models count more than others in synthesis
- [ ] **Auto-routing** — gateway decides whether to use fusion or single-model based on prompt complexity
- [ ] **Expose to Ampere users** — if this proves valuable, offer it as an Ampere platform feature

---

# Build Summary

| Phase | Scope | Timeline | Items |
|---|---|---|---|
| Phase 1 | Core engine — panel, synthesizer, orchestrator, presets, streaming | Week 1–2 | 40 items |
| Phase 2 | Compare mode, custom presets (DB + CRUD API), preset resolution | Week 3 | 22 items |
| Phase 3 | `/v1/models` discovery, dashboard preset UI, fusion call history | Week 4 | 19 items |
| Phase 4 | Error polish, alerts, progress events, docs, logging | Week 5 | 17 items |
| **Total** | | **~5 weeks** | **98 items** |
