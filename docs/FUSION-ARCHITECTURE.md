# Fusion — Architecture

Multi-model deliberation for Super Proxy.

---

## The Problem

A single model gives you one perspective. For high-stakes questions — research, architectural decisions, nuanced analysis — you want multiple models to independently reason about the same problem, then have their answers compared and synthesized into something better than any one model alone.

Today, the gateway is a transparent pipe: one request in, one upstream call out. Fusion adds a new mode where the gateway orchestrates **multiple upstream calls** behind one client request.

## Design Principles

1. **Reuse, don't rebuild.** Every sub-call goes through the existing proxy endpoints via `app.inject()`. No new upstream HTTP clients, no duplicated auth/pool/cooldown logic. If Anthropic proxy handles retries and sticky routing, fusion Anthropic panel calls get that for free.

2. **Standard API surface.** The client sends a normal OpenAI-compatible `/chat/completions` request. The client doesn't need to know fusion is happening. The response is a normal `/chat/completions` response.

3. **Cost transparency.** Every sub-call records its own `usage_event`. The client sees total usage in the response. The dashboard shows the breakdown.

4. **Graceful degradation.** Partial panel failure is fine. Only if everything fails does the client get an error.

5. **No new provider accounts.** Fusion uses whatever accounts are already in the pool for each provider. No new keys, no new billing.

---

## Two-Layer Architecture

Fusion has exactly two phases:

```
POST /v1/fusion/chat/completions
  ├─ auth + policy (same as every endpoint)
  │
  ├─ PANEL ─── parallel ────────────────────────────────────
  │   ├─ app.inject → /v1/messages            (Anthropic)
  │   ├─ app.inject → /v1/chat/completions     (OpenAI/Codex)
  │   └─ app.inject → /v1/gemini/chat/completions (Gemini)
  │   Each is a full proxy call with auth, pooling, retries.
  │   Collect text responses. Timeout per-call: 2 min.
  │   Need ≥1 success to continue.
  │
  └─ SYNTHESIZER ─── single call, streamed to client ──────
      app.inject → chosen provider endpoint (stream: true)
      Receives original prompt + all panel responses.
      Compares, analyzes, and writes the final answer.
      SSE chunks forwarded to client.
```

### Why two layers, not three

An earlier draft had a separate judge (structured analysis) and synthesizer (prose writing). But the judge and synthesizer are two halves of the same job — the synthesizer is smart enough to compare panel responses AND write the final answer in one pass. Collapsing them into a single call saves ~30-40% latency and cost without sacrificing quality. The synthesizer prompt instructs the model to do both: find consensus, spot contradictions, identify unique insights, and write authoritatively.

### Why `app.inject()` and not direct `fetch()`

Fastify's `app.inject()` dispatches a synthetic HTTP request through the full Fastify pipeline — hooks, plugins, route handlers — without actually opening a TCP connection. This means:

- **Zero code duplication.** The Anthropic proxy already handles OAuth transforms, governor selection, sticky routing, cooldowns, in-flight tracking, refusal surfacing, usage recording, forced logging. Fusion gets all of that by calling `/v1/messages` internally.
- **Usage events for free.** Each sub-call creates its own `usage_event` row tagged to the user's token. Cost attribution is automatic and accurate.
- **Provider-specific behaviors preserved.** Groq rate buckets, Cerebras per-model RPD, Codex OAuth refresh, Gemini free-tier Pacific-day counters — all work exactly as they do for direct calls.

The overhead is negligible: `app.inject()` is an in-memory dispatch, no TCP, no serialization beyond JSON.

---

## API Contract

### Endpoint

```
POST /v1/fusion/chat/completions
```

Auth: `Authorization: Bearer sp_*` (same as every other endpoint).

### Request

Standard OpenAI `/chat/completions` body with an optional `fusion` config:

