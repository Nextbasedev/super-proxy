# Routing OpenClaw / Ampere through Nextbase Model Gateway

This guide is for any developer who needs to point an OpenClaw install (local
or Ampere-hosted) at the Nextbase Model Gateway for Anthropic and/or Codex
traffic.

> **Public base URL:** `https://nextbase-model-gateway.infinitycorp.tech`
>
> The gateway exposes:
> - Anthropic-compatible: `POST /v1/messages`
> - Raw Anthropic for Claude Code overrides: `POST /v1/anthropic-raw/v1/messages` (base URL `/v1/anthropic-raw`)
> - OpenAI-compatible:   `POST /v1/responses`, `POST /v1/chat/completions`
> - Image-compatible:    `POST /v1/images/generations`, `POST /v1/images/edits`
> - Kimi OpenAI-compatible: `POST /v1/kimi/chat/completions`
> - Kimi Anthropic-compatible: `POST /v1/kimi/messages`
> - Cerebras OpenAI-compatible: `POST /v1/cerebras/chat/completions`
> - Fusion (multi-model): `POST /v1/fusion/chat/completions`
> - Model discovery:     `GET /v1/models`
>
> Auth: every request must send `Authorization: Bearer <nbmg_*>` (preferred).
> The gateway also accepts the same token via `x-api-key` and `x-goog-api-key`
> for compatibility, but client code should default to the Authorization header.

## 1. Get a personal proxy token

1. Visit `https://nextbase-model-gateway.infinitycorp.tech/`.
2. Sign in with Google (must be on the allowlist — ask an admin to add you).
3. Open **My API tokens** and create a new token.
4. The token starts with `nbmg_`. Treat it like a secret. Never commit it.

The same token works for Anthropic (`/v1/messages`), Codex
(`/v1/responses`, `/v1/chat/completions`), image generation
(`/v1/images/generations`, `/v1/images/edits`), Kimi
(`/v1/kimi/chat/completions`, `/v1/kimi/messages`), and Cerebras
(`/v1/cerebras/chat/completions`). Per-token usage limits and
usage visibility are available in your dashboard.

## 2. Local OpenClaw install (e.g. your dev machine)

OpenClaw reads provider config from two files:

- `~/.openclaw/openclaw.json` — main config (source of truth).
- `~/.openclaw/agents/main/agent/models.json` — agent-level provider override
  consumed by the runtime; this is what actually overrides built-in baseUrls.
- `~/.openclaw/agents/main/agent/auth-profiles.json` — credential store.

Both `openclaw.json` and `models.json` need the provider entry. Always keep
them in sync.

> Tip: back up the file before edits — `cp file file.bak-$(date +%s)`.

### 2a. Anthropic via Nextbase

Patch the Anthropic provider in **both** files:

```json
"models": {
  "providers": {
    "anthropic": {
      "baseUrl": "https://nextbase-model-gateway.infinitycorp.tech",
      "authHeader": true,
      "models": []
    }
  }
}
```

`authHeader: true` forces OpenClaw to send `Authorization: Bearer <key>`
instead of `x-api-key`. The gateway's Anthropic OAuth path requires Bearer.

Then set the credential. Edit
`~/.ocplatform/agents/main/agent/auth-profiles.json`:

```json
"anthropic:manual": {
  "type": "token",
  "provider": "anthropic",
  "token": "nbmg_<your_token>"
}
```

Make sure `~/.openclaw/agents/main/agent/auth-state.json` has
`"lastGood": { "anthropic": "anthropic:manual" }` so this profile is preferred.

Restart the gateway:

```bash
systemctl restart openclaw-gateway.service   # service mode
# or just relaunch your local OpenClaw process
```

### 2b. Codex via Nextbase

For OpenClaw 2026.5.7+, Codex has two separate routes:

- `openai-codex/gpt-*` = Codex OAuth/subscription through the normal OpenClaw PI runner. **Use this route for Nextbase.**
- `openai/gpt-*` with `agents.defaults.agentRuntime.id: "codex"` = native Codex app-server runtime. This talks to ChatGPT/Codex directly and **bypasses Nextbase**.

