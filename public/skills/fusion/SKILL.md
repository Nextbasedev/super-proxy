# Fusion — Multi-Model Deliberation

The Super Proxy supports **Fusion** — a multi-model deliberation feature that sends your prompt to multiple AI models in parallel, then synthesizes their responses into a single, better answer.

## Endpoint

```
POST /v1/fusion/chat/completions
```

Auth: `Authorization: Bearer sp_*` (same token as all other gateway endpoints).

## Quick Examples

### Synthesize mode (default) — best answer from multiple models

```bash
curl -sS -H "Authorization: Bearer $sp_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "fusion/quality",
    "messages": [{"role": "user", "content": "Compare Redis vs Memcached for session storage."}],
    "stream": true
  }' \
  http://localhost:8080/v1/fusion/chat/completions
```

### Compare mode — see each model's raw response

```bash
curl -sS -H "Authorization: Bearer $sp_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "fusion/quality",
    "messages": [{"role": "user", "content": "Explain quantum computing."}],
    "fusion": {"mode": "compare"}
  }' \
  http://localhost:8080/v1/fusion/chat/completions
```

### Custom panel (inline, no saved preset)

```bash
curl -sS -H "Authorization: Bearer $sp_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "fusion/custom",
    "messages": [{"role": "user", "content": "Review this design."}],
    "fusion": {
      "panel": ["anthropic/claude-sonnet-4-5-20250929", "xai/grok-4-fast"],
      "synthesizer": "anthropic/claude-sonnet-4-5-20250929"
    }
  }' \
  http://localhost:8080/v1/fusion/chat/completions
```

## Presets

| Model alias | Panel | Synthesizer |
|---|---|---|
| `fusion` or `fusion/quality` | Claude Opus 4.8, GPT-5.5, Gemini 3.1 Pro | Claude Opus 4.8 |
| `fusion/budget` | Claude Sonnet, GPT-5.4, Gemini 3.5 Flash | Claude Sonnet |
| `fusion/custom` | Requires `fusion.panel` in body | Requires `fusion.synthesizer` in body |
| `fusion/<name>` | User's saved custom preset | User's saved custom preset |

## Request Body

Standard OpenAI `/chat/completions` shape with optional `fusion` config:

```json
{
  "model": "fusion/quality",
  "messages": [{"role": "user", "content": "..."}],
  "stream": true,
  "fusion": {
    "mode": "synthesize",
    "panel": ["anthropic/claude-sonnet-4-5-20250929", "openai_codex/gpt-5.5"],
    "synthesizer": "anthropic/claude-sonnet-4-5-20250929",
    "panel_max_tokens": 4096,
    "synthesizer_max_tokens": 8192,
    "panel_timeout_ms": 120000
  }
}
```

When `fusion` body is present, it overrides preset defaults.

## Response

Standard `/chat/completions` response with extra `fusion` metadata:

```json
{
  "id": "fusion-abc123",
  "object": "chat.completion",
  "model": "fusion/quality",
  "choices": [{"index": 0, "message": {"role": "assistant", "content": "..."}, "finish_reason": "stop"}],
  "usage": {"prompt_tokens": 2400, "completion_tokens": 1800, "total_tokens": 4200},
  "fusion": {
    "mode": "synthesize",
    "panel": {"models": ["..."], "succeeded": 3, "failed": 0, "latency_ms": 4200},
    "synthesizer": {"model": "...", "latency_ms": 2200, "succeeded": true},
    "total_latency_ms": 6400
  }
}
```

## Model Discovery

Fusion models appear in `GET /v1/models` so clients like Cursor can list them:

```bash
curl -sS -H "Authorization: Bearer $sp_TOKEN" \
  http://localhost:8080/v1/models
```

## OCPlatform Setup

Fusion uses the `openai-completions` API adapter. The `baseUrl` must end with `/v1/fusion` — the adapter appends `/chat/completions` to form the full endpoint URL.

**Important:** The model IDs contain a slash (`fusion/quality`), so the full OpenClaw model reference is `fusion/fusion/quality` (provider name / model ID). This is how OpenClaw namespaces models.

### Provider block — merge into `openclaw.json` and `models.json`

```json
{
  "models": {
    "providers": {
      "fusion": {
        "baseUrl": "http://localhost:8080/v1/fusion",
        "apiKey": "<YOUR_TOKEN>",
        "api": "openai-completions",
        "models": [
          { "id": "fusion/max", "name": "Fusion Max", "reasoning": true, "input": ["text"], "contextWindow": 200000, "maxTokens": 8192 },
          { "id": "fusion/quality", "name": "Fusion Quality", "reasoning": true, "input": ["text"], "contextWindow": 200000, "maxTokens": 8192 },
          { "id": "fusion/budget", "name": "Fusion Budget", "reasoning": true, "input": ["text"], "contextWindow": 200000, "maxTokens": 8192 }
        ]
      }
    }
  }
}
```

### Auth profile — merge into `auth-profiles.json`

```json
{
  "profiles": {
    "fusion:nextbase-gateway": {
      "type": "api_key",
      "provider": "fusion",
      "key": "<YOUR_TOKEN>"
    }
  }
}
```

### Agent defaults — merge into `openclaw.json`

**Critical:** Without this, `/models` won't list fusion models and `/model` won't accept them.

```json
{
  "agents": {
    "defaults": {
      "models": {
        "fusion/fusion/max": {},
        "fusion/fusion/quality": {},
        "fusion/fusion/budget": {}
      }
    }
  }
}
```

### Verify

```bash
# Check token
curl -sS -H "Authorization: Bearer <YOUR_TOKEN>" \
  http://localhost:8080/v1/token/check

# Test fusion directly
curl -sS -H "Authorization: Bearer <YOUR_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"model":"fusion/budget","messages":[{"role":"user","content":"pong"}]}' \
  http://localhost:8080/v1/fusion/chat/completions
```

Then in OpenClaw: `/model fusion/fusion/quality`

### Key notes

- `api` must be `"openai-completions"` (not `"openai-chat-completions"` — that doesn't exist)
- `baseUrl` must end with `/v1/fusion` — the adapter appends `/chat/completions` automatically
- Model refs in OpenClaw are `fusion/fusion/max`, `fusion/fusion/quality`, `fusion/fusion/budget` (double `fusion/` because the provider is named `fusion` and the model IDs start with `fusion/`)
- No `authHeader: true` needed — the apiKey on the provider block handles auth
- Add all three models to `agents.defaults.models` or they won't appear in `/models`

## Provider Prefixes

Panel and synthesizer models use `provider/model` format:

| Prefix | Provider |
|---|---|
| `anthropic/` | Anthropic (Claude) |
| `openai_codex/` | OpenAI/Codex (GPT) |
| `gemini/` | Google Gemini |
| `groq/` | Groq |
| `cerebras/` | Cerebras |
| `kimi/` | Kimi/Moonshot |
| `xai/` | xAI (Grok) |
| `openrouter/` | OpenRouter |