```jsonc
{
  "model": "fusion/quality",             // built-in preset
  // "model": "fusion/my-research",      // user's saved custom preset
  // "model": "fusion/custom",           // inline config (requires fusion body)
  "messages": [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "Compare microservices vs monolith for a 5-person startup."}
  ],
  "stream": true,

  // Optional for built-in/saved presets. Required for fusion/custom.
  // When present, overrides the preset's values.
  "fusion": {
    "mode": "synthesize",               // "synthesize" (default) or "compare"
    "panel": [                          // 1–8 models, provider-prefixed
      "anthropic/claude-sonnet-4-5-20250929",
      "openai_codex/gpt-5.5",
      "gemini/gemini-2.5-flash"
    ],
    "synthesizer": "anthropic/claude-sonnet-4-5-20250929",
    "panel_max_tokens": 4096,
    "synthesizer_max_tokens": 8192,
    "panel_timeout_ms": 120000
  }
}
```

If `fusion` body is omitted, the preset (built-in or user-saved) provides all values.

### Model Aliases & Presets

Fusion supports three tiers of configuration:

#### Built-in Presets (admin-controlled)

| Model | Panel | Synthesizer | Use case |
|---|---|---|---|
| `fusion` or `fusion/quality` | Claude Opus 4.8, GPT-5.5, Gemini 3.1 Pro | Claude Opus 4.8 | Best quality, ~$0.10-0.30/call |
| `fusion/budget` | Claude Sonnet, GPT-5.4, Gemini 3.5 Flash | Claude Sonnet | Good value, ~$0.03-0.08/call |

These are hardcoded in the gateway. Same for all users.

#### User Custom Presets (saved in DB)

Users can create, update, and delete their own named presets via the dashboard or REST API. A saved preset looks like:

```jsonc
{
  "name": "my-research",
  "panel": ["anthropic/claude-sonnet-4-5-20250929", "xai/grok-4-fast", "kimi/kimi-k2.6"],
  "synthesizer": "anthropic/claude-sonnet-4-5-20250929",
  "panel_max_tokens": 4096,
  "synthesizer_max_tokens": 8192,
  "panel_timeout_ms": 120000
}
```

Used as:
```json
{"model": "fusion/my-research", "messages": [...]}
```

The preset name becomes the model alias. Users can create as many as they want.

#### Inline Custom (`fusion/custom`)

For one-off calls without saving a preset, pass `model: "fusion/custom"` with a `fusion` config object in the request body. Power users who want full control per-request use this.

```json
{"model": "fusion/custom", "messages": [...], "fusion": {"panel": [...], "synthesizer": "..."}}
```

`fusion/custom` without a `fusion` body → `400` error.

#### Resolution Order

1. `fusion/quality` or `fusion/budget` → built-in preset
2. `fusion/<name>` → look up user's saved custom preset by name
3. `fusion/custom` + `fusion: {...}` in body → inline config
4. Any `fusion/*` name that doesn't match above → `400` error

If the request body includes a `fusion` object, it **always wins** — even on built-in presets. This lets a user call `model: "fusion/quality"` but override just the synthesizer.

### Provider Routing Map

The `provider/model` prefix determines which internal endpoint receives the `app.inject()`:

| Prefix | Internal endpoint | Request format |
|---|---|---|
| `anthropic/` | `POST /v1/messages` | Anthropic Messages API |
| `openai_codex/` | `POST /v1/responses` | OpenAI Responses API |
| `openai/` | `POST /v1/chat/completions` | OpenAI Chat Completions |
| `gemini/` | `POST /v1/gemini/chat/completions` | OpenAI-compat (Gemini proxy) |
| `groq/` | `POST /v1/groq/chat/completions` | OpenAI-compat |
| `cerebras/` | `POST /v1/cerebras/chat/completions` | OpenAI-compat |
| `kimi/` | `POST /v1/kimi/chat/completions` | OpenAI-compat |
| `openrouter/` | `POST /v1/openrouter/chat/completions` | OpenAI-compat |
| `xai/` | `POST /v1/xai/chat/completions` | OpenAI-compat |