To route through Nextbase, keep the model ref as `openai-codex/gpt-5.5` and set the URL on `models.providers["openai-codex"].baseUrl`. Do **not** switch this provider to `api: "openai-codex-responses"`; that transport calls `chatgpt.com/backend-api` directly.

Use the Ampere-style provider entry — `apiKey` directly on the provider, not via auth profile rotation:

```json
"openai-codex": {
  "baseUrl": "https://nextbase-model-gateway.infinitycorp.tech/v1",
  "api": "openai-responses",
  "apiKey": "nbmg_<your_token>",
  "models": [
    {
      "id": "gpt-5.5",
      "name": "GPT-5.5",
      "reasoning": true,
      "input": ["text", "image"],
      "contextWindow": 400000,
      "maxTokens": 128000
    }
  ]
}
```

Add this block to **both** `openclaw.json` (`models.providers["openai-codex"]`)
and `models.json` (`providers["openai-codex"]`).

Set the auth profile to api_key mode:

```json
"openai-codex:nextbase-gateway": {
  "type": "api_key",
  "provider": "openai-codex",
  "key": "nbmg_<your_token>"
}
```

And in `auth-state.json`:

```json
"lastGood": { "openai-codex": "openai-codex:nextbase-gateway" },
"order":    { "openai-codex": ["openai-codex:nextbase-gateway", ...] }
```

Restart the gateway.


### 2c. OpenAI Images / `gpt-image-2` via Nextbase

OpenClaw's image generation plugin uses the regular OpenAI provider and calls
`POST /v1/images/generations` or `POST /v1/images/edits`. Point the `openai`
provider at Nextbase in **both** files:

```json
"openai": {
  "baseUrl": "https://nextbase-model-gateway.infinitycorp.tech/v1",
  "apiKey": "nbmg_<your_token>",
  "models": []
}
```

Optional auth profile if your runtime uses provider auth-state rotation:

```json
"openai:nextbase-gateway": {
  "type": "api_key",
  "provider": "openai",
  "key": "nbmg_<your_token>"
}
```

And prefer it in `~/.openclaw/agents/main/agent/auth-state.json`:

```json
"lastGood": { "openai": "openai:nextbase-gateway" },
"order": { "openai": ["openai:nextbase-gateway"] }
```

How routing works:

1. If the gateway has a real OpenAI API-key provider account (`provider='openai'`),
   it forwards `/v1/images/*` directly to `https://api.openai.com/v1/images/*`.
2. If no OpenAI API-key account exists, it falls back to Codex / ChatGPT OAuth:
   the gateway converts the Images API request into a Responses API request with
   the built-in `image_generation` tool, runs it against a Codex account, then
   returns the standard OpenAI Images API response shape
   `{ "created": ..., "data": [{ "b64_json": "..." }] }`.

This is why `model: "gpt-image-2"` works from OpenClaw even though ChatGPT
OAuth does **not** expose `/v1/images/generations` directly.


### 2d. Kimi via Nextbase

Kimi exposes both OpenAI-compatible and Anthropic-compatible routes under the same gateway base:

```json
"kimi": {
  "baseUrl": "https://nextbase-model-gateway.infinitycorp.tech/v1/kimi",
  "apiKey": "nbmg_<your_token>",
  "models": [
    { "id": "k3", "name": "Kimi K3" },
    { "id": "kimi-k2.6", "name": "Kimi K2.6" },
    { "id": "kimi-for-coding", "name": "Kimi for Coding" }
  ]
},
"kimi-anthropic": {
  "baseUrl": "https://nextbase-model-gateway.infinitycorp.tech/v1/kimi",
  "authHeader": true,
  "models": []
}
```

Use `kimi` for OpenAI-compatible `/chat/completions` clients. Use `kimi-anthropic` for Anthropic-compatible `/messages` clients; `authHeader: true` ensures Bearer auth.

K3 uses the exact model ID `k3`, supports K3 reasoning controls such as `reasoning_effort: "max"`, and has plan-dependent context entitlement (256k on Moderato; up to 1M on Allegretto+). Kimi has no configured RPM/RPD/TPM/TPD buckets. It uses sticky routing, per-account in-flight concurrency (`max_in_flight`, default 10), and upstream `429` cooldown based on `Retry-After` (default 60s). Unknown Kimi model names fall back to `kimi-k2.6` and include `x-gateway-kimi-fallback`.

