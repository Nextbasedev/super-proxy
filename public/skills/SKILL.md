---
name: nextbase-super-proxy-setup
description: Set up OCPlatform or another agent client to use all Super Proxy providers.
---

# Super Proxy

Super Proxy is a proxy in front of multiple model providers, authenticated by a single `sp_*` token. It lets OCPlatform, Claude Code, Codex CLI, Kimi CLI, Hermes, and other LLM-driven agents route model calls through Nextbase without storing upstream provider secrets locally. The gateway validates your token, selects a healthy upstream account, enforces caps, and returns provider-compatible responses.

## Clients

Pick your agent client first — the wiring differs by client, the providers are the same:

| Client | Config style | Setup |
| --- | --- | --- |
| OCPlatform | JSON (`openclaw.json` / `models.json` / auth profiles), `authHeader: true` | the per-provider skills below |
| Hermes (NousResearch/hermes-agent) | YAML `config.yaml` `custom_providers` + `key_env` env token | [/skills/hermes/SKILL.md](/skills/hermes/SKILL.md) |

The Anthropic billing path is detected automatically per client (Hermes `mcp_` tools → Hermes transform; OCPlatform bare tools → legacy transform) — no client flag to set.

## Providers

| Provider | Routes | Skill |
| --- | --- | --- |
| Anthropic | `/v1/messages`, `/v1/messages/count_tokens` | [/skills/anthropic/SKILL.md](/skills/anthropic/SKILL.md) |
| OpenAI Codex | `/v1/responses`, `/v1/realtime/client_secrets` | [/skills/openai-codex/SKILL.md](/skills/openai-codex/SKILL.md) |
| OpenAI Images | `/v1/images/generations`, `/v1/images/edits` | [/skills/openai-images/SKILL.md](/skills/openai-images/SKILL.md) |
| Groq | `/v1/groq/chat/completions`, `/v1/groq/audio/transcriptions`, `/v1/groq/audio/translations` | [/skills/groq/SKILL.md](/skills/groq/SKILL.md) |
| Cerebras | `/v1/cerebras/chat/completions` | [/skills/cerebras/SKILL.md](/skills/cerebras/SKILL.md) |
| Kimi | `/v1/kimi/chat/completions`, `/v1/kimi/messages` | [/skills/kimi/SKILL.md](/skills/kimi/SKILL.md) |
| GLM (z.ai) | `/v1/glm/messages` | [/skills/glm/SKILL.md](/skills/glm/SKILL.md) |
| Gemini | `/v1/gemini/embeddings`, `/v1/gemini/chat/completions`, `/v1/gemini/tts` | [/skills/gemini/SKILL.md](/skills/gemini/SKILL.md) |
| OpenRouter | `/v1/openrouter/chat/completions` | [/skills/openrouter/SKILL.md](/skills/openrouter/SKILL.md) |
| Deepgram | `/v1/deepgram/listen` | [/skills/deepgram/SKILL.md](/skills/deepgram/SKILL.md) |
| xAI | `/v1/xai/responses`, `/v1/xai/realtime/client_secrets`, `/v1/xai/tts`, `/v1/xai/stt`, `/v1/xai/images/generations`, `/v1/xai/videos/generations`, `/v1/xai/videos/:requestId` | [/skills/xai/SKILL.md](/skills/xai/SKILL.md) |
| Runpod | `/v1/runpod/chat/completions`, `/v1/runpod/models` | [/skills/runpod/SKILL.md](/skills/runpod/SKILL.md) |
| Search | `/v1/search` | [/skills/search/SKILL.md](/skills/search/SKILL.md) |
| Fusion | `/v1/fusion/chat/completions`, `/v1/models` | [/skills/fusion/SKILL.md](/skills/fusion/SKILL.md) |

## One-shot setup script

This script patches the standard OCPlatform config files with all Nextbase providers, writes auth profiles using your `sp_*` token, updates `auth-state.json` `lastGood` selections, creates timestamped backups, and restarts `openclaw-gateway.service` when present. Replace `<YOUR_TOKEN>` with the full token value; do not use only the dashboard token prefix.

