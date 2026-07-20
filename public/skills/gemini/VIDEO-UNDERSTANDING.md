---
name: nextbase-gemini-video
description: Send a video to the Super Proxy and get back an understanding/description using Gemini's video-capable models, including size/length limits and how to cut long videos.
---

# Gemini Video Understanding via Super Proxy

Send a video, get back text understanding (description, transcription of on-screen action, Q&A about the footage). This runs on Gemini's video-capable models through the gateway's pooled free-tier keys — your client only ever holds one `sp_*` token.

---

## TL;DR

- **Endpoint:** `POST http://localhost:8080/v1/gemini/chat/completions`
- **Auth:** `Authorization: Bearer sp_...` (your gateway token)
- **Shape:** OpenAI chat-completions, with a `video_url` content part
- **Models:** `gemini-3.5-flash` (recommended) or `gemini-2.5-flash`
- **Inline video limit:** ~**20 MB** raw file (request body cap is 30 MB). Bigger → **upload via the File API** (`POST /v1/gemini/files`, up to ~2 GB — see Option C), use a hosted URL, or cut/compress (recipe below).
- **Free-tier budget:** ~**20 video requests/day per key**, ~**300/day pooled**. Best-effort, not for high volume.
- **Routes:** chat = `/v1/gemini/chat/completions`; large uploads = `POST/GET/DELETE /v1/gemini/files`.

---

## 1. Get a token

Ask your gateway admin for an `sp_*` token, or mint one in the console under **Tokens**. The token never sees the upstream Gemini keys.

---

## 2. Which endpoint + model

| | |
|---|---|
| **URL** | `http://localhost:8080/v1/gemini/chat/completions` |
| **Method** | `POST` (non-streaming) |
| **Header** | `Authorization: Bearer sp_...` |
| **Header** | `Content-Type: application/json` |
| **Model** | `gemini-3.5-flash` (faster, ~3× cheaper, recommended) or `gemini-2.5-flash` (also counts an audio track) |

> Only these two models do video. The flash-**lite** chat models (`gemini-3.1-flash-lite`, `gemini-2.5-flash-lite`) are text-only and will reject video.

---

## 3. How to send a video

You can attach the video two ways. Use a `video_url` content part inside an OpenAI-style message.

### Option A — Inline base64 (files up to ~20 MB)

Encode the file as a `data:` URI and embed it. No upload step, no File API.

```bash
TOKEN="sp_your_token_here"
VIDEO="clip.mp4"

# Build the request body (base64 the video into a data URI)
python3 - "$VIDEO" <<'PY' > /tmp/body.json
import sys, json, base64
f = sys.argv[1]
b64 = base64.b64encode(open(f, "rb").read()).decode()
body = {
  "model": "gemini-3.5-flash",
  "messages": [{
    "role": "user",
    "content": [
      {"type": "text", "text": "Describe what happens in this video. Who appears and what is the setting?"},
      {"type": "video_url", "video_url": {"url": f"data:video/mp4;base64,{b64}"}}
    ]
  }]
}
json.dump(body, open("/tmp/body.json", "w"))
PY

curl -s "http://localhost:8080/v1/gemini/chat/completions" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/body.json | python3 -m json.tool
```

Response is normal OpenAI chat shape:

```json
{
  "model": "gemini-3.5-flash",
  "choices": [{ "message": { "role": "assistant", "content": "Set in a charity gala ..." } }],
  "usage": { "prompt_tokens": 2746, "completion_tokens": 36, "total_tokens": 3147 }
}
```

### Option B — Hosted URL (for bigger files or a public YouTube link)

If the video is reachable over `http(s)` (a public URL or a YouTube link), pass the URL directly — Gemini fetches it, so you skip the body-size limit:

```json
{
  "model": "gemini-3.5-flash",
  "messages": [{
    "role": "user",
    "content": [
      {"type": "text", "text": "Summarize this video."},
      {"type": "video_url", "video_url": {"url": "https://www.youtube.com/watch?v=XXXXXXXXXXX"}}
    ]
  }]
}
```

> The URL must be publicly fetchable by Google. Private/expiring/signed URLs that need your auth headers will not work — use inline base64 (Option A) or upload via the File API (Option C) for those.

### Option C — Upload large/private files (File API, up to ~2 GB)

For videos too big for inline (~20 MB+) that you **don't** want to host publicly, upload them to the gateway's File API. The file is stored privately for **48 hours** (then auto-deleted), and you reference it by the returned `file_uri`. Works on the free tier (no billing needed).