### 2e. Cerebras via Nextbase

Cerebras uses an OpenAI-compatible provider pointed at the gateway's Cerebras prefix:

```json
"cerebras": {
  "baseUrl": "https://nextbase-model-gateway.infinitycorp.tech/v1/cerebras",
  "apiKey": "nbmg_<your_token>",
  "models": [
    { "id": "gpt-oss-120b", "name": "Cerebras GPT OSS 120B" },
          { "id": "zai-glm-4.7", "name": "Cerebras Z.ai GLM 4.7" }
  ]
}
```

Optional auth profile if your runtime uses provider auth-state rotation:

```json
"cerebras:nextbase-gateway": {
  "type": "api_key",
  "provider": "cerebras",
  "key": "nbmg_<your_token>"
}
```

And prefer it in `~/.openclaw/agents/main/agent/auth-state.json`:

```json
"lastGood": { "cerebras": "cerebras:nextbase-gateway" },
"order": { "cerebras": ["cerebras:nextbase-gateway"] }
```

Cerebras supports per-account, per-model RPM/RPD/TPM/TPD buckets in the admin console. Unknown Cerebras model names fall back to `gpt-oss-120b` and include `x-gateway-cerebras-fallback`. Upstream `429` responses set a model cooldown using `Retry-After` (default 60s) and retry another eligible account. Cerebras usage cost is currently recorded as `$0`.

### 2f. Verify routing

First verify the token itself. This does not call an upstream model and does not spend credits:

```bash
curl -sS -i \
  -H "Authorization: Bearer nbmg_..." \
  https://nextbase-model-gateway.infinitycorp.tech/v1/token/check
```

Expected: HTTP 200 with `{ "ok": true }`. If you get `401 Invalid or disabled API token`, the token pasted into OpenClaw is wrong, truncated, disabled, or only the `nbmg_...` prefix.

```bash
# Should hit nextbase + return 200
curl -sS -i \
  -H "Authorization: Bearer nbmg_..." \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-sonnet-4-5-20250929","max_tokens":16,"messages":[{"role":"user","content":"pong"}]}' \
  https://nextbase-model-gateway.infinitycorp.tech/v1/messages | head -20

# Codex
curl -sS -N \
  -H "Authorization: Bearer nbmg_..." \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.5","stream":true,"input":[{"role":"user","content":[{"type":"input_text","text":"pong"}]}]}' \
  https://nextbase-model-gateway.infinitycorp.tech/v1/responses


# Kimi OpenAI-compatible
curl -sS -i \
  -H "Authorization: Bearer nbmg_..." \
  -H "Content-Type: application/json" \
  -d '{"model":"kimi-k2.6","messages":[{"role":"user","content":"pong"}]}' \
  https://nextbase-model-gateway.infinitycorp.tech/v1/kimi/chat/completions | head -20

# Kimi Anthropic-compatible
curl -sS -i \
  -H "Authorization: Bearer nbmg_..." \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"kimi-k2.6","max_tokens":16,"messages":[{"role":"user","content":"pong"}]}' \
  https://nextbase-model-gateway.infinitycorp.tech/v1/kimi/messages | head -20

# Cerebras OpenAI-compatible
curl -sS -i \
  -H "Authorization: Bearer nbmg_..." \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-oss-120b","messages":[{"role":"user","content":"pong"}]}' \
  https://nextbase-model-gateway.infinitycorp.tech/v1/cerebras/chat/completions | head -20

# Image generation (OpenAI Images API shape; served by OpenAI API key if
# configured, otherwise by Codex OAuth + image_generation tool adapter)
curl -sS -i \
  -H "Authorization: Bearer nbmg_..." \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-image-2","prompt":"a small duck swimming in water","size":"1024x1024","n":1}' \
  https://nextbase-model-gateway.infinitycorp.tech/v1/images/generations | head -20
```

Responses include gateway headers such as `x-gateway-account` (and
`x-gateway-attempt` on retrying text routes). Image responses may also include
`x-gateway-image-mode: codex-responses-tool` when served by the Codex OAuth
adapter. Identical `x-conversation-id` requests stick to the same account
(sticky routing).

