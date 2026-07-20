---
name: nextbase-runpod-setup
description: Configure OCPlatform/OpenClaw to use Runpod Serverless Qwen through Super Proxy.
---

# Runpod Serverless via Super Proxy

Runpod is exposed through Nextbase at `/v1/runpod` using an OpenAI-compatible chat-completions shape.

## Models

- `qwen36-27b` — normal Qwen3.6 27B route
- `qwen36-27b-fast` — same upstream model with `chat_template_kwargs.enable_thinking=false` injected unless the caller explicitly sets it

Both virtual model IDs route to the configured Runpod Serverless OpenAI endpoint. Usage is logged at zero estimated cost inside the gateway.

## Policy

- Requires a valid `sp_*` token.
- Non-admin users are denied by default until Runpod is enabled in Model access or granted.
- Provider accounts use `secret = RUNPOD_API_KEY` and `account_id = RUNPOD_ENDPOINT_ID`.
- Production env fallback can seed one account from `RUNPOD_API_KEY` + `RUNPOD_ENDPOINT_ID`.

## Provider config

```json
{
  "models": {
    "providers": {
      "runpod": {
        "baseUrl": "http://localhost:8080/v1/runpod",
        "apiKey": "<YOUR_sp_TOKEN>",
        "models": [
          { "id": "qwen36-27b", "name": "Qwen3.6 27B" },
          { "id": "qwen36-27b-fast", "name": "Qwen3.6 27B Fast" }
        ]
      }
    }
  }
}
```

## Auth profile

```json
{
  "runpod:nextbase-gateway": {
    "type": "api_key",
    "provider": "runpod",
    "key": "<YOUR_sp_TOKEN>"
  }
}
```

## Smoke tests

Check auth without spending model credits:

```bash
curl -sS -i \
  -H "Authorization: Bearer <YOUR_sp_TOKEN>" \
  http://localhost:8080/v1/token/check
```

List Runpod virtual models:

```bash
curl -sS \
  -H "Authorization: Bearer <YOUR_sp_TOKEN>" \
  http://localhost:8080/v1/runpod/models
```

Run a tiny chat request:

```bash
curl -sS http://localhost:8080/v1/runpod/chat/completions \
  -H "Authorization: Bearer <YOUR_sp_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen36-27b-fast",
    "messages": [{"role":"user","content":"Say hello in one sentence."}],
    "max_tokens": 64
  }'
```

## Notes

- `qwen36-27b-fast` disables thinking by default for lower-latency direct answers.
- If the user explicitly sets `chat_template_kwargs.enable_thinking`, the gateway preserves their value.
- 429 usually means Runpod endpoint/account concurrency or cooldown is exhausted.