**Step 1 — upload the raw file bytes:**

```bash
TOKEN="sp_your_token_here"
BASE="http://localhost:8080"

curl -s -X POST "$BASE/v1/gemini/files?display_name=myvideo" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: video/mp4" \
  --data-binary @big-video.mp4
```

Response:

```json
{
  "name": "files/oq7evufk8fmq",
  "file_uri": "https://generativelanguage.googleapis.com/v1beta/files/oq7evufk8fmq?sp_acct=48",
  "mime_type": "video/mp4",
  "size_bytes": 9054010,
  "state": "PROCESSING"
}
```

> **Keep the `file_uri` exactly as returned** — it carries a tag (`?sp_acct=…`) the gateway uses to route your follow-up request to the correct key. Don't strip it.

**Step 2 — (optional) wait until it's `ACTIVE`:**

Large videos may take a few seconds to process. Poll the status (URL-encode the `name` + tag):

```bash
curl -s "$BASE/v1/gemini/files/oq7evufk8fmq%3Fsp_acct%3D48" \
  -H "Authorization: Bearer $TOKEN"
# -> { "state": "ACTIVE", ... }  (wait for ACTIVE before step 3)
```

**Step 3 — ask about it** (pass the `file_uri` as a `video_url`):

```json
{
  "model": "gemini-3.5-flash",
  "messages": [{
    "role": "user",
    "content": [
      {"type": "text", "text": "Summarize this video."},
      {"type": "video_url", "video_url": {"url": "https://generativelanguage.googleapis.com/v1beta/files/oq7evufk8fmq?sp_acct=48"}}
    ]
  }]
}
```

**Step 4 — (optional) delete early** (files auto-expire after 48h anyway):

```bash
curl -s -X DELETE "$BASE/v1/gemini/files/oq7evufk8fmq%3Fsp_acct%3D48" \
  -H "Authorization: Bearer $TOKEN"
```

> **Key-affinity (why the tag matters):** an uploaded file is private to the one pooled key that uploaded it, so the gateway *must* run your follow-up request on that same key — that's what the `sp_acct` tag encodes. Side effect: a File-API request **can't fail over** to another key. If that key is rate-limited/exhausted when you ask, the request fails (re-upload to get a fresh key). For most uploads this is invisible.

---

## 4. Limits — read this before sending

### Request size (the practical wall for inline)
- **Inline base64:** the gateway accepts request bodies up to **30 MB**. Base64 inflates a file ~33%, so that's roughly a **20 MB raw video**. This matches Gemini's own ~20 MB inline cap.
- **Over ~20 MB:** **upload via the File API** (Option C, up to ~2 GB), use Option B (hosted URL), or cut/compress first (Section 5). The File API is the cleanest path for big private videos — no public hosting, free tier, 48h retention.

### Video length (how long a clip Gemini can reason about)
The duration ceiling is huge — body size limits you first for inline. For reference (model context dependent):

| Resolution mode | Max duration (large-context models) |
|---|---|
| Default media resolution | up to ~**2 hours** |
| Low media resolution | up to ~**6 hours** |
| Gemini 2.5 Pro (with audio) | ~45 min |

In practice through this gateway, **file size (~20 MB inline) caps you well before duration does.** A clip that's short enough to fit 20 MB is always within the duration limit.

### Rough "how long fits in 20 MB inline"
Depends entirely on bitrate. As a guide:

| Encoding | Approx duration in 20 MB |
|---|---|
| 1080p, normal bitrate (~8 Mbps) | ~20 sec |
| 720p (~2.5 Mbps) | ~60 sec |
| 480p, compressed (~1 Mbps) | ~2.5 min |
| Low-res analysis encode (~0.5 Mbps) | ~5 min |

So **to send a longer clip inline, drop the resolution/bitrate** (Section 5) — for "what's happening in this video" you rarely need 1080p.

### Tokens & cost signal
- ~**300 tokens per second of video** at default resolution (258/frame at 1 FPS + ~32/sec audio); ~100 tokens/sec at low resolution.
- A 30s clip ≈ 3–10K tokens. Per-request that's well within limits (250K tokens/min/key). The real wall is the **daily request count**, not tokens.

### Throughput / quota (free-tier pool)
- ~**20 video requests per day, per key.** Pooled across the current keys that's ~**300 requests/day total**, shared by everyone.
- This is **best-effort** capacity for demos and light use. If you hit `429`/quota errors, the pool's daily video budget is spent — try again after Pacific midnight, or ask the admin to add billing-enabled keys for real volume.
- Limits reset at **midnight US Pacific time**.

