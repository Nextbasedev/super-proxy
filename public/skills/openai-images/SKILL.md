---
name: nextbase-openai-images-setup
description: Configure OCPlatform image generation to use `gpt-image-2` through Nextbase.
---

# OpenAI Images via Super Proxy

OpenAI Images via Nextbase routes `/v1/images/generations` and image edits through the gateway using the regular `openai` provider. The gateway can use a real OpenAI upstream key when present, or fall back to Codex/ChatGPT OAuth image generation while preserving the OpenAI Images response shape. Use this for OCPlatform image tools, not the `openai-codex` provider.

## Prerequisites
- A Nextbase proxy token starting with `sp_` (the user will supply it; if missing, ask)

## Step 1 — Verify the token works
Run a single curl that hits `http://localhost:8080/v1/token/check` with the user's `sp_*` token. Expect HTTP 200 with `{"ok":true,...}`. If 401, ask the user to confirm the token is correct and not just the `sp_*` prefix.

```bash
curl -sS -i \
  -H "Authorization: Bearer <YOUR_TOKEN>" \
  http://localhost:8080/v1/token/check
```

## Step 2 — Patch OCPlatform config
Default to the JSON merge below because it is less destructive. Merge the provider block into both `~/.openclaw/openclaw.json` under `models.providers.<provider>` and `~/.openclaw/agents/main/agent/models.json` under `providers.<provider>`. Then merge the auth profile and `lastGood` state.

### JSON merge option
`~/.openclaw/openclaw.json` provider block:

```json
{
  "models": {
    "providers": {
        "openai": {
          "baseUrl": "http://localhost:8080/v1",
          "apiKey": "<YOUR_TOKEN>",
          "models": []
        }
      }
  }
}
```

`~/.openclaw/agents/main/agent/models.json` provider block:

```json
{
  "providers": {
    "openai": {
      "baseUrl": "http://localhost:8080/v1",
      "apiKey": "<YOUR_TOKEN>",
      "models": []
    }
  }
}
```

`~/.openclaw/agents/main/agent/auth-profiles.json`:

```json
{
  "profiles": {
    "openai:nextbase-gateway": {
      "type": "api_key",
      "provider": "openai",
      "key": "<YOUR_TOKEN>"
    }
  }
}
```

`~/.openclaw/agents/main/agent/auth-state.json`:

```json
{
  "lastGood": { "openai": "openai:nextbase-gateway" }
}
```

### Automated patch option
Use this only when the user explicitly wants automated patching. It backs up touched files with `.bak-nextbase-<timestamp>`.

```bash
TOKEN="<YOUR_TOKEN>" BASE_URL="http://localhost:8080" node <<'NODE'
const fs = require('fs'), os = require('os'), path = require('path');
const token = process.env.TOKEN, baseUrl = process.env.BASE_URL;
const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
function readJson(file, fallback) { try { const raw = fs.readFileSync(file, 'utf8').trim(); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; } }
function writeJson(file, data) { fs.mkdirSync(path.dirname(file), { recursive: true }); if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak-nextbase-' + stamp); fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n'); console.log('patched ' + file); }
const home = os.homedir();
const provider = { openai: { baseUrl: baseUrl + '/v1', apiKey: token, models: [] } };
for (const file of [path.join(home, '.openclaw/openclaw.json'), path.join(home, '.openclaw/agents/main/agent/models.json')]) {
  const data = readJson(file, {});
  const providers = file.endsWith('openclaw.json') ? (((data.models ||= {}).providers ||= {})) : (data.providers ||= {});
  Object.assign(providers, provider);
  writeJson(file, data);
}
const profilesFile = path.join(home, '.openclaw/agents/main/agent/auth-profiles.json');
const profilesData = readJson(profilesFile, { profiles: {} });
Object.assign((profilesData.profiles ||= {}), { 'openai:nextbase-gateway': { type: 'api_key', provider: 'openai', key: token } });
writeJson(profilesFile, profilesData);
const stateFile = path.join(home, '.openclaw/agents/main/agent/auth-state.json');
const state = readJson(stateFile, {}); state.lastGood ||= {}; Object.assign(state.lastGood, { openai: 'openai:nextbase-gateway' });
state.order ||= {}; for (const [p, profile] of Object.entries({ openai: 'openai:nextbase-gateway' })) { const old = Array.isArray(state.order[p]) ? state.order[p] : []; state.order[p] = [profile, ...old.filter(x => x !== profile)]; }
writeJson(stateFile, state);
NODE
```

