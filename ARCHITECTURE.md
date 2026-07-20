# Architecture

Super Proxy is a **single-package TypeScript gateway**.  
One process, SQLite by default, Fastify HTTP server, provider adapters behind stable routes.

## Goals

1. Drop-in **OpenAI** and **Anthropic** compatible surfaces  
2. Safe multi-tenant **token** access with limits  
3. Pluggable providers without rewriting clients  
4. Self-host simplicity (env + SQLite + Docker)  
5. Operator **dashboard** without a separate backend  

## Directory map

```text
src/
  server.ts           # process entry — listen
  app wiring          # route registration (server/build path)
  config.ts           # env-backed configuration
  plugins/types.ts    # GatewayPlugin, ProviderAdapter, AuthProvider, SecretStore
  secrets/            # default env secret store
  auth/               # API token + dashboard auth
  db/                 # sqlite + migrations
  providers/          # pools, governor, known models
  proxy/              # HTTP route adapters per provider/surface
  normalize/          # stream/event normalization
  fusion/             # multi-model fusion (optional feature)
  admin/              # admin HTTP API + health
  monitoring/         # metrics/rollups/alerts
  anthropic/          # anthropic-specific transforms
public/               # dashboard static assets
docs/                 # deep docs
examples/             # curl/scripts
scripts/              # secret-scan, utilities
```

## Request path

```text
HTTP request
  → CORS / cookie / static
  → auth (bearer / x-api-key / dashboard session)
  → policy (model allow, budgets, concurrency)
  → provider pool selection (governor)
  → upstream fetch (stream or buffered)
  → normalize events (when enabled)
  → usage + cost accounting
  → response to client
```

## Extension points

Keep these **small and real** — no framework cosplay.

### `SecretStore`
Resolve secret material by key (env, file, vault later).

### `AuthProvider`
Authenticate callers into a gateway principal/token context.

### `ProviderAdapter`
Logical provider identity used by routing and pools.

### `GatewayPlugin`
Optional feature registration on the Fastify app.

Private/internal products can implement additional plugins out-of-tree without forking route code.

## Dashboard

`public/` is a static operator UI:

- loaded by Fastify static host  
- talks to same-origin admin/self APIs  
- must not require private control-plane services  

## Persistence

SQLite (via `better-sqlite3`) stores:

- users / tokens  
- usage and request logs  
- provider account metadata (self-host configured)  
- monitoring rollups  

Migrations: `src/db/migrate.ts` (idempotent startup migrate).

## Non-goals (this repo)

- Cloud multi-region control plane  
- Hosted billing SaaS  
- Company-specific fleet schedulers  
- Hard-coded third-party account inventories  

## Testing strategy

- Unit/integration tests with Node test runner (`*.test.ts`)  
- Focused provider route tests with local Fastify inject  
- `scripts/secret-scan.sh` gates private markers and secret shapes  
- `npm run build` (`tsc`) must stay clean  

## Production notes

Treat Super Proxy like any reverse proxy:

- terminate TLS at your edge  
- restrict admin endpoints  
- back up `DATABASE_PATH`  
- rotate API tokens  
- set provider keys via env/secret store — never bake into images  
