---
name: nextbase-openai-codex-setup
description: Configure OCPlatform to route OpenAI Responses API / Codex subscription traffic through Nextbase.
---

# OpenAI Codex via Super Proxy

OpenAI Codex via Nextbase uses the gateway `/v1/responses` route for `openai-codex` models such as `gpt-5.5`. It also exposes OpenAI Realtime client-secret minting at `/v1/realtime/client_secrets` for `gpt-realtime-2` / `gpt-realtime` using the same Codex OAuth pool. This is for Codex OAuth subscription routing through Nextbase, not direct OpenAI API-key billing. It keeps the client config simple while the gateway handles upstream account selection.

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
        "openai-codex": {
          "baseUrl": "http://localhost:8080/v1",
          "api": "openai-responses",
          "apiKey": "<YOUR_TOKEN>",
          "models": [
            {
              "id": "gpt-5.5",
              "name": "GPT-5.5",
              "reasoning": true,
              "input": ["text", "image"],
              "contextWindow": 400000,
              "maxTokens": 128000
            }
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
    "openai-codex": {
      "baseUrl": "http://localhost:8080/v1",
      "api": "openai-responses",
      "apiKey": "<YOUR_TOKEN>",
      "models": [
        {
          "id": "gpt-5.5",
          "name": "GPT-5.5",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 400000,
          "maxTokens": 128000
        }
      ]
    }
  }
}
```

`~/.openclaw/agents/main/agent/auth-profiles.json`:

```json
{
  "profiles": {
    "openai-codex:nextbase-gateway": {
      "type": "api_key",
      "provider": "openai-codex",
      "key": "<YOUR_TOKEN>"
    }
  }
}
```

`~/.openclaw/agents/main/agent/auth-state.json`:

```json
{
  "lastGood": { "openai-codex": "openai-codex:nextbase-gateway" }
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
const provider = { 'openai-codex': { baseUrl: baseUrl + '/v1', api: 'openai-responses', apiKey: token, models: [{ id: 'gpt-5.5', name: 'GPT-5.5', reasoning: true, input: ['text', 'image'], contextWindow: 400000, maxTokens: 128000 }] } };
for (const file of [path.join(home, '.openclaw/openclaw.json'), path.join(home, '.openclaw/agents/main/agent/models.json')]) {
  const data = readJson(file, {});
  const providers = file.endsWith('openclaw.json') ? (((data.models ||= {}).providers ||= {})) : (data.providers ||= {});
  Object.assign(providers, provider);
  writeJson(file, data);
}
const profilesFile = path.join(home, '.openclaw/agents/main/agent/auth-profiles.json');
const profilesData = readJson(profilesFile, { profiles: {} });
Object.assign((profilesData.profiles ||= {}), { 'openai-codex:nextbase-gateway': { type: 'api_key', provider: 'openai-codex', key: token } });
writeJson(profilesFile, profilesData);
const stateFile = path.join(home, '.openclaw/agents/main/agent/auth-state.json');
const state = readJson(stateFile, {}); state.lastGood ||= {}; Object.assign(state.lastGood, { 'openai-codex': 'openai-codex:nextbase-gateway' });
state.order ||= {}; for (const [p, profile] of Object.entries({ 'openai-codex': 'openai-codex:nextbase-gateway' })) { const old = Array.isArray(state.order[p]) ? state.order[p] : []; state.order[p] = [profile, ...old.filter(x => x !== profile)]; }
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
curl -sS -N \
  -H "Authorization: Bearer <YOUR_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.5","stream":true,"input":[{"role":"user","content":[{"type":"input_text","text":"pong"}]}]}' \
  http://localhost:8080/v1/responses
```

## Realtime voice client secret

```bash
curl -sS -i \
  -H "Authorization: Bearer <YOUR_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-realtime-2","voice":"alloy","instructions":"Be concise."}' \
  http://localhost:8080/v1/realtime/client_secrets
```

The gateway normalizes `GPT-Realtime-2` to `gpt-realtime-2`, wraps simple bodies into OpenAI's `session` shape, and forwards to OpenAI's `/v1/realtime/client_secrets` using the Codex OAuth pool. Use the returned ephemeral secret with OpenAI's WebRTC `/v1/realtime/calls` flow. Do not use this ephemeral secret with OpenAI's WebSocket endpoint; OpenAI's WebSocket path requires a standard OpenAI API key server-side and rejects the Codex OAuth path.

## What success looks like
- Curl returns HTTP 200.
- Response headers include `x-gateway-provider: openai-codex` and `x-gateway-account: Codex account label`.

## Troubleshooting
- 401 token errors usually mean the full `sp_*` secret was not pasted; the dashboard prefix alone is not enough.
- 403 or "IP not allowed" means the token has an IP allow-list that does not include this machine.
- 429 means the token, user, or upstream account hit a quota/cooldown; wait or choose another account/token.
- If OCPlatform sends `x-api-key` to Anthropic-shaped routes, set `authHeader: true` so it sends `Authorization: Bearer ...`.
- For Codex, native `agentRuntime.id: "codex"` bypasses this gateway; use the configured gateway provider/model instead.

## Provider-specific notes
- Default text model is `gpt-5.5`.
- Realtime voice models: `gpt-realtime-2` and `gpt-realtime` via `/v1/realtime/client_secrets` for WebRTC.
- Streaming is supported through Responses API SSE.
- Cost expectation: subscription/OAuth-routed Codex usage, subject to gateway and account limits.
- Native OCPlatform `agentRuntime.id: "codex"` bypasses HTTP base URLs and talks to ChatGPT directly; choose an `openai-codex/*` model instead.