```bash
#!/usr/bin/env bash
set -euo pipefail

export TOKEN="<YOUR_TOKEN>"
export BASE_URL="http://localhost:8080"

if [ "$TOKEN" = "<YOUR_TOKEN>" ] || [ -z "$TOKEN" ]; then
  echo "Edit TOKEN first: replace <YOUR_TOKEN> with your sp_* token" >&2
  exit 1
fi

node <<'NODE'
const fs = require('fs');
const os = require('os');
const path = require('path');

const token = process.env.TOKEN;
const baseUrl = process.env.BASE_URL;
const home = os.homedir();
const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    return raw ? JSON.parse(raw) : fallback;
  } catch (_) {
    return fallback;
  }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak-nextbase-' + stamp);
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  console.log('patched ' + file);
}

const anthropic = { baseUrl, authHeader: true, models: [] };
const codex = {
  baseUrl: baseUrl + '/v1',
  api: 'openai-responses',
  apiKey: token,
  models: [{ id: 'gpt-5.5', name: 'GPT-5.5', reasoning: true, input: ['text', 'image'], contextWindow: 400000, maxTokens: 128000 }]
};
const openai = { baseUrl: baseUrl + '/v1', apiKey: token, models: [] };
const groq = { baseUrl: baseUrl + '/v1/groq', apiKey: token, models: [{ id: 'openai/gpt-oss-120b', name: 'Groq GPT OSS 120B' }] };
const cerebras = { baseUrl: baseUrl + '/v1/cerebras', apiKey: token, models: [{ id: 'gpt-oss-120b', name: 'Cerebras GPT OSS 120B' }, { id: 'zai-glm-4.7', name: 'Cerebras Z.ai GLM 4.7' }] };
const kimi = { baseUrl: baseUrl + '/v1/kimi', apiKey: token, models: [{ id: 'k3', name: 'Kimi K3' }, { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code' }, { id: 'kimi-k2.6', name: 'Kimi K2.6' }, { id: 'kimi-for-coding', name: 'Kimi for Coding' }] };
// Native Gemini free-tier pool (OpenAI-compat). Primary use is pooled embeddings for memorySearch; chat is optional.
const geminiNextbase = { baseUrl: baseUrl + '/v1/gemini', apiKey: token, models: [{ id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite' }] };
const kimiAnthropic = { baseUrl: baseUrl + '/v1/kimi', authHeader: true, models: [] };
// GLM (z.ai) is a transparent Anthropic Messages passthrough, so use authHeader: true (Bearer), like kimi-anthropic.
const glm = { baseUrl: baseUrl + '/v1/glm', authHeader: true, apiKey: token, models: [{ id: 'glm-5.2', name: 'GLM 5.2' }, { id: 'glm-5-turbo', name: 'GLM 5 Turbo' }, { id: 'glm-4.7', name: 'GLM 4.7' }] };
const openrouter = {
  baseUrl: baseUrl + '/v1/openrouter',
  apiKey: token,
  models: [
    { id: 'tencent/hy3:free', name: 'Tencent HY3 Free' },
  ],
};
const deepgram = {
  baseUrl: baseUrl + '/v1/deepgram',
  apiKey: token,
  models: [
    { id: 'nova-3', name: 'Deepgram Nova-3' },
    { id: 'nova-2', name: 'Deepgram Nova-2' },
    { id: 'whisper', name: 'Deepgram Whisper Cloud' },
  ],
};
const xai = {
  baseUrl: baseUrl + '/v1/xai',
  api: 'openai-responses',
  apiKey: token,
  models: [{ id: 'grok-4.3', name: 'Grok 4.3', reasoning: true, input: ['text', 'image'] }],
};
const runpod = {
  baseUrl: baseUrl + '/v1/runpod',
  apiKey: token,
  models: [
    { id: 'qwen36-27b', name: 'Qwen3.6 27B' },
    { id: 'qwen36-27b-fast', name: 'Qwen3.6 27B Fast' },
  ],
};
const fusion = {
  baseUrl: baseUrl + '/v1/fusion',
  apiKey: token,
  api: 'openai-completions',
  models: [
    { id: 'fusion/max', name: 'Fusion Max', reasoning: true, input: ['text'], contextWindow: 200000, maxTokens: 8192 },
    { id: 'fusion/quality', name: 'Fusion Quality', reasoning: true, input: ['text'], contextWindow: 200000, maxTokens: 8192 },
    { id: 'fusion/budget', name: 'Fusion Budget', reasoning: true, input: ['text'], contextWindow: 200000, maxTokens: 8192 },
  ],
};

for (const file of [
  path.join(home, '.openclaw/openclaw.json'),
  path.join(home, '.openclaw/agents/main/agent/models.json'),
]) {
  const data = readJson(file, {});
  const providers = file.endsWith('openclaw.json')
    ? (((data.models ||= {}).providers ||= {}))
    : (data.providers ||= {});
  providers.anthropic = anthropic;
  providers['openai-codex'] = codex;
  providers.openai = openai;
  providers.groq = groq;
  providers.cerebras = cerebras;
  providers.kimi = kimi;
  providers['kimi-anthropic'] = kimiAnthropic;
  providers.glm = glm;
  providers['gemini-nextbase'] = geminiNextbase;
  providers.openrouter = openrouter;
  providers.deepgram = deepgram;
  providers.xai = xai;
  providers.runpod = runpod;
  providers.fusion = fusion;
  // Patch agents.defaults.models so /models command lists fusion models
  if (file.endsWith('openclaw.json')) {
    const models = ((data.agents ||= {}).defaults ||= {}).models ||= {};
    models['fusion/fusion/max'] = models['fusion/fusion/max'] || {};
    models['fusion/fusion/quality'] = models['fusion/fusion/quality'] || {};
    models['fusion/fusion/budget'] = models['fusion/fusion/budget'] || {};
  }
  writeJson(file, data);
}

const profilesFile = path.join(home, '.openclaw/agents/main/agent/auth-profiles.json');
const profilesData = readJson(profilesFile, { profiles: {} });
const profiles = profilesData.profiles ||= {};
profiles['anthropic:manual'] = { type: 'token', provider: 'anthropic', token };
profiles['openai-codex:nextbase-gateway'] = { type: 'api_key', provider: 'openai-codex', key: token };
profiles['openai:nextbase-gateway'] = { type: 'api_key', provider: 'openai', key: token };
profiles['groq:nextbase-gateway'] = { type: 'api_key', provider: 'groq', key: token };
profiles['cerebras:nextbase-gateway'] = { type: 'api_key', provider: 'cerebras', key: token };
profiles['kimi:nextbase-gateway'] = { type: 'api_key', provider: 'kimi', key: token };
profiles['kimi-anthropic:nextbase-gateway'] = { type: 'token', provider: 'kimi-anthropic', token };
profiles['glm:nextbase-gateway'] = { type: 'token', provider: 'glm', token };
profiles['openrouter:nextbase-gateway'] = { type: 'api_key', provider: 'openrouter', key: token };
profiles['deepgram:nextbase-gateway'] = { type: 'api_key', provider: 'deepgram', key: token };
profiles['xai:nextbase-gateway'] = { type: 'api_key', provider: 'xai', key: token };
profiles['runpod:nextbase-gateway'] = { type: 'api_key', provider: 'runpod', key: token };
profiles['fusion:nextbase-gateway'] = { type: 'api_key', provider: 'fusion', key: token };
writeJson(profilesFile, profilesData);

const stateFile = path.join(home, '.openclaw/agents/main/agent/auth-state.json');
const state = readJson(stateFile, {});
state.lastGood ||= {};
Object.assign(state.lastGood, {
  anthropic: 'anthropic:manual',
  'openai-codex': 'openai-codex:nextbase-gateway',
  openai: 'openai:nextbase-gateway',
  groq: 'groq:nextbase-gateway',
  cerebras: 'cerebras:nextbase-gateway',
  kimi: 'kimi:nextbase-gateway',
  'kimi-anthropic': 'kimi-anthropic:nextbase-gateway',
  glm: 'glm:nextbase-gateway',
  openrouter: 'openrouter:nextbase-gateway',
  deepgram: 'deepgram:nextbase-gateway',
  xai: 'xai:nextbase-gateway',
  runpod: 'runpod:nextbase-gateway',
  fusion: 'fusion:nextbase-gateway',
});
state.order ||= {};
for (const [provider, profile] of Object.entries(state.lastGood)) {
  const old = Array.isArray(state.order[provider]) ? state.order[provider] : [];
  state.order[provider] = [profile, ...old.filter(x => x !== profile)];
}
writeJson(stateFile, state);
NODE

if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files openclaw-gateway.service >/dev/null 2>&1; then
  systemctl restart openclaw-gateway.service
  systemctl is-active openclaw-gateway.service
else
  echo "Restart OCPlatform now (gateway service not found)."
fi

```

