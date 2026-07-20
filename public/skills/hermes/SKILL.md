---
name: nextbase-hermes-setup
description: Configure the Hermes agent (NousResearch/hermes-agent) to route Anthropic, Codex, and OpenAI-compatible traffic through the Super Proxy via config.yaml custom_providers.
---

# Hermes via Super Proxy

Hermes is configured very differently from OCPlatform. OpenClaw uses JSON
(`openclaw.json` + `models.json` + auth profiles); **Hermes uses a single
`~/.hermes/config.yaml`** with a `custom_providers:` list, and the gateway
token is supplied through an environment variable (`key_env`), not an inline
secret.

This skill wires Hermes to the gateway so it can use pooled upstream accounts
(Anthropic / OpenAI Codex / Groq / Cerebras / Kimi / OpenRouter / xAI) without
carrying provider keys locally. The Anthropic path uses the gateway's Hermes
client branch, which is detected automatically — no client flag needed.

## Prerequisites
- A running Hermes install with `~/.hermes/config.yaml`.
- A Nextbase proxy token starting with `sp_` (the user supplies it; if missing, ask).

## Step 1 — Verify the token works
```bash
curl -sS -i \
  -H "Authorization: Bearer <YOUR_TOKEN>" \
  http://localhost:8080/v1/token/check
```
Expect HTTP 200 with `{"ok":true,...}`. A 401 means the full `sp_*` secret
was not pasted (the dashboard prefix alone is not enough).

## Step 2 — Put the token in the environment, not the config
Hermes reads the token from the env var named by `key_env`. Add it to
`~/.hermes/.env` (chmod 600) so it is loaded at startup and never written into
`config.yaml`:

```bash
umask 077
grep -q '^NEXTBASE_MODEL_GATEWAY_API_KEY=' ~/.hermes/.env 2>/dev/null \
  || echo 'NEXTBASE_MODEL_GATEWAY_API_KEY=<YOUR_TOKEN>' >> ~/.hermes/.env
```

## Step 3 — Add the provider to `config.yaml` under `custom_providers:`
Merge this entry into the `custom_providers:` list in `~/.hermes/config.yaml`.
For **Anthropic / Claude** the only mode that works is `anthropic_messages`:

```yaml
custom_providers:
- name: nextbase-anthropic
  base_url: http://localhost:8080
  key_env: NEXTBASE_MODEL_GATEWAY_API_KEY
  api_mode: anthropic_messages
  model: claude-opus-4-6
  models:
    claude-opus-4-6: {}
    claude-sonnet-4-5-20250929: {}
    claude-haiku-4-5: {}
  discover_models: false
```

To make a Claude model the default, point `model:` at the provider:

```yaml
model:
  default: claude-opus-4-6
  provider: custom:nextbase-anthropic
```

### Other gateway providers (same pattern, different base_url + api_mode)
All share `key_env: NEXTBASE_MODEL_GATEWAY_API_KEY` and `discover_models: false`.

| name | base_url suffix | api_mode | example default model |
|---|---|---|---|
| nextbase-anthropic | `` (root) | `anthropic_messages` | claude-opus-4-6 |
| nextbase-codex | `/v1` | `codex_responses` | gpt-5.5 |
| nextbase-xai | `/v1/xai` | `codex_responses` | grok-4.3 |
| nextbase-groq | `/v1/groq` | `chat_completions` | openai/gpt-oss-120b |
| nextbase-cerebras | `/v1/cerebras` | `chat_completions` | qwen-3-235b-a22b-instruct-2507 |
| nextbase-kimi | `/v1/kimi` | `chat_completions` | k3 |
| nextbase-openrouter | `/v1/openrouter` | `chat_completions` | tencent/hy3:free |

Full base_url = `http://localhost:8080` + the suffix.
Example for Groq: `base_url: http://localhost:8080/v1/groq`.

## Step 4 — Restart Hermes
Restart however Hermes runs on this host (systemd unit, `hermes` process, or
docker compose). Example:
```bash
systemctl restart hermes.service 2>/dev/null \
  || (cd ~/.hermes/hermes-agent && docker compose restart) \
  || echo "Restart your Hermes process manually."
```

## Step 5 — Smoke test (Anthropic path)
Hit the gateway exactly as Hermes will, with a tool so the Hermes client
branch is exercised:
```bash
curl -sS -i \
  -H "Authorization: Bearer <YOUR_TOKEN>" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-haiku-4-5","max_tokens":32,"messages":[{"role":"user","content":"reply with exactly: PONG"}]}' \
  http://localhost:8080/v1/messages
```

## What success looks like
- Curl returns HTTP 200.
- Response headers include `x-gateway-provider: anthropic` and `x-gateway-account: <label>`.
- In Hermes, a Claude model selected from `custom:nextbase-anthropic` answers and can call tools.

## How Hermes differs from OCPlatform (why this is a separate skill)
- **Config format:** Hermes = YAML `custom_providers` in `config.yaml`; OCPlatform = JSON across `openclaw.json` / `models.json` / `auth-profiles.json`.
- **Token delivery:** Hermes = env var via `key_env` (`~/.hermes/.env`); OCPlatform = `token` inside an auth profile with `authHeader: true`.
- **Anthropic billing path:** Hermes namespaces MCP tools as `mcp_<tool>`; the gateway detects this and applies the Hermes transform (sdk-cli fingerprint, `mcp__hermes__` namespacing). OCPlatform uses bare tool names and the legacy `cli` fingerprint. Both are handled automatically by the gateway — no client flag to set.
- **Provider modes:** Hermes selects the wire protocol explicitly with `api_mode` (`anthropic_messages` / `codex_responses` / `chat_completions`); OCPlatform infers it from the provider entry.

## Troubleshooting
- **400 "third-party extra usage"** on Anthropic: means the request reached upstream without the Hermes transform. Confirm `api_mode: anthropic_messages` and that the token is a valid `sp_*` OAuth-backed gateway token.
- **401 token errors:** the full `sp_*` secret was not set in `~/.hermes/.env`, or the env var name does not match `key_env`.
- **403 / "IP not allowed":** the token has an IP allow-list that excludes this host.
- **429:** token/user/upstream hit a quota or cooldown; wait or switch account/token.
- **Model not found:** add the exact model id under the provider's `models:` map; Hermes will not auto-discover when `discover_models: false`.
- **Token leaks into config:** never inline the secret in `config.yaml`; keep it in `~/.hermes/.env` referenced by `key_env`.

## Provider-specific notes
- Anthropic streaming is supported (Messages API streams).
- Cost depends on the upstream account routed by the gateway; the `sp_*` token may also carry local spending caps.
- Keep `discover_models: false` and list models explicitly so Hermes does not probe the gateway for a model catalog.