## 3. Ampere-hosted instances

Ampere provisioning lives in
`projects/ampere/repos/ampere-infra/orchestrator/src/`.

- Default model allowlist:    `shared/src/model-allowlist.ts`
  (`anthropic/claude-opus-4-7`, `openai-codex/gpt-5.5`, etc.)
- Container `openclaw.json`: `orchestrator/src/config-gen.ts`
  → `buildNonByokProviders()` decides which providers to inject.
- Per-instance `models.json`:  `orchestrator/src/instance-provisioning.ts`,
  `orchestrator/src/instance-crud.ts`,
  `orchestrator/src/routes/instance-routes/model.ts`.

To make Ampere route an instance through Nextbase instead of its own api-proxy
for a given provider, change the relevant block in `model.ts` so the provider's
`baseUrl` points at Nextbase and the `apiKey` is the user's Nextbase
`nbmg_*` token. Anthropic also needs `authHeader: true` (Bearer). Codex must
remain the `openai-codex` provider with `api: "openai-responses"`; do not set
`agentRuntime.id: "codex"` for Nextbase-routed traffic because the native Codex
runtime bypasses OpenAI-compatible provider URLs.

Smart-router (`ampere/auto`) flows are still handled by Ampere's api-proxy —
do not retarget those at Nextbase without coordinating with the api-proxy team.

## 4. Sticky routing & retries

- **Anthropic:** sticky by `user.email + token.label + (x-conversation-id |
  anthropic-session-id | model)`. Retries up to 10 times across other accounts
  on rate-limit / temporary upstream failures.
- **Images:** `/v1/images/*` prefers real OpenAI API-key accounts. If none are
  configured, it falls back to Codex OAuth and converts the request to a
  Responses API `image_generation` tool call; sticky routing uses
  `user.email + token.label + model`.
- **Codex:** sticky by `user.email + token.label + (x-conversation-id |
  session_id | x-client-request-id | previous_response_id | model)`. Retries
  fall through to remaining eligible Codex accounts on retryable failures.
- **Kimi:** sticky by `user.email + token.label + (x-conversation-id |
  session_id | x-client-request-id | conversation_id | model | endpoint)`. No token/request buckets; skips accounts at `max_in_flight` (default 10) or in `cooldown_until`, and cools down on upstream `429` using `Retry-After`.
- **Cerebras:** sticky by `user.email + token.label + (x-conversation-id |
  session_id | x-client-request-id | conversation_id | model)`. Skips active account/model cooldowns and per-model RPM/RPD/TPM/TPD bucket exhaustion; cools down on upstream `429` using `Retry-After`.

If you want a single conversation to stay on one upstream account (better
prompt cache reuse), pass a stable `x-conversation-id` header.

## 5. Common pitfalls

- **`401 invalid x-api-key` from Anthropic upstream.** OpenClaw sent
  `x-api-key` to Nextbase; Nextbase strips that header before forwarding to
  Anthropic, but make sure your Anthropic provider has `authHeader: true` so
  OpenClaw sends a Bearer token instead. Older configs that point at
  `api.anthropic.com` directly should be removed.
- **OpenClaw 2026.5.7 native Codex bypasses Nextbase.** If config uses
  `agents.defaults.agentRuntime.id: "codex"` with `openai/gpt-*`, the native
  Codex app-server runtime talks to ChatGPT/Codex directly. For Nextbase usage
  logging/governor/routing, use `openai-codex/gpt-*` and the provider block
  above instead.
- **`No API key found for provider "openai-codex"`.** Either the provider
  block is missing `apiKey` in `models.json`, or the `auth-state.json`
  `lastGood` is pointing at a stale OAuth profile. Set both.
- **Model not supported.** ChatGPT Codex backend only accepts the Codex 5.x
  family today. Use `gpt-5.5`, `gpt-5.4`, `gpt-5.3-codex`, etc. Older names
  like `gpt-5`, `gpt-5-codex`, `codex-mini-latest` are rejected upstream.
- **Logs show `0` tokens / `$0` cost for Codex.** You're on a build before the
  `fix(codex): record token usage` commit. Pull main and redeploy.
