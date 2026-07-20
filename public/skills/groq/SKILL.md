---
name: nextbase-groq-setup
description: Configure OCPlatform to use Groq chat and Whisper STT routes through Nextbase.
---

# Groq via Super Proxy

Groq via Nextbase exposes OpenAI-compatible chat under `/v1/groq/chat/completions` and Whisper-compatible speech routes under `/v1/groq/audio/transcriptions` and `/v1/groq/audio/translations`. The gateway validates your `sp_*` token and forwards to healthy Groq upstream accounts. Use this for fast chat models and low-latency STT.

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
        "groq": {
          "baseUrl": "http://localhost:8080/v1/groq",
          "apiKey": "<YOUR_TOKEN>",
          "models": [
            { "id": "openai/gpt-oss-120b", "name": "Groq GPT OSS 120B" }
          ]
        }
      }
  }
}
```

`~/.openclaw/agents/main/agent/models.json` provider block:

```json
{
  "providers": {
    "groq": {
      "baseUrl": "http://localhost:8080/v1/groq",
      "apiKey": "<YOUR_TOKEN>",
      "models": [
        { "id": "openai/gpt-oss-120b", "name": "Groq GPT OSS 120B" }
      ]
    }
  }
}
```

`~/.openclaw/agents/main/agent/auth-profiles.json`:

```json
{
  "profiles": {
    "groq:nextbase-gateway": {
      "type": "api_key",
      "provider": "groq",
      "key": "<YOUR_TOKEN>"
    }
  }
}
```

`~/.openclaw/agents/main/agent/auth-state.json`:

```json
{
  "lastGood": { "groq": "groq:nextbase-gateway" }
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
const provider = { groq: { baseUrl: baseUrl + '/v1/groq', apiKey: token, models: [{ id: 'openai/gpt-oss-120b', name: 'Groq GPT OSS 120B' }] } };
for (const file of [path.join(home, '.openclaw/openclaw.json'), path.join(home, '.openclaw/agents/main/agent/models.json')]) {
  const data = readJson(file, {});
  const providers = file.endsWith('openclaw.json') ? (((data.models ||= {}).providers ||= {})) : (data.providers ||= {});
  Object.assign(providers, provider);
  writeJson(file, data);
}
const profilesFile = path.join(home, '.openclaw/agents/main/agent/auth-profiles.json');
const profilesData = readJson(profilesFile, { profiles: {} });
Object.assign((profilesData.profiles ||= {}), { 'groq:nextbase-gateway': { type: 'api_key', provider: 'groq', key: token } });
writeJson(profilesFile, profilesData);
const stateFile = path.join(home, '.openclaw/agents/main/agent/auth-state.json');
const state = readJson(stateFile, {}); state.lastGood ||= {}; Object.assign(state.lastGood, { groq: 'groq:nextbase-gateway' });
state.order ||= {}; for (const [p, profile] of Object.entries({ groq: 'groq:nextbase-gateway' })) { const old = Array.isArray(state.order[p]) ? state.order[p] : []; state.order[p] = [profile, ...old.filter(x => x !== profile)]; }
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
  -d '{"model":"openai/gpt-oss-120b","messages":[{"role":"user","content":"pong"}]}' \
  http://localhost:8080/v1/groq/chat/completions
```

## What success looks like
- Curl returns HTTP 200.
- Response headers include `x-gateway-provider: groq` and `x-gateway-account: Groq account label`.

## Troubleshooting
- 401 token errors usually mean the full `sp_*` secret was not pasted; the dashboard prefix alone is not enough.
- 403 or "IP not allowed" means the token has an IP allow-list that does not include this machine.
- 429 means the token, user, or upstream account hit a quota/cooldown; wait or choose another account/token.
- If OCPlatform sends `x-api-key` to Anthropic-shaped routes, set `authHeader: true` so it sends `Authorization: Bearer ...`.
- For Codex, native `agentRuntime.id: "codex"` bypasses this gateway; use the configured gateway provider/model instead.

## Provider-specific notes
- Default model is `openai/gpt-oss-120b`.
- Streaming chat is supported when the upstream model supports it.
- Whisper STT routes are `/v1/groq/audio/transcriptions` and `/v1/groq/audio/translations`.
- Cost expectation: usually free/low-cost Groq quota until account limits or gateway caps apply.
