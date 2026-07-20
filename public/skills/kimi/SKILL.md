---
name: nextbase-kimi-setup
description: Configure OCPlatform for Kimi K3 or K2.7 Code through Nextbase in both OpenAI and Anthropic shapes.
---

# Kimi via Super Proxy

Kimi via Nextbase supports OpenAI-compatible chat at `/v1/kimi/chat/completions` and Anthropic-compatible Messages at `/v1/kimi/messages`. This lets OCPlatform, Claude-style clients, and OpenAI-style clients share the same `sp_*` token. Kimi K3 uses the exact model ID `k3` and is the recommended flagship option for coding-heavy workloads.

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
        "kimi": {
          "baseUrl": "http://localhost:8080/v1/kimi",
          "apiKey": "<YOUR_TOKEN>",
          "models": [
            { "id": "k3", "name": "Kimi K3" },
            { "id": "kimi-k2.7-code-highspeed", "name": "Kimi K2.7 Code Highspeed" },
            { "id": "kimi-k2.7-code", "name": "Kimi K2.7 Code" },
            { "id": "kimi-k2.6", "name": "Kimi K2.6" },
            { "id": "kimi-for-coding", "name": "Kimi for Coding" }
          ]
        },
        "kimi-anthropic": {
          "baseUrl": "http://localhost:8080/v1/kimi",
          "authHeader": true,
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
    "kimi": {
      "baseUrl": "http://localhost:8080/v1/kimi",
      "apiKey": "<YOUR_TOKEN>",
      "models": [
        { "id": "k3", "name": "Kimi K3" },
        { "id": "kimi-k2.7-code-highspeed", "name": "Kimi K2.7 Code Highspeed" },
        { "id": "kimi-k2.7-code", "name": "Kimi K2.7 Code" },
        { "id": "kimi-k2.6", "name": "Kimi K2.6" },
        { "id": "kimi-for-coding", "name": "Kimi for Coding" }
      ]
    },
    "kimi-anthropic": {
      "baseUrl": "http://localhost:8080/v1/kimi",
      "authHeader": true,
      "models": []
    }
  }
}
```

`~/.openclaw/agents/main/agent/auth-profiles.json`:

```json
{
  "profiles": {
    "kimi:nextbase-gateway": {
      "type": "api_key",
      "provider": "kimi",
      "key": "<YOUR_TOKEN>"
    },
    "kimi-anthropic:nextbase-gateway": {
      "type": "token",
      "provider": "kimi-anthropic",
      "token": "<YOUR_TOKEN>"
    }
  }
}
```

`~/.openclaw/agents/main/agent/auth-state.json`:

```json
{
  "lastGood": {
    "kimi": "kimi:nextbase-gateway",
    "kimi-anthropic": "kimi-anthropic:nextbase-gateway"
  }
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
const provider = { kimi: { baseUrl: baseUrl + '/v1/kimi', apiKey: token, models: [{ id: 'k3', name: 'Kimi K3' }, { id: 'kimi-k2.7-code-highspeed', name: 'Kimi K2.7 Code Highspeed' }, { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code' }, { id: 'kimi-k2.6', name: 'Kimi K2.6' }, { id: 'kimi-for-coding', name: 'Kimi for Coding' }] }, 'kimi-anthropic': { baseUrl: baseUrl + '/v1/kimi', authHeader: true, models: [] } };
for (const file of [path.join(home, '.openclaw/openclaw.json'), path.join(home, '.openclaw/agents/main/agent/models.json')]) {
  const data = readJson(file, {});
  const providers = file.endsWith('openclaw.json') ? (((data.models ||= {}).providers ||= {})) : (data.providers ||= {});
  Object.assign(providers, provider);
  writeJson(file, data);
}
const profilesFile = path.join(home, '.openclaw/agents/main/agent/auth-profiles.json');
const profilesData = readJson(profilesFile, { profiles: {} });
Object.assign((profilesData.profiles ||= {}), { 'kimi:nextbase-gateway': { type: 'api_key', provider: 'kimi', key: token }, 'kimi-anthropic:nextbase-gateway': { type: 'token', provider: 'kimi-anthropic', token } });
writeJson(profilesFile, profilesData);
const stateFile = path.join(home, '.openclaw/agents/main/agent/auth-state.json');
const state = readJson(stateFile, {}); state.lastGood ||= {}; Object.assign(state.lastGood, { kimi: 'kimi:nextbase-gateway', 'kimi-anthropic': 'kimi-anthropic:nextbase-gateway' });
state.order ||= {}; for (const [p, profile] of Object.entries({ kimi: 'kimi:nextbase-gateway', 'kimi-anthropic': 'kimi-anthropic:nextbase-gateway' })) { const old = Array.isArray(state.order[p]) ? state.order[p] : []; state.order[p] = [profile, ...old.filter(x => x !== profile)]; }
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
  -d '{"model":"k3","reasoning_effort":"max","messages":[{"role":"user","content":"pong"}]}' \
  http://localhost:8080/v1/kimi/chat/completions
```

## What success looks like
- Curl returns HTTP 200.
- Response headers include `x-gateway-provider: kimi` and `x-gateway-account: Kimi account label`.

## Troubleshooting
- 401 token errors usually mean the full `sp_*` secret was not pasted; the dashboard prefix alone is not enough.
- 403 or "IP not allowed" means the token has an IP allow-list that does not include this machine.
- 429 means the token, user, or upstream account hit a quota/cooldown; wait or choose another account/token.
- If OCPlatform sends `x-api-key` to Anthropic-shaped routes, set `authHeader: true` so it sends `Authorization: Bearer ...`.
- For Codex, native `agentRuntime.id: "codex"` bypasses this gateway; use the configured gateway provider/model instead.

## Provider-specific notes
- `k3` is Kimi's exact K3 model ID (not `kimi-k3`). The OpenAI-compatible route defaults omitted `reasoning_effort` to `"max"`; `ultra`/`xhigh` normalize to `"max"`, and `"none"` disables thinking.
- K3 context depends on the Kimi membership plan: Moderato supports 256k; Allegretto and above support up to 1M. This Super Proxy deployment uses Allegretto, so configure K3 clients with `contextWindow` / `context_length` **1048576**.
- Default model remains `kimi-k2.6` for compatibility; `k3`, `kimi-k2.7-code-highspeed`, `kimi-k2.7-code`, and `kimi-for-coding` are also configured.
- Streaming is supported for both OpenAI-compatible and Anthropic-compatible shapes when upstream supports it.
- Cost expectation: Kimi subscription/free/paid behavior depends on the upstream account and gateway caps.
- For Anthropic-shaped Kimi, keep `authHeader: true` so OCPlatform sends Bearer auth.