- **Image generation 404s or bypasses Nextbase.** The local OpenClaw `openai`
  provider is missing or still points directly at `api.openai.com`. Add
  `models.providers.openai.baseUrl = "https://nextbase-model-gateway.infinitycorp.tech/v1"`
  in both `~/.openclaw/openclaw.json` and
  `~/.openclaw/agents/main/agent/models.json`.
- **`model: "gpt-image-2"` fails on `/v1/responses`.** For ChatGPT OAuth,
  `gpt-image-2` is used as an `image_generation` tool, not as the primary
  Responses model. Use `/v1/images/generations` through Nextbase, or call
  `/v1/responses` with a text model like `gpt-5.5` plus
  `tools: [{ "type": "image_generation" }]`.

## 6. Where to look in this repo

- Anthropic proxy:           `src/proxy/anthropic.ts`
- Claude Code transform:     `src/anthropic/claude-code-transform.ts`
- OpenAI / Codex proxy:      `src/proxy/openai.ts`
- Codex pool (sticky):       `src/providers/codex-pool.ts`
- Anthropic governor:        `src/providers/governor.ts`
- Auth (proxy tokens):       `src/auth/token-auth.ts`
- DB schema/migrations:      `src/db/migrate.ts`
- Build spec / decisions:    `docs/SPEC.md`
- Operational deploy:        `docs/DEPLOY.md`

### 2e. Groq via Nextbase

Groq uses an OpenAI-compatible provider pointed at the gateway's Groq prefix:

```json
"groq": {
  "baseUrl": "https://nextbase-model-gateway.infinitycorp.tech/v1/groq",
  "apiKey": "nbmg_<your_token>",
  "models": [
    { "id": "openai/gpt-oss-120b", "name": "Groq GPT OSS 120B" }
  ]
}
```

Verification:

```bash
curl -sS -i \
  -H "Authorization: Bearer nbmg_..." \
  -H "Content-Type: application/json" \
  -d '{"model":"openai/gpt-oss-120b","messages":[{"role":"user","content":"pong"}]}' \
  https://nextbase-model-gateway.infinitycorp.tech/v1/groq/chat/completions
```

Unknown Groq model names fall back to `openai/gpt-oss-120b` and include `x-gateway-groq-fallback` in the response headers.

## 3. Time-bounded grants

A **grant** is a per-user temporary override that lets a specific user use a
specific `(provider, model_pattern)` for a bounded window. Useful when:

- A developer needs to use `claude-opus-4-7` for the week of a release but
  their role default caps Anthropic at `claude-haiku`.
- A contractor needs Groq for a 24h spike test.
- An admin wants to temporarily grant extra USD to one person without
  changing the global role default.

Grants always live *above* the `role_limits` / `user_limits` ladder. While an
active grant matches, its caps replace the user/role caps for the call. Token
caps (`api_tokens.cap_usd_daily`, `cap_tokens_daily`) and founder/admin bypass
are unchanged.

See `docs/grants.md` for the full schema, API, and worked examples.

## Per-user model access

Admins can turn individual known models on/off per user without changing routing configuration. Default is allowed; OFF writes a deny row for that user/model. Exact per-model grants can temporarily override a deny, but wildcard grants cannot. See [`model-access.md`](./model-access.md).


## Current Cerebras upstream limits
- Models: `gpt-oss-120b` (Production, 65,536 context) and `zai-glm-4.7` (Preview, 64,000 context).
- Per-model account limits: 5 requests/minute, 150 requests/hour, 2,400 requests/day; 30,000 tokens/minute, 1,000,000 tokens/hour, 1,000,000 tokens/day.


## Fusion (multi-model deliberation)

Fusion sends your prompt to multiple models in parallel, then a synthesizer
model compares their responses and writes a better final answer.

### Quick start