## How to verify

First check the token without spending model credits:

```bash
curl -sS -i \
  -H "Authorization: Bearer <YOUR_TOKEN>" \
  http://localhost:8080/v1/token/check
```

Then run a provider smoke test from the relevant provider skill. A successful provider response returns HTTP 200 and headers such as `x-gateway-provider` and `x-gateway-account`.

## Troubleshooting

- 401 token errors usually mean the full `sp_*` secret was not pasted; the dashboard prefix alone is not enough.
- 403 or "IP not allowed" means this token has an IP allow-list that does not include the machine making the request.
- 429 means the token, user, or upstream account hit a quota or cooldown.
- Anthropic, `kimi-anthropic`, and `glm` must use `authHeader: true` so OCPlatform sends `Authorization: Bearer ...`, not `x-api-key`.
- Native OCPlatform Codex runtime may bypass HTTP base URLs; use the `openai-codex` provider/model if you need gateway-routed Codex traffic.
- Image generation uses the regular `openai` provider for `gpt-image-2`, not `openai-codex`.
- OpenRouter is strict allowlist only; currently configure it for the gateway-listed Gemini models.
- Deepgram is transcription-only and uses `/v1/deepgram/listen`, not an OpenAI chat route.
- xAI uses the Responses API at `/v1/xai/responses`, Grok Voice under `/v1/xai/realtime/client_secrets` / `/v1/xai/tts` / `/v1/xai/stt`, and Grok Imagine media endpoints under `/v1/xai/images/*` / `/v1/xai/videos/*`; non-admin users are denied by default until enabled in Model access or granted.
- Runpod uses OpenAI-compatible chat at `/v1/runpod/chat/completions` with `qwen36-27b` and `qwen36-27b-fast`; non-admin users are denied by default until enabled in Model access or granted.
