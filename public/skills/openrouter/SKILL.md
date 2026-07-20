---
name: nextbase-openrouter
summary: Configure OCPlatform/OpenClaw to use Gemini models through OpenRouter via Super Proxy.
---

# OpenRouter Gemini via Super Proxy

OpenRouter is exposed through Nextbase at `/v1/openrouter` using an OpenAI-compatible chat-completions shape.

Important policy:

- OpenRouter is **strict allowlist only** in the gateway.
- Only the Gemini models listed by the gateway are accepted.
- Unknown/non-Gemini OpenRouter model IDs are blocked before upstream.
- Non-admin users may have OpenRouter disabled by default; admins can enable it per user in Model access.

## Provider config

```json
{
  "models": {
    "providers": {
      "openrouter": {
        "baseUrl": "http://localhost:8080/v1/openrouter",
        "apiKey": "<YOUR_sp_TOKEN>",
        "models": [
          { "id": "tencent/hy3:free", "name": "Tencent HY3 Free" }
        ]
      }
    }
  }
}
```

## Auth profile

```json
{
  "profiles": {
    "openrouter:nextbase-gateway": {
      "type": "api_key",
      "provider": "openrouter",
      "key": "<YOUR_sp_TOKEN>"
    }
  }
}
```

## Verify

```bash
curl -sS -i \
  -H "Authorization: Bearer <YOUR_sp_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"model":"tencent/hy3:free","messages":[{"role":"user","content":"pong"}],"max_tokens":16}' \
  http://localhost:8080/v1/openrouter/chat/completions
```

Expected: HTTP 200 with a `choices` array and `x-gateway-provider: openrouter`.

If you get `model_not_allowed_for_user`, enable OpenRouter for that user in the admin Model access tab.
