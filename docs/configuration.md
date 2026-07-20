# Configuration

Super Proxy is configured primarily through environment variables.

```bash
cp .env.example .env
```

## Core settings

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8080` | HTTP listen port |
| `DATABASE_PATH` | `./data/super-proxy.sqlite` | SQLite database path |
| `ADMIN_EMAIL` | `admin@localhost` | Admin identity allowed to bootstrap through configured browser auth |
| `SESSION_SECRET` | none | Secret used to sign dashboard session cookies |
| `DEV_ADMIN_KEY` | none | Header-based bootstrap administrator key |
| `NODE_ENV` | `development` | Use `production` for deployed instances |
| `GATEWAY_NAME` | `Super Proxy` | Display and integration name |
| `GATEWAY_PUBLIC_URL` | `http://localhost:8080` | Public base URL used by integrations |

The server listens on all interfaces. Apply network policy and TLS at your
reverse proxy or container platform.

## Generate bootstrap secrets

Generate the values independently:

```bash
openssl rand -hex 32
openssl rand -hex 32
```

Paste one output after `SESSION_SECRET=` and the other after `DEV_ADMIN_KEY=`
in `.env`. Docker Compose rejects an empty value for either variable. Rotate
both before deploying a copied or shared environment.

`DEV_ADMIN_KEY` grants administrator access through the `x-admin-key` header.
It is intended for self-host bootstrap and trusted maintenance, not as an API
token for applications.

## Upstream overrides

Each provider accepts an optional `*_UPSTREAM_URL`; see [`.env.example`](../.env.example).
Leave these unset or at their documented defaults unless a provider requires a
custom endpoint.

## Feature flags

| Variable | Default | Description |
| --- | --- | --- |
| `HEADROOM_ENABLED` | `false` | Enable the configured context compression sidecar |
| `NORMALIZE_GLM` | `false` | Enable GLM stream normalization |
| `NORMALIZE_KIMI` | `false` | Enable Kimi stream normalization |
| `MONITOR_RETENTION_ENABLED` | `false` | Enable monitoring retention jobs |

## Credentials and tokens

Do not put production provider keys, session cookies, or gateway tokens in
tracked files.

- Configure provider accounts through the dashboard/admin API or a
  `SecretStore` integration.
- Issue a separate gateway API token for each client or user.
- Rotate bootstrap and API credentials after disclosure or staff changes.

## Database

SQLite is the default self-host database.

- Back up `DATABASE_PATH` regularly and test restores.
- Docker Compose uses `/app/data/super-proxy.sqlite` in the
  `super-proxy-data` named volume.
- The container runs as uid/gid `10001:10001`; custom bind mounts must be
  writable by that identity.
