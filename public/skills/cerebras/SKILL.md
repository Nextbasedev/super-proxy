---
name: nextbase-cerebras-setup
description: Configure OCPlatform to use Cerebras chat through Nextbase.
---

# Cerebras via Super Proxy

Cerebras via Nextbase exposes OpenAI-compatible chat at `/v1/cerebras/chat/completions`. The gateway uses your `sp_*` token for authorization, then routes to an available Cerebras upstream account. Use it for very fast Llama-class chat completions.

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
        "cerebras": {
          "baseUrl": "http://localhost:8080/v1/cerebras",
          "apiKey": "<YOUR_TOKEN>",
          "models": [
            { "id": "gpt-oss-120b", "name": "Cerebras GPT OSS 120B" },
            { "id": "zai-glm-4.7", "name": "Cerebras Z.ai GLM 4.7" }
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
    "cerebras": {
      "baseUrl": "http://localhost:8080/v1/cerebras",
      "apiKey": "<YOUR_TOKEN>",
      "models": [
        { "id": "gpt-oss-120b", "name": "Cerebras GPT OSS 120B" },
        { "id": "zai-glm-4.7", "name": "Cerebras Z.ai GLM 4.7" }
      ]
    }
  }
}
```

`~/.openclaw/agents/main/agent/auth-profiles.json`:

```json
{
  "profiles": {
    "cerebras:nextbase-gateway": {
      "type": "api_key",
      "provider": "cerebras",
      "key": "<YOUR_TOKEN>"
    }
  }
}
```

`~/.openclaw/agents/main/agent/auth-state.json`:

```json
{
  "lastGood": { "cerebras": "cerebras:nextbase-gateway" }
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
const provider = { cerebras: { baseUrl: baseUrl + '/v1/cerebras', apiKey: token, models: [{ id: 'gpt-oss-120b', name: 'Cerebras GPT OSS 120B' }, { id: 'zai-glm-4.7', name: 'Cerebras Z.ai GLM 4.7' }] } };
for (const file of [path.join(home, '.openclaw/openclaw.json'), path.join(home, '.openclaw/agents/main/agent/models.json')]) {
  const data = readJson(file, {});
  const providers = file.endsWith('openclaw.json') ? (((data.models ||= {}).providers ||= {})) : (data.providers ||= {});
  Object.assign(providers, provider);
  writeJson(file, data);
}
const profilesFile = path.join(home, '.openclaw/agents/main/agent/auth-profiles.json');
const profilesData = readJson(profilesFile, { profiles: {} });
Object.assign((profilesData.profiles ||= {}), { 'cerebras:nextbase-gateway': { type: 'api_key', provider: 'cerebras', key: token } });
writeJson(profilesFile, profilesData);
const stateFile = path.join(home, '.openclaw/agents/main/agent/auth-state.json');
const state = readJson(stateFile, {}); state.lastGood ||= {}; Object.assign(state.lastGood, { cerebras: 'cerebras:nextbase-gateway' });
state.order ||= {}; for (const [p, profile] of Object.entries({ cerebras: 'cerebras:nextbase-gateway' })) { const old = Array.isArray(state.order[p]) ? state.order[p] : []; state.order[p] = [profile, ...old.filter(x => x !== profile)]; }
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
  -d '{"model":"gpt-oss-120b","messages":[{"role":"user","content":"pong"}]}' \
  http://localhost:8080/v1/cerebras/chat/completions
```

## What success looks like
- Curl returns HTTP 200.
- Response headers include `x-gateway-provider: cerebras` and `x-gateway-account: Cerebras account label`.

## Troubleshooting
- 401 token errors usually mean the full `sp_*` secret was not pasted; the dashboard prefix alone is not enough.
- 403 or "IP not allowed" means the token has an IP allow-list that does not include this machine.
- 429 means the token, user, or upstream account hit a quota/cooldown; wait or choose another account/token.
- If OCPlatform sends `x-api-key` to Anthropic-shaped routes, set `authHeader: true` so it sends `Authorization: Bearer ...`.
- For Codex, native `agentRuntime.id: "codex"` bypasses this gateway; use the configured gateway provider/model instead.

## Provider-specific notes
- Default and fallback model is `gpt-oss-120b` (Production). `zai-glm-4.7` is also available as Preview.
- Streaming chat is supported when the upstream endpoint supports it.
- Cost expectation: free/paid quota depends on the upstream Cerebras account and gateway caps.
- If a requested model is unavailable, the gateway/client config should fall back to `gpt-oss-120b`.


## Current Cerebras upstream limits
- Models: `gpt-oss-120b` (Production, 65,536 context) and `zai-glm-4.7` (Preview, 64,000 context).
- Per-model account limits: 5 requests/minute, 150 requests/hour, 2,400 requests/day; 30,000 tokens/minute, 1,000,000 tokens/hour, 1,000,000 tokens/day.
