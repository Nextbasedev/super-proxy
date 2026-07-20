# Super Proxy

**Open-source multi-provider AI gateway.**  
One self-hosted endpoint for OpenAI-compatible and Anthropic-compatible APIs — with auth, usage limits, streaming, provider pools, and a built-in dashboard.

> Alpha self-host release (local tree). Not published to a public GitHub remote until explicitly approved.

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](./package.json)

---

## Why Super Proxy?

| Pain | Super Proxy |
|---|---|
| Every provider has a different API shape | Unified **OpenAI** + **Anthropic** surfaces |
| Keys scattered across tools | **API tokens** with per-token limits |
| No visibility | **Usage**, cost accounting, health, dashboard |
| One account rate-limit kills the app | **Provider pools** + governor |
| Want Claude Code / OpenAI SDKs unchanged | Drop-in base URL override |

---

## Features

- **OpenAI-compatible** chat/completions & related routes  
- **Anthropic-compatible** `/v1/messages` (+ raw Anthropic passthrough where enabled)  
- **Multi-provider**: Anthropic, OpenAI/Codex, Groq, Cerebras, Kimi, GLM, Gemini, OpenRouter, xAI, Deepgram, Fish, Runpod, search, Fusion  
- **Streaming & non-streaming**  
- **Token auth** + admin APIs  
- **SQLite** persistence (simple self-host default)  
- **Usage / policy / cost** hooks  
- **Web dashboard** (`public/`) for operators  
- **Docker Compose** one-command start  

---

## Quick start

### Prerequisites

- Node.js **20+**
- npm 10+

### Local

```bash
git clone <this-repo> super-proxy
cd super-proxy
cp .env.example .env
npm ci
npm run build
npm start
```

Health:

```bash
curl -sS http://127.0.0.1:8080/health
```

Dashboard: [http://127.0.0.1:8080/](http://127.0.0.1:8080/)

### Docker Compose

```bash
cp .env.example .env
docker compose up --build -d
curl -sS http://127.0.0.1:8080/health
```

---

## Example requests

Set:

```bash
export SUPER_PROXY_URL=http://127.0.0.1:8080
export SUPER_PROXY_API_KEY=sp_your_token_here
```

### OpenAI-compatible

```bash
curl -sS "$SUPER_PROXY_URL/v1/chat/completions" \
  -H "Authorization: Bearer $SUPER_PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role":"user","content":"Say hello"}],
    "stream": false
  }'
```

### Anthropic-compatible

```bash
curl -sS "$SUPER_PROXY_URL/v1/messages" \
  -H "x-api-key: $SUPER_PROXY_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5",
    "max_tokens": 128,
    "messages": [{"role":"user","content":"Say hello"}]
  }'
```

See `examples/` for copy-paste scripts.

---

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `DATABASE_PATH` | `./data/super-proxy.sqlite` | SQLite file |
| `ADMIN_EMAIL` | `admin@localhost` | Bootstrap admin identity |
| `NODE_ENV` | `development` | Runtime mode |
| `*_UPSTREAM_URL` | provider defaults | Override upstream bases |

Full list: [`.env.example`](./.env.example)

**Never commit real API keys.** Provider credentials belong in your environment or admin-configured secret store.

---

## Architecture

```text
Client SDK / Claude Code / curl
        │
        ▼
┌───────────────────────┐
│      Super Proxy      │
│  auth · policy · route│
│  pools · usage · admin│
└───────────┬───────────┘
            │
            ▼
   Upstream model providers
```

Extension points (stable, minimal):

- `GatewayPlugin`
- `ProviderAdapter`
- `AuthProvider`
- `SecretStore`

Details: [`ARCHITECTURE.md`](./ARCHITECTURE.md) · scope: [`OSS-SCOPE.md`](./OSS-SCOPE.md)

---

## Dashboard

The built-in operator console is served from `public/`:

- session/bootstrap against the local gateway  
- token and usage oriented workflows  
- no external control-plane dependency required for basic self-host  

---

## Development

```bash
npm ci
npm run build
npm test
./scripts/secret-scan.sh
```

Contributing: [`CONTRIBUTING.md`](./CONTRIBUTING.md)  
Security: [`SECURITY.md`](./SECURITY.md)

---

## License

Apache License 2.0 — see [`LICENSE`](./LICENSE).

---

## Status

Wave 1 focuses on a **complete self-host gateway + dashboard**.  
Private production control-plane integrations (fleet orchestration, company-specific deploy wiring) stay out of this tree on purpose.
