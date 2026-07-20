# Providers

Super Proxy fronts multiple upstream providers behind stable client APIs.

## Client surfaces

| Surface | Typical paths | Auth header |
|---|---|---|
| OpenAI-compatible | `/v1/chat/completions`, `/v1/responses`, … | `Authorization: Bearer <token>` |
| Anthropic-compatible | `/v1/messages` | `x-api-key: <token>` |
| Provider-specific | `/v1/groq/...`, `/v1/xai/...`, etc. | gateway token |

Exact routes depend on build/register path in `src/server.ts` / `src/proxy/*`.

## Configuration pattern

1. Configure upstream base URLs via env (`*_UPSTREAM_URL`) when you need overrides.  
2. Add provider credentials through admin/secure config — not plaintext git files.  
3. Map gateway models to upstream models via your model catalog / access rules.  

## Pools & governor

`src/providers/*-pool.ts` and `governor.ts` implement account selection, concurrency, and health-aware routing. Self-host deployments can run with a single upstream key or multiple pooled accounts.

## Fusion

Fusion (multi-model panel + synthesizer) lives under `src/fusion/*` and `/v1` fusion routes when enabled. Treat it as an advanced feature; basic proxying does not require it.

## Adding a provider (contributors)

1. Add pool + proxy route module.  
2. Register in server bootstrap.  
3. Add focused tests with Fastify inject.  
4. Document env vars in `.env.example` and this file.  