---

## 5. Sending a longer video — cut and/or compress it

If your video is longer than ~20 MB will hold (or you want the whole thing), do **one** of these:

### 5a. Compress to fit (keep the whole clip, lower the quality)
Best when you want the full video and don't need high resolution. Scale down + lower bitrate so the whole clip lands under ~18 MB:

```bash
# Re-encode to 480p, ~0.8 Mbps video + low audio — good enough for "what's happening"
ffmpeg -i input.mp4 -vf "scale=-2:480" -b:v 800k -b:a 64k -movflags +faststart small.mp4
ls -lh small.mp4   # aim for < 18 MB
```

If it's still too big, drop further: `scale=-2:360` and `-b:v 500k`.

### 5b. Cut into chunks and send each one (keep quality, split by time)
Best when you need the detail and the video is long. Split into fixed-length segments, then send each segment as a separate request and stitch the answers.

```bash
# Split into 60-second segments: out_000.mp4, out_001.mp4, ...
ffmpeg -i input.mp4 -c copy -map 0 -f segment -segment_time 60 -reset_timestamps 1 out_%03d.mp4

# Check each chunk's size; if a chunk is still > ~18 MB, compress it (5a) or use a shorter -segment_time
ls -lh out_*.mp4
```

Then loop the chunks through the endpoint:

```bash
TOKEN="sp_your_token_here"
for f in out_*.mp4; do
  python3 - "$f" > /tmp/body.json <<'PY'
import sys, json, base64
f = sys.argv[1]
b64 = base64.b64encode(open(f, "rb").read()).decode()
json.dump({
  "model": "gemini-3.5-flash",
  "messages": [{"role":"user","content":[
    {"type":"text","text": f"This is segment {f} of a longer video. Describe what happens in this segment."},
    {"type":"video_url","video_url":{"url": f"data:video/mp4;base64,{b64}"}}
  ]}]
}, open("/tmp/body.json","w"))
PY
  echo "=== $f ==="
  curl -s "http://localhost:8080/v1/gemini/chat/completions" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    --data-binary @/tmp/body.json \
    | python3 -c "import sys,json;print(json.load(sys.stdin)['choices'][0]['message']['content'])"
  sleep 2   # be gentle on the pooled free-tier quota
done
```

> **Watch your daily budget when chunking.** Each chunk is one request against the ~20/key (~300 pooled) daily video limit. A 10-minute video at 60s chunks = 10 requests. For very long videos, prefer compression (5a) or a hosted URL (Option B) over many chunks.

### 5c. Combine: cut to the part you care about
If you only need a section, trim first — fastest and cheapest:

```bash
# Take 90 seconds starting at 02:00
ffmpeg -ss 00:02:00 -i input.mp4 -t 90 -c copy clip.mp4
```

---

## 6. Quick checklist

1. Have an `sp_*` token.
2. Video ≤ ~20 MB? → send inline (Option A). Bigger? → **upload via the File API** (Option C, up to ~2 GB), use a hosted URL (Option B), or compress/cut (Section 5).
3. POST to `/v1/gemini/chat/completions` with `model: gemini-3.5-flash` and a `video_url` part (an inline data URI, a hosted URL, or a File API `file_uri`).
4. Got a `429`/quota error? The pooled daily video budget is spent — retry after Pacific midnight or ask the admin for billing-enabled keys.

---

## Notes / gotchas

- **Non-streaming only.** No SSE on this route.
- **`gemini-3.5-flash` is the recommended default** for video: faster and ~3× fewer tokens than `gemini-2.5-flash`, equally accurate in testing. Use `gemini-2.5-flash` if you specifically want audio-track analysis counted.
- **Multimodal mixing works:** you can also send `image_url`, `audio_url`, and `input_audio` parts the same way. Data URIs become inline data; `http(s)` URLs are fetched by Gemini.
- **One video per request** is the sweet spot. Multiple large inline videos will blow the 30 MB body limit.
- **File API uploads (Option C):** keep the returned `file_uri` verbatim (it carries the `sp_acct` routing tag); files live 48h then auto-delete; a File-API request can't fail over to another pooled key (re-upload if you hit a quota error on that key).
- This is the **native free-tier Gemini pool**, distinct from the `openrouter` Gemini models.
