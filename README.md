<img width="1672" height="941" alt="f1ba00cc-3627-49fd-abb2-353f88d9e666" src="https://github.com/user-attachments/assets/b2a06d91-eb5e-42bd-a9ff-73d7445478b7" />
# Super Proxy

**Open-source multi-provider AI gateway.**

Super Proxy provides one self-hosted endpoint for OpenAI-compatible and
Anthropic-compatible APIs, with authentication, usage limits, streaming,
provider pools, and a built-in operator dashboard.

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](./package.json)

## Why Super Proxy?

| Pain | Super Proxy |
| --- | --- |
| Every provider has a different API shape | Unified OpenAI and Anthropic surfaces |
| Keys are scattered across tools | Gateway API tokens with per-token limits |
| Operators lack visibility | Usage, cost accounting, health, and dashboard views |
| One account rate limit stops an app | Provider pools and concurrency controls |
| Existing SDKs need a stable endpoint | Drop-in base URL overrides |

## Features

- OpenAI-compatible chat, completions, responses, and related routes
- Anthropic-compatible `/v1/messages` routes
- Multiple upstream providers, including Anthropic, OpenAI, Groq, Cerebras,
  Kimi, GLM, Gemini, OpenRouter, xAI, Deepgram, Fish Audio, and Runpod
- Streaming and non-streaming responses
- Gateway token authentication and admin APIs
- SQLite persistence
- Usage, policy, and cost controls
- Built-in operator dashboard
- Docker Compose deployment

## Quick start

### Prerequisites

Choose either:

- Node.js 20+ and npm 10+; or
- Docker with Docker Compose v2.

`openssl` is used below to generate independent random secrets.

### Configure secrets

```bash
git clone https://github.com/Nextbasedev/super-proxy.git
cd super-proxy
cp .env.example .env
sed -i.bak "s/^SESSION_SECRET=.*/SESSION_SECRET=$(openssl rand -hex 32)/" .env
sed -i.bak "s/^DEV_ADMIN_KEY=.*/DEV_ADMIN_KEY=$(openssl rand -hex 32)/" .env
rm -f .env.bak
```

Do not reuse the two values or commit `.env`. `SESSION_SECRET` signs browser
sessions. `DEV_ADMIN_KEY` is a bootstrap administrator credential and should be
protected like a password.

### Start with Node.js

```bash
npm ci
npm run build
npm start
```

### Start with Docker Compose

```bash
docker compose up --build -d
docker compose ps
docker compose exec super-proxy id
curl -fsS http://127.0.0.1:8080/health
```

The container runs as uid/gid `10001:10001`. Compose stores SQLite at
`/app/data/super-proxy.sqlite` in the writable `super-proxy-data` named volume.

### Bootstrap the dashboard

1. Open [http://127.0.0.1:8080/](http://127.0.0.1:8080/).
2. Expand **Use dev admin key instead**.
3. Paste the `DEV_ADMIN_KEY` value from `.env` and press **Enter**.
4. Add a user and issue a gateway API token from the **Identity** view.
5. Store the displayed `sp_...` token immediately; it is not shown again.

The dev admin key sends the `x-admin-key` header and is intended for initial
self-host setup. Configure your normal authentication path and restrict the
dashboard to a trusted network before exposing the service beyond localhost.

## Example requests

Set the URL and the gateway token created in the dashboard:

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

See [`examples/`](./examples) for scripts.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `DATABASE_PATH` | `./data/super-proxy.sqlite` | SQLite file |
| `ADMIN_EMAIL` | `admin@localhost` | Bootstrap admin identity |
| `SESSION_SECRET` | none | Browser session signing secret |
| `DEV_ADMIN_KEY` | none | Self-host admin bootstrap key |
| `NODE_ENV` | `development` | Runtime mode |
| `*_UPSTREAM_URL` | provider defaults | Optional upstream URL overrides |

See [`.env.example`](./.env.example) and
[`docs/configuration.md`](./docs/configuration.md) for details. Never commit
provider credentials or real gateway tokens.

## Architecture and documentation

```text
Client SDK / CLI / curl
        |
        v
+-----------------------+
|      Super Proxy      |
| auth, policy, routing |
| pools, usage, admin   |
+-----------+-----------+
            |
            v
   Upstream model providers
```

Public extension points include `GatewayPlugin`, `ProviderAdapter`,
`AuthProvider`, and `SecretStore`.

- [Architecture](./ARCHITECTURE.md)
- [Project scope](./OSS-SCOPE.md)
- [Getting started](./docs/getting-started.md)
- [Configuration](./docs/configuration.md)
- [Deployment](./docs/deployment.md)
- [Providers](./docs/providers.md)
- [Authentication](./docs/auth.md)

## Development

```bash
npm ci
npm run build
npm test
shellcheck scripts/*.sh examples/*.sh
./scripts/secret-scan.sh
```

See [`CONTRIBUTING.md`](./CONTRIBUTING.md),
[`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md), and
[`SECURITY.md`](./SECURITY.md).

## Release status

Super Proxy is pre-1.0. Interfaces and configuration may change between minor
releases; use Git tags and GitHub Releases as the source of truth for published
versions.

## License

Licensed under the Apache License 2.0. See [`LICENSE`](./LICENSE) and
[`NOTICE`](./NOTICE).