## Step 3 — Restart OCPlatform
```bash
systemctl restart openclaw-gateway.service || echo "Restart your OCPlatform process manually."
```

## Step 4 — Smoke test
Run this provider verify curl exactly as the gateway dashboard uses it:

```bash
curl -sS -i \
  -H "Authorization: Bearer <YOUR_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-image-2","prompt":"a small duck swimming in water","size":"1024x1024","n":1}' \
  http://localhost:8080/v1/images/generations
```

## What success looks like
- Curl returns HTTP 200.
- Response headers include `x-gateway-provider: openai` and `x-gateway-account: OpenAI or Codex image account label`.

## Troubleshooting
- 401 token errors usually mean the full `sp_*` secret was not pasted; the dashboard prefix alone is not enough.
- 403 or "IP not allowed" means the token has an IP allow-list that does not include this machine.
- 429 means the token, user, or upstream account hit a quota/cooldown; wait or choose another account/token.
- If OCPlatform sends `x-api-key` to Anthropic-shaped routes, set `authHeader: true` so it sends `Authorization: Bearer ...`.
- For Codex, native `agentRuntime.id: "codex"` bypasses this gateway; use the configured gateway provider/model instead.

## Provider-specific notes
- Default model is `gpt-image-2`.
- Image generation is non-streaming; the response returns `data[].b64_json`.
- Cost depends on whether the gateway uses paid OpenAI Images or Codex subscription fallback.
- If images 404, you probably configured `openai-codex` but not regular `openai`.

## Async (poll-based) image jobs for slow Codex generations
Some Codex/ChatGPT-OAuth image jobs take longer than ~100 seconds, which can trip an upstream proxy 524 timeout on the normal synchronous routes. For those long jobs, use the opt-in **async** endpoints. They accept the same request bodies as the sync routes (JSON base64/data-URI and multipart for edits), queue the work, and return immediately so you can poll for the result.

The synchronous `/v1/images/generations` and `/v1/images/edits` routes are unchanged — keep using them for fast jobs.

Flow:
1. `POST /v1/images/{generations,edits}/async` → `202 { "job_id": "...", "status": "queued", "poll_url": "/v1/images/jobs/<id>" }`
2. Poll `GET /v1/images/jobs/<id>` until `status` is `completed` or `failed`.
   - `completed`: the response includes the full OpenAI Images shape `{ "created": ..., "data": [{ "b64_json": "..." }] }`, consumed identically to the sync route.
   - `failed`: the response includes `status_code` and an `error` object.
3. Jobs are owner-scoped (a job is only visible to the token's user), and rows expire ~1 hour after creation.

### Async generations (base64 JSON)
```bash
# 1) enqueue
curl -sS -H "Authorization: Bearer <YOUR_TOKEN>" -H "Content-Type: application/json" \
  -d '{"model":"gpt-image-2","prompt":"a small duck swimming in water","size":"1024x1024"}' \
  http://localhost:8080/v1/images/generations/async
# -> {"job_id":"<id>","status":"queued","poll_url":"/v1/images/jobs/<id>"}

# 2) poll until completed/failed
curl -sS -H "Authorization: Bearer <YOUR_TOKEN>" \
  http://localhost:8080/v1/images/jobs/<id>
```

### Async edits — base64 JSON
```bash
curl -sS -H "Authorization: Bearer <YOUR_TOKEN>" -H "Content-Type: application/json" \
  -d '{"model":"gpt-image-2","prompt":"make it cinematic","image":"<BASE64_PNG>"}' \
  http://localhost:8080/v1/images/edits/async
# then poll GET /v1/images/jobs/<id>
```

### Async edits — multipart
```bash
curl -sS -H "Authorization: Bearer <YOUR_TOKEN>" \
  -F model=gpt-image-2 \
  -F prompt="make it cinematic" \
  -F image=@source.png \
  http://localhost:8080/v1/images/edits/async
# then poll GET /v1/images/jobs/<id>
```

### Notes
- Poll responses carry `x-gateway-image-mode: codex-responses-async`.
- Same model-allow and per-user/token limit checks as the sync path are enforced up front, so async can't be used to bypass limits; usage is still recorded when a job completes.
- If the gateway restarts while a job is mid-flight, that in-flight job is lost; a job left in `running` for more than ~10 minutes is reported as `failed` on the next poll.
