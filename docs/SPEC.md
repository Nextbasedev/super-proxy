# Nextbase Model Gateway — Build Spec

Internal AI model gateway for Nextbase founders and team. Exposes Anthropic-compatible and OpenAI/Codex-compatible APIs while routing behind the scenes across multiple Anthropic Max/OAuth keys and Codex/OpenAI accounts.

## Core Decisions
- Name: Nextbase Model Gateway
- Repo/project: `model-gateway`
- Stack: Node.js + TypeScript
- Storage: SQLite on deployment server; dev data local only
- API exposure: public HTTPS eventually, every request requires personal proxy token
- Dashboard auth: Google/Firebase login + allowlist
- Providers V1: Anthropic + Codex/OpenAI
- API compatibility: Anthropic-compatible `/v1/messages`; OpenAI-compatible `/v1/responses` and optionally `/v1/chat/completions`
- Token model: one personal proxy token per user works across providers; multiple labeled tokens allowed
- Roles: `admin`, `founder`, `developer`, `member`; admin/founder can overlap
- Routing: requested model exactly; no aliases, no silent fallback in V1
- Anthropic routing: sticky by user/client/session when possible to preserve prompt cache; overflow only when assigned key unavailable
- Anthropic safety: Ampere-style governor; default max in-flight Anthropic requests = 10/key; configurable globally and per key
- Queue: no queue; return 503 immediately if all eligible backend keys/accounts busy/capped
- Retries: retry safe transient failures only with another healthy key/account; never retry after streaming starts
- Limits: founders have no personal usage limits; developers/members have provider-specific token/cost limits; loose enforcement mostly after response
- Logs: founders metadata only, never full request/response body. Non-founders may have full final request/response logging, default retention 1 month
- Admin dashboard: users/roles/tokens, provider accounts, health/concurrency, usage summaries, audit logs, alerts; no charts V1
- Admin audit: all admin changes with before/after diff
- Alerts: Discord + dashboard alerts
- Deployment: built on Daxit 4GB server, production deployment later on separate server; include export/import/deploy docs

## Phases
1. Foundation: Node/TS, SQLite migrations, users/tokens/provider accounts, dashboard skeleton.
2. Anthropic proxy: `/v1/messages`, streaming/non-streaming, auth, sticky routing, governor, health states.
3. Codex/OpenAI proxy: account pool, token refresh/cooldown, OpenAI-compatible endpoints.
4. Limits/logging/audit/alerts.
5. Ops: dry-run/test-as-user, quota polling, kill switches, import/export, deployment scripts.
6. Fusion: multi-model deliberation via `POST /v1/fusion/chat/completions`. Panel (parallel) → synthesizer architecture. Built-in presets (quality, budget), user custom presets (DB + CRUD API), inline config. Compare mode (side-by-side) and synthesize mode (final answer). Model discovery via `GET /v1/models`. Dashboard preset management and call history. See `docs/FUSION-ARCHITECTURE.md`.
