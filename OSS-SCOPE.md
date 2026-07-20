# Super Proxy project scope

Super Proxy is an open-source, self-hosted AI gateway. It provides one
operator-managed service for routing authenticated client requests to multiple
model providers.

## Included

- OpenAI-compatible and Anthropic-compatible HTTP APIs
- Streaming and non-streaming request paths
- Provider adapters, account pools, and concurrency controls
- Gateway API tokens with policy and usage identity
- SQLite persistence and migrations
- Usage, cost, health, metrics, and basic policy surfaces
- Model discovery endpoints
- Built-in operator dashboard
- Docker and Docker Compose deployment
- Small extension contracts for authentication, providers, secrets, and plugins

## Not included

The public project does not include organization-specific infrastructure,
host inventories, deployment credentials, proprietary control planes, or
private operational runbooks. Integrations that require those systems belong
in separate deployments or plugins and must not be prerequisites for the
self-hosted gateway.

Super Proxy is not a hosted service and does not provide provider accounts or
model-provider credentials. Operators remain responsible for upstream terms,
network access, data handling, backups, and deployment security.

## Architecture principles

The project favors a single TypeScript service with explicit Fastify routes,
provider modules, and SQLite persistence. Public extension points are kept
small and implementation-driven:

- `GatewayPlugin`
- `ProviderAdapter`
- `AuthProvider`
- `SecretStore`

New abstractions should solve a demonstrated integration need. Public gateway
routes should remain backward-compatible where practical; pre-1.0 interfaces
may still evolve with release notes and migration guidance.

## Contribution boundary

Contributions must not include live credentials, private customer data,
internal hostnames, employee-only identifiers, or copied proprietary source
history. See [`CONTRIBUTING.md`](./CONTRIBUTING.md),
[`SECURITY.md`](./SECURITY.md), and [`LICENSE`](./LICENSE).
