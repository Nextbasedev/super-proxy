---
name: nextbase-xai
description: Configure an agent client to use xAI Grok and Grok Imagine through Super Proxy.
---

# xAI via Super Proxy

xAI is exposed through Nextbase at `/v1/xai/responses`, proxying to `https://api.x.ai/v1/responses` with the OpenAI Responses API shape. Grok Imagine media endpoints are also exposed for image/video generation, and Grok Voice realtime client-secret minting is exposed for browser/mobile voice agents.

xAI Agent Tools are supported on `/v1/xai/responses` by passing the upstream Responses `tools` array through the gateway. Verified built-in tools include `web_search` (internet search with citations). xAI's old `search_parameters` live-search field is deprecated upstream; use `tools: [{ "type": "web_search" }]` instead.

## Models

Default text model: `grok-4.3`.

Also allowed: OpenClaw's bundled Grok catalog aliases (`grok-4`, `grok-4-0709`, `grok-4-fast`, `grok-4-fast-non-reasoning`, `grok-4-1-fast`, `grok-4-1-fast-non-reasoning`, `grok-4.20-beta-latest-*`, `grok-code-fast-1`, `grok-3*`, and legacy `grok-4-fast-reasoning` / `grok-4-1-fast-reasoning` / `grok-4.20-*` aliases).

Media/voice models:

- `grok-imagine-image` / `grok-imagine-image-quality` via `/v1/xai/images/generations` (default when `model` is omitted: `grok-imagine-image-quality`)
- `grok-imagine-video` / `grok-imagine-video-1.5-preview` via `/v1/xai/videos/generations`
- `grok-voice-think-fast-1.0` / `grok-voice-latest` via `/v1/xai/realtime/client_secrets`
- `grok-voice-tts` via `/v1/xai/tts`
- `grok-stt` via `/v1/xai/stt`

Media/voice models are **not** valid on `/v1/xai/responses` (the text route rejects them with 400). Call them directly via the media/voice endpoints below.

## Routes

- `POST /v1/xai/responses` — text/reasoning responses
- `POST /v1/xai/images/generations` — image generation
- `POST /v1/xai/videos/generations` — video generation submit
- `GET /v1/xai/videos/:requestId` — video generation status/result polling
- `POST /v1/xai/realtime/client_secrets` — mint ephemeral client secret for Grok Voice realtime WebSocket/WebRTC clients
- `POST /v1/xai/tts` — text-to-speech
- `POST /v1/xai/stt` — speech-to-text

## OCPlatform provider snippet

```json5
{
  "xai": {
    "baseUrl": "http://localhost:8080/v1/xai",
    "api": "openai-responses",
    "apiKey": "<YOUR_sp_TOKEN>",
    "models": [
      { "id": "grok-4.3", "name": "Grok 4.3", "reasoning": true, "input": ["text", "image"] }
    ]
  }
}
```

Auth profile:

```json5
{
  "xai:nextbase-gateway": { "type": "api_key", "provider": "xai", "key": "<YOUR_sp_TOKEN>" }
}
```

## Smoke tests

Text:

```bash
curl -sS -i \
  -H "Authorization: Bearer <YOUR_sp_TOKEN>" \
  -H "Content-Type: application/json" \
  http://localhost:8080/v1/xai/responses \
  -d '{"model":"grok-4.3","input":"Say hello in one short sentence."}'
```

Web search / Agent Tools:

```bash
curl -sS -i \
  -H "Authorization: Bearer <YOUR_sp_TOKEN>" \
  -H "Content-Type: application/json" \
  http://localhost:8080/v1/xai/responses \
  -d '{"model":"grok-4.3","input":[{"role":"user","content":"What is happening today worldwide? Summarize with citations."}],"tools":[{"type":"web_search"}],"stream":true}'
```

Expected stream events include `response.web_search_call.in_progress`, `response.web_search_call.searching`, and `response.web_search_call.completed`. Usage includes `server_side_tool_usage_details.web_search_calls`.

Image:

```bash
curl -sS -i \
  -H "Authorization: Bearer <YOUR_sp_TOKEN>" \
  -H "Content-Type: application/json" \
  http://localhost:8080/v1/xai/images/generations \
  -d '{"prompt":"A cinematic AI command center at night","aspect_ratio":"16:9"}'
```

Video submit:

```bash
curl -sS -i \
  -H "Authorization: Bearer <YOUR_sp_TOKEN>" \
  -H "Content-Type: application/json" \
  http://localhost:8080/v1/xai/videos/generations \
  -d '{"prompt":"A cinematic dolly shot through an AI command center","duration":8,"aspect_ratio":"16:9","resolution":"720p"}'
```

Image-to-video (animate an existing image — pass its public URL as `image_url`):

```bash
curl -sS -i \
  -H "Authorization: Bearer <YOUR_sp_TOKEN>" \
  -H "Content-Type: application/json" \
  http://localhost:8080/v1/xai/videos/generations \
  -d '{"prompt":"the subject moves forward","image_url":"https://example.com/frame.jpg","duration":5}'
```

Realtime voice client secret:

```bash
curl -sS -i \
  -H "Authorization: Bearer <YOUR_sp_TOKEN>" \
  -H "Content-Type: application/json" \
  http://localhost:8080/v1/xai/realtime/client_secrets \
  -d '{"model":"grok-voice-think-fast-1.0","voice":"eve"}'
```

Use the returned ephemeral secret with xAI's realtime voice WebSocket/WebRTC client. The gateway only mints the secret; realtime audio usage happens client↔xAI and is not metered by the gateway.

Video status (poll until done):

```bash
curl -sS -i \
  -H "Authorization: Bearer <YOUR_sp_TOKEN>" \
  http://localhost:8080/v1/xai/videos/<REQUEST_ID>
```

Expected: HTTP 200 with `x-gateway-provider: xai` and `x-gateway-account` headers.

## Video generation notes

- **Async, two-step**: submit returns `{ "request_id": "..." }` (HTTP 200), then `GET /v1/xai/videos/:requestId` returns `202` while `status: pending` and `200` with `video.url` when `status: done` (or `failed`/`expired`). Poll every few seconds; generation typically takes up to a few minutes.
- **Account affinity**: a `request_id` is bound to the account that created it, so always poll through this gateway — it routes the poll to the same account automatically. Video URLs are temporary; download promptly.
- **`duration`**: 1–15 seconds (clamped). Omit it to use the gateway default of 5s for billing. Video editing keeps the source clip's duration.
- **Billing**: video is billed **at submit** based on the requested duration (you are charged when the job is accepted, not on poll), so skipping the poll does not avoid the charge. Image generation is billed per produced image. Status polls are free.
- **Media URLs** (`image_url`, `reference_image_urls`) must be public `http(s)` URLs or `data:image/*;base64` URIs; internal/private hosts are rejected.

## Access policy

xAI is off by default for non-admin users, consistent with other non-Codex providers. Enable xAI for a user in Model access or issue a temporary grant before use.
