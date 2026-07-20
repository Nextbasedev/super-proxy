# Super Proxy — OSS Scope

Working name: **super-proxy**  
Source baseline: super-proxy `origin/main` @ `787d2dd`  
Status: **local only** — do not create or push a public GitHub repository until Don explicitly approves.

## Wave 1 (in scope)

- Multi-provider AI gateway core
- OpenAI-compatible and Anthropic-compatible HTTP surfaces
- Provider adapters / pools / governor
- Streaming and non-streaming request paths
- API token authentication
- SQLite persistence and migrations
- Usage / cost accounting and basic policy limits
- Model catalog endpoint(s)
- Health and metrics endpoints
- Docker Compose self-host path
- Operator dashboard (`public/`)
- Fusion only if it has no private control-plane dependency

## Wave 1 (out of scope)

- Aside control plane (`aside*`)
- OC fleet integration (`oc-fleet*`)
- Production release-process / host-specific runbooks
- Company emails, Firebase project IDs, internal domains, account labels
- Private control-plane UIs only — **operator dashboard in `public/` is in scope**
- Private git history from production repository

## Architecture contracts (wave 1)

Prefer a single-package TypeScript gateway:

```text
src/
  app.ts              # buildApp()
  server.ts           # listen only
  config/
  core/
  auth/
  secrets/
  providers/
  routes/             # migrated from proxy/* over time
  usage/
  db/
  monitoring/
  plugins/
```

Minimum extension points (keep small and real):

- `GatewayPlugin`
- `ProviderAdapter`
- `AuthProvider`
- `SecretStore`

Do **not** invent unused abstraction layers.

## Agent ownership

| Agent | Owns | Must not touch |
|---|---|---|
| A runtime | `src/providers/**`, `src/proxy/**`→routes, `src/normalize/**`, `src/fusion/**`, related tests | docs package metadata beyond need; auth/db ownership files |
| B platform | `src/auth/**`, `src/db/**`, `src/admin/**`, usage/policy/cost, monitoring sanitize, config defaults | provider transport implementations; marketing docs body |
| C oss-dx | README, ARCHITECTURE, CONTRIBUTING, LICENSE, SECURITY, .env.example, Docker polish, CI local, secret-scan, examples | runtime business logic |

## Non-negotiable constraints

- Local filesystem only under `projects/super-proxy*`
- No `gh repo create`, no public visibility change, no push to GitHub
- No secrets in tree; no real tokens in tests
- No private markers: aside, oc-fleet, infinitycorp, Daxitdon, ampere project ids, release-process hosts
- Preserve behavior of public gateway routes where practical
- All commits signed if agent environment supports signing; otherwise normal commits and parent will re-sign on integrate
- Fresh git history only (already initialized in super-proxy)

## Definition of done (integration)

- `npm ci && npm run build && npm test` pass
- Docker health smoke passes
- Secret/internal-reference scan clean
- Docs enable clean-machine quickstart
- Parent reports to Don; still not public
