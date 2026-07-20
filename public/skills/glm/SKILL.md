---
name: nextbase-glm-setup
description: Configure Claude Code / OpenClaw for z.ai GLM Coding Plan through Nextbase via a transparent Anthropic Messages passthrough.
---

# GLM (z.ai) via Super Proxy

GLM via Nextbase exposes a transparent Anthropic-compatible Messages endpoint at `/v1/glm/v1/messages` (canonical, what Anthropic SDKs hit when `ANTHROPIC_BASE_URL=.../v1/glm`) — `/v1/glm/messages` also works as a short alias for direct callers. It proxies to z.ai's GLM Coding Plan Anthropic-compatible endpoint (`https://api.z.ai/api/anthropic/v1/messages`) so a Claude-Code / OpenClaw Anthropic request "just works" — the body is forwarded verbatim and the pooled subscription key is injected as `x-api-key`. Use this to run Claude Code against GLM models routed through Nextbase with a single `sp_*` token.

## Models
- `glm-5.2` (default), `glm-5.1`, `glm-5`, `glm-5-turbo`, `glm-4.7`, `glm-4.6`
- There is no `[1m]` / `-1m` long-context variant on this plan (those 400).

## Prerequisites
- A Nextbase proxy token starting with `sp_` (the user will supply it; if missing, ask).

## Step 1 — Verify the token works
```bash
curl -sS -i \
  -H "Authorization: Bearer <YOUR_TOKEN>" \
  http://localhost:8080/v1/token/check
```
Expect HTTP 200 with `{"ok":true,...}`. A 401 means the token is wrong or only the dashboard prefix was pasted.

## Step 2 — Configure Claude Code
GLM is Anthropic-format, so point Claude Code's Anthropic base URL at the gateway's `/v1/glm` route. The gateway accepts the `sp_*` token via either `x-api-key` (Claude Code's default) or `Authorization: Bearer`.

```bash
export ANTHROPIC_BASE_URL="http://localhost:8080/v1/glm"
export ANTHROPIC_AUTH_TOKEN="<YOUR_TOKEN>"   # also accepted as ANTHROPIC_API_KEY
export ANTHROPIC_MODEL="glm-5.2"
claude
```

`settings.json` equivalent (`~/.claude/settings.json`):
```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:8080/v1/glm",
    "ANTHROPIC_AUTH_TOKEN": "<YOUR_TOKEN>",
    "ANTHROPIC_MODEL": "glm-5.2"
  }
}
```

## Step 2b — OpenClaw config (optional)
Merge an Anthropic-shaped provider block into both `~/.openclaw/openclaw.json` under `models.providers.glm` and `~/.openclaw/agents/main/agent/models.json` under `providers.glm`. Because the route is Anthropic-format, use `authHeader: true` so OCPlatform sends Bearer auth.

```json
{
  "models": {
    "providers": {
      "glm": {
        "baseUrl": "http://localhost:8080/v1/glm",
        "authHeader": true,
        "apiKey": "<YOUR_TOKEN>",
        "models": [
          { "id": "glm-5.2", "name": "GLM 5.2" },
          { "id": "glm-5.1", "name": "GLM 5.1" },
          { "id": "glm-5", "name": "GLM 5" },
          { "id": "glm-5-turbo", "name": "GLM 5 Turbo" },
          { "id": "glm-4.7", "name": "GLM 4.7" },
          { "id": "glm-4.6", "name": "GLM 4.6" }
        ]
      }
    }
  }
}
```

## Step 3 — Smoke test
```bash
curl -sS -i \
  -H "x-api-key: <YOUR_TOKEN>" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"glm-5.2","max_tokens":64,"messages":[{"role":"user","content":"pong"}]}' \
  http://localhost:8080/v1/glm/messages
```

## What success looks like
- Curl returns HTTP 200 with a standard Anthropic Messages JSON body (`type:"message"`, `content`, `usage`).
- Response headers include `x-gateway-provider: glm` and `x-gateway-account: <GLM account label>`.

## How it disguises as Claude Code (transparent passthrough)
- The request body is forwarded **verbatim** to `https://api.z.ai/api/anthropic/v1/messages` — `system`, `tools`, `anthropic-beta` betas, and `stream` are untouched.
- Your client's own `user-agent`, `anthropic-beta`, and `x-stainless-*` headers pass through unchanged, so the upstream request keeps the exact Claude-Code fingerprint your client produced.
- Only the auth + hop-by-hop headers are rewritten: the gateway strips your `sp_*` token and injects the pooled subscription key as `x-api-key`, defaulting `anthropic-version: 2023-06-01` if absent.

## Troubleshooting
- 401 token errors usually mean the full `sp_*` secret was not pasted; the dashboard prefix alone is not enough.
- 429 means the token, user, or upstream GLM account hit a quota/cooldown; the gateway auto-rotates accounts and adds `retry-after`.
- A `400` mentioning an unknown model usually means a non-plan id (e.g. a `-1m` variant); use one of the six models above.

## Provider-specific notes
- Default model is `glm-5.2`; unknown/unsupported ids fall back to it and set `x-gateway-glm-fallback`.
- Streaming (SSE) is supported and passed through transparently.
- Cost: the GLM Coding Plan is flat-rate, so usage is recorded as zero-cost usage_events (token counts are still captured for visibility).