```bash
# Quality preset (Claude Sonnet + GPT-5.5 + Gemini Flash → Sonnet synthesizer)
curl -sS -N \
  -H "Authorization: Bearer nbmg_..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "fusion/quality",
    "stream": true,
    "messages": [{"role": "user", "content": "Compare microservices vs monolith for a 5-person startup."}]
  }' \
  https://nextbase-model-gateway.infinitycorp.tech/v1/fusion/chat/completions

# Budget preset (Gemini Flash + Groq Llama 70B + Cerebras GPT-OSS → Gemini synthesizer)
curl -sS \
  -H "Authorization: Bearer nbmg_..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "fusion/budget",
    "messages": [{"role": "user", "content": "What are the tradeoffs of Rust vs Go for CLI tools?"}]
  }' \
  https://nextbase-model-gateway.infinitycorp.tech/v1/fusion/chat/completions

# Compare mode — see all panel responses side-by-side, no synthesis
curl -sS \
  -H "Authorization: Bearer nbmg_..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "fusion/quality",
    "messages": [{"role": "user", "content": "Explain quantum computing."}],
    "fusion": {"mode": "compare"}
  }' \
  https://nextbase-model-gateway.infinitycorp.tech/v1/fusion/chat/completions

# Custom inline (no saved preset needed)
curl -sS \
  -H "Authorization: Bearer nbmg_..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "fusion/custom",
    "messages": [{"role": "user", "content": "Review this architecture."}],
    "fusion": {
      "panel": ["anthropic/claude-sonnet-4-5-20250929", "xai/grok-4-fast"],
      "synthesizer": "anthropic/claude-sonnet-4-5-20250929"
    }
  }' \
  https://nextbase-model-gateway.infinitycorp.tech/v1/fusion/chat/completions
```

### Available presets

| Model | Panel | Synthesizer | Cost |
|---|---|---|---|
| `fusion` / `fusion/quality` | Claude Opus 4.8 + GPT-5.5 + Gemini 3.1 Pro | Claude Opus 4.8 | ~$0.10-0.30 |
| `fusion/budget` | Claude Sonnet + GPT-5.4 + Gemini 3.5 Flash | Claude Sonnet | ~$0.03-0.08 |
| `fusion/custom` | Provide `fusion.panel` in request body | Provide `fusion.synthesizer` | Varies |
| `fusion/<your-preset>` | Saved via dashboard | Saved via dashboard | Varies |

### Custom presets

Create custom presets in the dashboard under **Fusion → Presets**, or via API:

```bash
# Create a preset
curl -sS \
  -b <session_cookie> \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-research",
    "panel": ["anthropic/claude-sonnet-4-5-20250929", "xai/grok-4-fast", "kimi/kimi-k2.6"],
    "synthesizer": "anthropic/claude-sonnet-4-5-20250929"
  }' \
  https://nextbase-model-gateway.infinitycorp.tech/api/me/fusion-presets

# Use it
curl -sS \
  -H "Authorization: Bearer nbmg_..." \
  -H "Content-Type: application/json" \
  -d '{"model": "fusion/my-research", "messages": [{"role": "user", "content": "..."}]}' \
  https://nextbase-model-gateway.infinitycorp.tech/v1/fusion/chat/completions
```

### Model discovery

Fusion models appear in the `/v1/models` endpoint (OpenAI-compatible). Clients
like Cursor will see fusion presets in their model dropdown:

```bash
curl -sS -H "Authorization: Bearer nbmg_..." \
  https://nextbase-model-gateway.infinitycorp.tech/v1/models
```

### Modes

- **`synthesize`** (default): Panel models answer → synthesizer writes the final answer.
- **`compare`**: Panel models answer → all responses returned side-by-side. No synthesis. Pass `"fusion": {"mode": "compare"}` in the request body.

### How it works

1. Your prompt goes to N panel models in parallel (via `app.inject()` through the gateway's own proxy endpoints).
2. Each panel call inherits full auth, pooling, retries, cooldowns, and usage recording.
3. If `mode=synthesize` (default), a synthesizer model receives all panel responses and writes a single authoritative answer.
4. If `mode=compare`, all panel responses are returned as separate `choices` in the response.
5. Every sub-call records its own `usage_event`. The fusion endpoint records a parent event summing total cost.

### Cost

- `fusion/quality`: 3 panel calls + 1 synthesizer = 4 LLM calls (~$0.04-0.10 per request)
- `fusion/budget`: 3 panel calls + 1 synthesizer = 4 LLM calls (~$0.001 per request, Groq/Cerebras are free)
- Compare mode: N panel calls only (no synthesizer), slightly cheaper
- No markup — cost = sum of underlying provider costs