Each call needs its request body translated into the correct format for that provider. This is done by a small `translate.ts` module — one function per provider API format.

### Response

Standard OpenAI `/chat/completions` shape:

#### Synthesize mode (default)

```jsonc
{
  "id": "fusion-a1b2c3d4",
  "object": "chat.completion",
  "created": 1718789000,
  "model": "fusion/quality",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "Final synthesized answer..." },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 2400,
    "completion_tokens": 1800,
    "total_tokens": 4200
  },
  // Non-standard metadata. Clients that don't understand this ignore it.
  "fusion": {
    "mode": "synthesize",
    "panel": {
      "models": ["claude-sonnet-4-5-20250929", "gpt-5.5", "gemini-2.5-flash"],
      "succeeded": 3,
      "failed": 0,
      "failed_details": [],
      "latency_ms": 4200
    },
    "synthesizer": {
      "model": "claude-sonnet-4-5-20250929",
      "latency_ms": 2200
    },
    "total_latency_ms": 6400
  }
}
```

#### Compare mode (`fusion.mode: "compare"`)

Returns all panel responses side-by-side. No synthesizer call. Useful for model evaluation and seeing how different models approach the same question.

```jsonc
{
  "id": "fusion-a1b2c3d4",
  "object": "chat.completion",
  "created": 1718789000,
  "model": "fusion/quality",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "Claude's response..." },
      "finish_reason": "stop",
      "model": "claude-sonnet-4-5-20250929"
    },
    {
      "index": 1,
      "message": { "role": "assistant", "content": "GPT's response..." },
      "finish_reason": "stop",
      "model": "gpt-5.5"
    },
    {
      "index": 2,
      "message": { "role": "assistant", "content": "Gemini's response..." },
      "finish_reason": "stop",
      "model": "gemini-2.5-flash"
    }
  ],
  "usage": {
    "prompt_tokens": 1800,
    "completion_tokens": 3600,
    "total_tokens": 5400
  },
  "fusion": {
    "mode": "compare",
    "panel": {
      "models": ["claude-sonnet-4-5-20250929", "gpt-5.5", "gemini-2.5-flash"],
      "succeeded": 3,
      "failed": 0,
      "failed_details": [],
      "latency_ms": 4200
    },
    "total_latency_ms": 4200
  }
}
```

Compare mode costs less (no synthesizer call) and is faster (panel only).

### Streaming

When `stream: true`:

1. Panel runs internally (not streamed to client — it's internal deliberation).
2. The synthesizer phase streams to the client as standard `chat.completion.chunk` SSE events.
3. Before synthesis begins, the gateway sends a non-standard progress event so clients know deliberation is happening:

```
data: {"object":"fusion.progress","phase":"panel","status":"3/3 models responded"}

data: {"id":"fusion-a1b2c3d4","object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant","content":""},"index":0}]}

data: {"id":"fusion-a1b2c3d4","object":"chat.completion.chunk","choices":[{"delta":{"content":"Based on "},"index":0}]}
...
data: [DONE]
```

Clients that don't understand `fusion.progress` will silently skip it (unknown SSE events are ignored by OpenAI SDK parsers).

---

## Internal Orchestration Detail

### Request Translation (`translate.ts`)

Each provider has a different request shape. The fusion orchestrator needs to convert the user's `/chat/completions` messages into the right format:

**To Anthropic (`/v1/messages`):**
```jsonc
{
  "model": "claude-sonnet-4-5-20250929",
  "max_tokens": 4096,
  "system": "extracted system prompt",
  "messages": [/* user/assistant messages, no system role */]
}
```

**To OpenAI Codex (`/v1/responses`):**
```jsonc
{
  "model": "gpt-5.5",
  "input": [/* converted to input_text items */],
  "instructions": "system prompt",
  "stream": false,
  "store": false
}
```

**To OpenAI-compat providers (Gemini, Groq, Cerebras, Kimi, xAI, OpenRouter):**
```jsonc
{
  "model": "gemini-2.5-flash",
  "messages": [/* pass through as-is */],
  "max_tokens": 4096,
  "stream": false
}
```

### Response Extraction

Each sub-call returns a different response shape. The orchestrator extracts the text content:

- **Anthropic:** `response.content[].text`
- **OpenAI Responses:** `response.output[].content[].text` or parse SSE `response.output_text.delta`
- **OpenAI-compat:** `response.choices[0].message.content`

Plus usage extraction for each.

### Parallel Panel Execution

```typescript
const panelResults = await Promise.allSettled(
  panelModels.map(model => executeSubCall(app, auth, model, messages, panelMaxTokens, panelTimeoutMs))
);
```

Each `executeSubCall`:
1. Resolves `provider/model` → internal endpoint + translated body
2. Calls `app.inject({ method: 'POST', url, headers: { authorization: auth.token }, payload })`
3. Extracts text content + usage from the response
4. Returns `{ model, content, usage, latencyMs }` or throws

`Promise.allSettled` ensures one slow/failing model doesn't block the others.

### Synthesizer Prompt

The synthesizer does both jobs — analysis and final answer — in one pass:

```
You are writing a comprehensive answer to the user's question. Multiple expert
AI models have independently answered the same question. Their responses are
provided below.

Your task:
1. COMPARE the responses — identify where they agree (high confidence), where
   they contradict each other (explain the nuance), and what unique insights
   individual models offered
2. Write a single authoritative answer that is BETTER than any individual
   response by combining the strongest elements

Rules:
- Do NOT mention "models", "responses", "analysis", or the deliberation process
- Write naturally as your own authoritative answer
- Treat points of agreement as high-confidence facts
- Where models disagree, explain the tradeoffs and your reasoning
- Incorporate unique insights that add genuine value
- Note anything important that none of the models addressed

---

<original_conversation>
{user_messages_formatted}
</original_conversation>

---

<model_responses>

[Response 1 — {model_name_1}]
{panel_response_1}

[Response 2 — {model_name_2}]
{panel_response_2}

[Response 3 — {model_name_3}]
{panel_response_3}

</model_responses>
```

### Single Panel Shortcut

If only 1 panel model succeeds (all others failed), there's nothing to compare. The gateway returns that single response directly — no synthesizer call, no extra cost or latency. Metadata shows `fusion.synthesizer.skipped: true`.

---

## Degradation Ladder

| What fails | What happens | Client sees |
|---|---|---|
| 1 of 3 panel models | Continue with 2 responses | Normal response, `fusion.panel.failed: 1` |
| 2 of 3 panel models | Continue with 1 response — return it directly, skip synthesizer | Normal response, `fusion.synthesizer.skipped: true` |
| All panel models | Abort | `503` with `{"error":{"type":"fusion_error","code":"all_panels_failed"}}` |
| Synthesizer fails | Return best panel response as fallback | `200` with longest/first panel response, `fusion.synthesizer.succeeded: false` |
| User lacks access to a panel model | Skip that model before execution | Continue if ≥1 model remains; `403` if none remain |

---

## Usage & Cost

### Per-sub-call events

Every `app.inject()` sub-call creates its own `usage_event` row through the normal proxy path. These are tagged with the user's `token_id` and `user_id`, so they show up in the user's usage dashboard under their respective providers.

### Parent event

The fusion endpoint records one additional parent `usage_event`:
- `provider`: `'fusion'`
- `endpoint`: `'/v1/fusion/chat/completions'`
- `model`: `'fusion/quality'` (or whichever alias)
- `input_tokens`, `output_tokens`: sum of all sub-calls
- `estimated_cost_usd`: sum of all sub-call costs

The sub-call events have the actual provider/model for accurate per-provider cost tracking. The parent event is for "how much did this fusion call cost total."

### Cost expectation

| Preset | Sub-calls | Estimated cost |
|---|---|---|
| `fusion/quality` | 3 panel (Sonnet+GPT+Gemini) + 1 synth (Sonnet) = 4 calls | $0.04 – $0.10 depending on prompt size |
| `fusion/budget` | 3 panel (Gemini+Groq+Cerebras) + 1 synth (Gemini) = 4 calls | $0.001 – $0.003 (Groq/Cerebras are $0) |

---

## Policy & Limits

- **Auth:** Single `sp_*` token, checked once at the fusion endpoint. Sub-calls forward the same token via `app.inject()` headers.
- **Model access:** Checked per-panel-model before dispatch. If user can't use `anthropic/claude-sonnet-*`, that model is dropped from the panel.
- **Provider limits:** Each sub-call checks its provider's limits independently. If user is over their Anthropic daily cap, the Anthropic panel call returns 429 and is treated as a failed panel member.
- **Token-level caps:** Apply across all sub-calls (they share the same `token_id`). A generous daily cap still works because sub-calls record usage as they complete.
- **Recursion:** The fusion endpoint injects `x-fusion-depth: 1` into all sub-call headers. The fusion route rejects any request with `x-fusion-depth >= 1`.

---

## Database Changes

### User custom presets

```sql
CREATE TABLE IF NOT EXISTS fusion_presets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                    -- slug, e.g. 'my-research'
  panel_models_json TEXT NOT NULL,       -- '["anthropic/claude-sonnet-...", ...]'
  synthesizer_model TEXT NOT NULL,
  panel_max_tokens INTEGER DEFAULT 4096,
  synthesizer_max_tokens INTEGER DEFAULT 8192,
  panel_timeout_ms INTEGER DEFAULT 120000,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, name)
);
```

Preset names are validated: lowercase alphanumeric + hyphens, 1–40 chars, must not collide with built-in names (`quality`, `budget`, `custom`).

Model access is checked at **call time**, not at preset creation. If a user saves a preset with `anthropic/claude-opus` but later loses access, that panel call fails gracefully (skipped as a failed panel member).

### Fusion call metadata (audit / dashboard drill-down)

```sql
CREATE TABLE IF NOT EXISTS fusion_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_usage_event_id INTEGER REFERENCES usage_events(id),
  user_id INTEGER REFERENCES users(id),
  preset TEXT,                          -- 'quality', 'budget', 'my-research', 'custom'
  panel_models_json TEXT,               -- '["anthropic/claude-sonnet-...", "openai_codex/gpt-5.5"]'
  synthesizer_model TEXT,
  panel_succeeded INTEGER NOT NULL DEFAULT 0,
  panel_failed INTEGER NOT NULL DEFAULT 0,
  failed_models_json TEXT,              -- '[{"model":"...","error":"..."}]'
  synthesizer_succeeded INTEGER NOT NULL DEFAULT 1,
  synthesizer_skipped INTEGER NOT NULL DEFAULT 0,
  total_latency_ms INTEGER,
  panel_latency_ms INTEGER,
  synthesizer_latency_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_fusion_calls_user ON fusion_calls(user_id, created_at);
```

No changes to `provider_accounts`, `usage_events`, or any existing table. The `fusion` virtual provider never appears in `provider_accounts` — it has no pool accounts, only the underlying real providers do.

---

## Preset Management API

User-facing REST endpoints for custom preset CRUD (also surfaced in the dashboard UI):

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/me/fusion-presets` | List all my saved presets |
| `POST` | `/api/me/fusion-presets` | Create a new preset |
| `PUT` | `/api/me/fusion-presets/:name` | Update an existing preset |
| `DELETE` | `/api/me/fusion-presets/:name` | Delete a preset |

### Create / Update body

```jsonc
{
  "name": "my-research",                // required on create, immutable on update
  "panel": [                            // 1–8 provider-prefixed models
    "anthropic/claude-sonnet-4-5-20250929",
    "xai/grok-4-fast",
    "kimi/kimi-k2.6"
  ],
  "synthesizer": "anthropic/claude-sonnet-4-5-20250929",
  "panel_max_tokens": 4096,             // optional, default 4096
  "synthesizer_max_tokens": 8192,       // optional, default 8192
  "panel_timeout_ms": 120000            // optional, default 120000
}
```

### Validation rules

- `name`: lowercase `[a-z0-9-]`, 1–40 chars, must not be `quality`, `budget`, or `custom`
- `panel`: 1–8 entries, each must be `provider/model` format with a known provider prefix
- `synthesizer`: must be `provider/model` format with a known provider prefix
- Model access is NOT checked at save time — checked at call time (graceful skip)
- Max 20 presets per user

---

## File Layout

```
src/
  proxy/
    fusion.ts              — Route handler, orchestration loop, streaming
  fusion/
    presets.ts             — Built-in presets + user preset DB lookup + resolution
    translate.ts           — Request body translation per provider
    extract.ts             — Response content/usage extraction per provider
    synthesizer.ts         — Synthesizer prompt template
    types.ts               — Shared types (FusionConfig, PanelResult, etc.)
```

`fusion.ts` registers `POST /v1/fusion/chat/completions` in `server.ts`.

Preset CRUD endpoints are registered in `self-api.ts` (alongside existing `/api/me/tokens` etc.).

---

## Model Discovery (`/v1/models`)

Fusion models appear in the `/v1/models` endpoint so clients like Cursor can discover them:

```jsonc
{
  "object": "list",
  "data": [
    // ... existing real models ...
    {"id": "fusion/quality", "object": "model", "owned_by": "nextbase-fusion"},
    {"id": "fusion/budget", "object": "model", "owned_by": "nextbase-fusion"},
    // User's custom presets (only visible to the authenticated user):
    {"id": "fusion/my-research", "object": "model", "owned_by": "nextbase-fusion"}
  ]
}
```

Built-in presets are listed for everyone. User custom presets require auth and are scoped to the requesting user.

---

## Modes

Fusion supports two modes, set via `fusion.mode` in the request body:

| Mode | Behavior | Cost | Use case |
|---|---|---|---|
| `synthesize` (default) | Panel → synthesizer writes final answer | 4 calls | Best possible answer |
| `compare` | Panel only, all responses returned side-by-side | 3 calls | Model evaluation, seeing different perspectives |

In compare mode the synthesizer is skipped entirely. The response contains one `choice` per panel model.

---

## What This Does NOT Do (V1)

- **Web search in panel calls.** Panel models answer from training data only. Adding search means injecting `tools: [{type: "web_search"}]` into panel calls — possible later since `/v1/search` already exists.
- **Conversation history.** Fusion works on single-turn prompts. Multi-turn is possible (pass full message history) but the cost scales linearly with context × panel size.
- **Custom synthesizer prompts.** Fixed template in V1.
- **Caching.** No dedup or caching of panel results across requests.
- **Dashboard fusion analytics.** Fusion calls appear as normal usage events. Dedicated breakdown UI later.
- **`openrouter:fusion` compatibility.** We're not emulating OpenRouter's exact tool/plugin API. This is a gateway-level feature with its own clean API.

---

## Implementation Order

1. **`types.ts` + `presets.ts`** — Type definitions, built-in presets, user preset DB lookup, resolution logic. No side effects, easy to test.
2. **`translate.ts` + `extract.ts`** — Request translation and response extraction per provider. Unit-testable with fixtures.
3. **`synthesizer.ts`** — Prompt template. Pure function.
4. **Migration** — `fusion_presets` + `fusion_calls` tables.
5. **`self-api.ts`** — Preset CRUD endpoints (`/api/me/fusion-presets`).
6. **`fusion.ts`** — Orchestrator route handler. Wires everything together.
7. **`server.ts`** — Register the fusion route.
8. **Tests** — Preset CRUD + end-to-end with mocked `app.inject()`.
