# Configuration

Super Proxy is configured primarily through environment variables.

```bash
cp .env.example .env
```

## Core

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | HTTP listen port |
| `HOST` binding | `0.0.0.0` in server | Set edge TLS separately |
| `DATABASE_PATH` | `./data/super-proxy.sqlite` | SQLite path |
| `ADMIN_EMAIL` | `admin@localhost` | Bootstrap admin email |
| `NODE_ENV` | `development` | `production` recommended in deploy |
| `GATEWAY_NAME` | `Super Proxy` | Display/branding name |
| `GATEWAY_PUBLIC_URL` | `http://localhost:8080` | Public base URL for callbacks/headers |

## Upstream overrides

Each provider accepts an optional `*_UPSTREAM_URL` (see `.env.example`).

## Feature flags

| Variable | Default | Description |
|---|---|---|
| `HEADROOM_ENABLED` | `false` | Context compression sidecar |
| `NORMALIZE_GLM` | `false` | GLM stream normalization |
| `NORMALIZE_KIMI` | `false` | Kimi stream normalization |
| `MONITOR_RETENTION_ENABLED` | `false` | Monitoring retention jobs |

## Secrets

Do not put production provider keys in git.

- Prefer environment variables or a `SecretStore` plugin (`src/secrets`)
- Issue per-client gateway API tokens from the dashboard/admin API
- Rotate tokens after staff or integration changes

## Database

SQLite is the default for simple self-host.

- Back up `DATABASE_PATH` regularly
- Put the file on persistent storage in Docker (`super-proxy-data` volume)
