# Providers

Super Proxy fronts multiple upstream providers behind stable client APIs.

## Client surfaces

| Surface | Typical paths | Gateway auth header |
| --- | --- | --- |
| OpenAI-compatible | `/v1/chat/completions`, `/v1/responses`, and related routes | `Authorization: Bearer sp_...` |
| Anthropic-compatible | `/v1/messages` | `x-api-key: sp_...` |
| Provider-specific | `/v1/groq/...`, `/v1/xai/...`, and related routes | Gateway token as documented by the route |

Exact routes depend on the modules registered in `src/server.ts` and
`src/proxy/`.

## Configuration pattern

1. Start the gateway and bootstrap the dashboard.
2. Add an upstream provider account or credential through the dashboard/admin
   API. Do not place live credentials in tracked files.
3. Configure optional `*_UPSTREAM_URL` overrides only when required.
4. Issue a gateway API token to the calling user.
5. Verify a low-cost request with a model available to that user.

## Pools and concurrency controls

Modules under `src/providers/` implement account selection, concurrency, and
health-aware routing. A self-host deployment may use one upstream account or a
pool, subject to each provider's terms.

## Fusion

Fusion combines multiple model calls and a synthesizer. It is an advanced
feature; basic proxying does not require it. Operators are responsible for the
cost and data-handling implications of sending one prompt to multiple
providers.

## Adding a provider

1. Add the provider pool and proxy route module.
2. Register the route during server startup.
3. Add focused tests with Fastify injection and mocked upstream traffic.
4. Document environment variables in `.env.example` and this file.
5. Update the public model catalog and client documentation where applicable.
