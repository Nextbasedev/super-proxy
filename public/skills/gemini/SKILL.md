---
name: nextbase-gemini
description: Configure an agent client to use the native Gemini free-tier pool (embeddings, chat, TTS) through Super Proxy.
---

# Gemini via Super Proxy

Native Gemini is exposed through Nextbase under `/v1/gemini/*` as **OpenAI-compatible** routes, backed by a pool of free-tier Gemini API keys (each a separate Google Cloud project). The gateway rotates across keys by lowest daily usage, proactively skips keys near their per-model daily cap, and fails over on `429` — so the tiny per-key free-tier limits add up across the pool.

> This is **distinct** from the `openrouter` provider's Gemini models. Those route OpenAI-style chat to OpenRouter's paid Gemini. This native pool is the free-tier one, and its main job is **pooled embeddings for memory search**.

## Routes

- `POST /v1/gemini/embeddings` — OpenAI-shape embeddings (primary use: memorySearch)
- `POST /v1/gemini/chat/completions` — OpenAI-shape chat (non-streaming)
- `POST /v1/gemini/tts` — text-to-speech, returns a WAV (24 kHz / 16-bit / mono)
- `GET  /v1/gemini/realtime` (WebSocket) — Gemini **Live** realtime audio relay
- `POST /v1/gemini/realtime/client_secrets` — mint an ephemeral Live token

Gemini **Live** (realtime bidirectional audio) is a WebSocket session, not a chat
call. See **[LIVE.md](./LIVE.md)** for models, the relay/ephemeral connection
flows, and the current upstream allowlist gate.

## Models

- Embeddings: `gemini-embedding-2` (stable, 3072-dim), `gemini-embedding-2-preview`, `gemini-embedding-001`
- Chat: `gemini-3.1-flash-lite` (and other flash-lite variants)
- Video understanding: `gemini-3.5-flash` (recommended), `gemini-2.5-flash` — send a video to the chat route. See **[VIDEO-UNDERSTANDING.md](./VIDEO-UNDERSTANDING.md)** for endpoint, request shape, size/length limits, and how to cut long videos.
- TTS: `gemini-2.5-flash-preview-tts` (default voice `Kore`)

Only known Gemini model IDs are allowed; unknown models return `400`.

## Set up embeddings in your OCPlatform (step by step)

This wires OCPlatform's **built-in `memorySearch`** (semantic search over your workspace files) to the gateway's pooled Gemini embeddings. You don't need any custom memory system — `memorySearch` ships with OCPlatform; you just point it at us.

### 1. Get a gateway token

Ask your gateway admin for an `sp_*` API token (or mint one in the console under **Tokens**). This single token is all your OCPlatform needs — it never sees the upstream Gemini keys.

### 2. Open your OCPlatform config

Edit `~/.openclaw/openclaw.json` (the file behind your OCPlatform install). Back it up first:

```bash
cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak
```

### 3. Add the `memorySearch` block

Put it under `agents.defaults` so it applies to every agent (or under a specific agent if you prefer). Merge this into your existing JSON — don't overwrite the whole file:

```json
{
  "agents": {
    "defaults": {
      "memorySearch": {
        "enabled": true,
        "provider": "openai",
        "model": "gemini-embedding-2",
        "extraPaths": ["docs/", "reports/"],
        "remote": {
          "baseUrl": "http://localhost:8080/v1/gemini",
          "apiKey": "sp_YOUR_TOKEN_HERE"
        }
      }
    }
  }
}
```

What each field does:
- `provider: "openai"` — OCPlatform talks OpenAI-shape embeddings; the gateway's `/v1/gemini` route speaks that shape, so no custom provider code is needed.
- `model: "gemini-embedding-2"` — the embedding model (3072-dim). Keep this fixed; changing the model id forces a full re-embed.
- `extraPaths` — optional extra folders (relative to your workspace) to index beyond the defaults. Drop it to use defaults only.
- `remote.baseUrl` — must end in `/v1/gemini` (OCPlatform appends `/embeddings`).
- `remote.apiKey` — your `sp_*` token.

### 4. Restart OpenClaw

```bash
# system-service install
systemctl restart openclaw-gateway.service
# or, if you run it directly, restart your openclaw process
```

### 5. Build the index

The index builds automatically the first time memorySearch runs. To build it now and watch progress:

```bash
openclaw memory index --force
openclaw memory status   # shows Provider openai / Model gemini-embedding-2 / Indexed N files
```

That's it — `memory_search` now returns semantic hits over your files, embedded through the pooled gateway. Re-running `openclaw memory index` after adding files only embeds the new/changed chunks (progress is cached).

> The model stays a Gemini embedding model and only the route changes, so an index already built on `gemini-embedding-2` stays vector-compatible — no re-embed when the model id matches.

### Heads-up on free-tier throughput

Embeddings free-tier is **per key per day** (Pacific-midnight reset). A large first-time index can exhaust the daily pool and pause partway — it resumes automatically next day, or your admin can add more pooled keys. Small/incremental indexes are fine.

## Optional — chat provider snippet

```json
{
  "models": {
    "providers": {
      "gemini-nextbase": {
        "baseUrl": "http://localhost:8080/v1/gemini",
        "apiKey": "<YOUR_TOKEN>",
        "models": [
          { "id": "gemini-3.1-flash-lite", "name": "Gemini 3.1 Flash Lite" }
        ]
      }
    }
  }
}
```

## Verify

Embeddings:

```bash
curl -sS -i \
  -H "Authorization: Bearer <YOUR_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-embedding-2","input":"pong"}' \
  http://localhost:8080/v1/gemini/embeddings
```

Returns `200` with `{"object":"list","data":[{"embedding":[...3072 floats]}],"usage":{...}}` and an `x-gateway-account` header naming the pool key that served it.

Chat:

```bash
curl -sS -i \
  -H "Authorization: Bearer <YOUR_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-3.1-flash-lite","messages":[{"role":"user","content":"pong"}]}' \
  http://localhost:8080/v1/gemini/chat/completions
```

## Notes

- Auth to the gateway is the `sp_*` Bearer token (the gateway holds the upstream Gemini keys; clients never see them).
- Cost is logged as `$0` (free tier) but every call records a usage row for attribution.
- Free-tier caps are **per key per model per day** (Pacific midnight reset). Pooling N keys multiplies the daily ceiling ~N×.
- All-keys-exhausted returns a clean `429` with a `retry-after` to the next Pacific midnight.
