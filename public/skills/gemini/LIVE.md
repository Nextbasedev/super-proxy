# Gemini Live (realtime) via Super Proxy

Gemini **Live** is a bidirectional, low-latency **WebSocket** session (audio in / audio
out), not a request/response call. It does **not** ride `/v1/gemini/chat/completions`.
Nextbase exposes it through a dedicated relay so clients never see the upstream key.

> **Audio-first:** all Live models require the `AUDIO` response modality. `TEXT`-only
> response config is rejected by upstream.

## Models

| Model id | Use |
|---|---|
| `gemini-2.5-flash-native-audio-preview-12-2025` | Native-audio realtime voice dialog (default) |
| `gemini-3.1-flash-live-preview` | Newer Flash Live realtime model |
| `gemini-3.5-live-translate-preview` | Realtime speech-to-speech translation |

Aliases also registered: `gemini-2.5-flash-native-audio-latest`,
`gemini-2.5-flash-native-audio-preview-09-2025`.

Verified live 2026-06-24: all three reach `setupComplete` and return real audio
(native-audio 28.8 KB; flash-live 42 KB + transcription; translate 972 KB,
input transcribed).

## Two ways to connect

### 1. Relay WebSocket (works today) — `wss://<gateway>/v1/gemini/realtime`

The gateway holds the Gemini key and pins one pooled account per session. Browsers
can't set headers on a WebSocket, so pass the gateway token as a query param
(`access_token` / `token`); server-side clients may use `Authorization: Bearer`.

```
wss://<gateway>/v1/gemini/realtime?model=gemini-2.5-flash-native-audio-preview-12-2025&access_token=sp_xxx
```

Then speak the native Live protocol directly — the relay forwards frames verbatim
in both directions:

1. First client message: `{ "setup": { "model": "models/<id>", "generationConfig": { "responseModalities": ["AUDIO"] }, ... } }`
2. Server replies `{ "setupComplete": {} }`.
3. Stream input: `{ "realtimeInput": { "audio": { "data": "<base64 pcm>", "mimeType": "audio/pcm;rate=16000" } } }`, then `{ "realtimeInput": { "audioStreamEnd": true } }`.
4. Receive `serverContent.modelTurn.parts[].inlineData` audio chunks; turn ends on `turnComplete`.

Because setup is forwarded unchanged, any setup feature works automatically once
the upstream key tier supports it (see gate below).

### 2. Ephemeral client secret — `POST /v1/gemini/realtime/client_secrets`

Mints a short-lived Google token so a browser/OCPlatform client can connect directly
to Google's Live WS without the relay. Auth with your `sp_*` token; body optional:

```json
{ "model": "gemini-3.1-flash-live-preview", "uses": 1, "expire_minutes": 30 }
```

Returns the upstream `auth_tokens` response passed through unchanged.

> **Upstream gate (2026-06-24):** ephemeral `auth_tokens` minting and Live Translate
> `translationConfig.targetLanguageCode` both currently return `API key not valid`
> on our free key tier — they require allowlisting. The **relay path works today**;
> Live Translate works to its **default target (English)** now. When keys are
> allowlisted, target-language selection and ephemeral secrets work with **zero
> code change** (setup is forwarded verbatim).

## Live Translate target language

Place inside `generationConfig` (top-level placement is rejected):

```json
{ "setup": { "model": "models/gemini-3.5-live-translate-preview",
  "generationConfig": { "responseModalities": ["AUDIO"],
    "translationConfig": { "targetLanguageCode": "es" } },
  "outputAudioTranscription": {} } }
```

(BCP-47 code; default target is `en`. Gated until keys are allowlisted — see above.)

## Limits / notes

- Live runs in its own pool family (`live`) with a conservative daily cap so it
  can't starve embeddings/chat/video budgets.
- Sessions are internal-only and unmetered for cost; a zero-cost `usage_event` is
  recorded per session for observability.
- Max WS frame: 8 MB (covers chunked PCM turns).
