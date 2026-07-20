---
name: nextbase-anthropic-setup
description: Configure OCPlatform to send Anthropic Messages API traffic through Nextbase using Bearer auth instead of `x-api-key`.
---

# Anthropic via Super Proxy

Anthropic via Nextbase routes `/v1/messages` through the gateway so your agent can use pooled upstream Anthropic accounts without carrying provider keys locally. The gateway validates your `sp_*` token, picks a healthy upstream account, and returns normal Anthropic-compatible responses.

For Claude Code, use the raw base URL when the client request must reach Anthropic without the gateway's Claude Code/Hermes request rewriting, tool renaming, response reverse mapping, refusal synthesis, or cross-provider fallback:

```bash
export ANTHROPIC_BASE_URL="http://localhost:8080/v1/anthropic-raw"
export ANTHROPIC_AUTH_TOKEN="sp_<your_token>"
unset ANTHROPIC_API_KEY
```

Claude Code appends `/v1/messages`, producing `POST /v1/anthropic-raw/v1/messages`. Gateway authentication, account selection, model access, limits, usage accounting, and safe auth-header replacement still apply.

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
        "anthropic": {
          "baseUrl": "http://localhost:8080",
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
    "anthropic": {
      "baseUrl": "http://localhost:8080",
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
    "anthropic:manual": {
      "type": "token",
      "provider": "anthropic",
      "token": "<YOUR_TOKEN>"
    }
  }
}
```

`~/.openclaw/agents/main/agent/auth-state.json`:

```json
{
  "lastGood": { "anthropic": "anthropic:manual" }
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
const provider = { anthropic: { baseUrl, authHeader: true, models: [] } };
for (const file of [path.join(home, '.openclaw/openclaw.json'), path.join(home, '.openclaw/agents/main/agent/models.json')]) {
  const data = readJson(file, {});
  const providers = file.endsWith('openclaw.json') ? (((data.models ||= {}).providers ||= {})) : (data.providers ||= {});
  Object.assign(providers, provider);
  writeJson(file, data);
}
const profilesFile = path.join(home, '.openclaw/agents/main/agent/auth-profiles.json');
const profilesData = readJson(profilesFile, { profiles: {} });
Object.assign((profilesData.profiles ||= {}), { 'anthropic:manual': { type: 'token', provider: 'anthropic', token } });
writeJson(profilesFile, profilesData);
const stateFile = path.join(home, '.openclaw/agents/main/agent/auth-state.json');
const state = readJson(stateFile, {}); state.lastGood ||= {}; Object.assign(state.lastGood, { anthropic: 'anthropic:manual' });
state.order ||= {}; for (const [p, profile] of Object.entries({ anthropic: 'anthropic:manual' })) { const old = Array.isArray(state.order[p]) ? state.order[p] : []; state.order[p] = [profile, ...old.filter(x => x !== profile)]; }
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
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-sonnet-4-5-20250929","max_tokens":16,"messages":[{"role":"user","content":"pong"}]}' \
  http://localhost:8080/v1/messages
```

## What success looks like
- Curl returns HTTP 200.
- Response headers include `x-gateway-provider: anthropic` and `x-gateway-account: Anthropic account label`.

## Troubleshooting
- 401 token errors usually mean the full `sp_*` secret was not pasted; the dashboard prefix alone is not enough.
- 403 or "IP not allowed" means the token has an IP allow-list that does not include this machine.
- 429 means the token, user, or upstream account hit a quota/cooldown; wait or choose another account/token.
- If OCPlatform sends `x-api-key` to Anthropic-shaped routes, set `authHeader: true` so it sends `Authorization: Bearer ...`.
- For Codex, native `agentRuntime.id: "codex"` bypasses this gateway; use the configured gateway provider/model instead.

## Provider-specific notes
- Default model is whatever Anthropic model your OCPlatform config selects; the smoke test uses `claude-sonnet-4-5-20250929`.
- Streaming is supported for Messages API streams.
- Cost depends on the upstream Anthropic account routed by the gateway; your `sp_*` token may also have local spending caps.
- Important: keep `authHeader: true`; do not put `apiKey` in `openclaw.json` for Anthropic.
