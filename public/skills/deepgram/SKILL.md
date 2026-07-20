---
name: nextbase-deepgram
summary: Configure OCPlatform/OpenClaw to use Deepgram transcription through Super Proxy.
---

# Deepgram via Super Proxy

Deepgram transcription is exposed through Nextbase at `/v1/deepgram/listen`.

Supported request shapes:

- JSON URL payloads: `{ "url": "https://example.com/audio.wav" }`
- Raw audio uploads with `Content-Type: audio/*` or `application/octet-stream`

Policy:

- Deepgram is strict allowlist only in the gateway.
- Unknown Deepgram model names are blocked before upstream.
- Configure per-user access in the admin Model access tab.

## Provider config

```json
{
  "models": {
    "providers": {
      "deepgram": {
        "baseUrl": "http://localhost:8080/v1/deepgram",
        "apiKey": "<YOUR_sp_TOKEN>",
        "models": [
          { "id": "nova-3", "name": "Deepgram Nova-3" },
          { "id": "nova-2", "name": "Deepgram Nova-2" },
          { "id": "whisper", "name": "Deepgram Whisper Cloud" }
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
    "deepgram:nextbase-gateway": {
      "type": "api_key",
      "provider": "deepgram",
      "key": "<YOUR_sp_TOKEN>"
    }
  }
}
```

## Verify with remote URL

```bash
curl -sS -i \
  -H "Authorization: Bearer <YOUR_sp_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://dpgr.am/spacewalk.wav"}' \
  'http://localhost:8080/v1/deepgram/listen?model=nova-3&smart_format=true'
```

## Verify with local audio

```bash
curl -sS -i \
  -H "Authorization: Bearer <YOUR_sp_TOKEN>" \
  -H "Content-Type: audio/wav" \
  --data-binary @your-audio.wav \
  'http://localhost:8080/v1/deepgram/listen?model=nova-3&smart_format=true'
```

Expected: HTTP 200 with `results.channels[].alternatives[].transcript` and `metadata.duration`.
