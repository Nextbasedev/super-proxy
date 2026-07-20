# Groq provider

Groq is a first-class gateway provider using OpenAI-compatible routes under `/v1/groq`.

## Routes

- `POST /v1/groq/chat/completions`
- `POST /v1/groq/embeddings`

Clients authenticate with the normal Nextbase proxy token:

```bash
curl -sS -i \
  -H "Authorization: Bearer nbmg_..." \
  -H "Content-Type: application/json" \
  -d '{"model":"openai/gpt-oss-120b","messages":[{"role":"user","content":"pong"}]}' \
  https://nextbase-model-gateway.infinitycorp.tech/v1/groq/chat/completions
```

## Routing behavior

- Provider accounts use `provider='groq'` in `provider_accounts`.
- Multiple Groq API keys are supported.
- Sticky routing key: `${user.email}:${token.label}:${conversationId || model || endpoint}`.
- Unknown models fall back to `openai/gpt-oss-120b` and responses include `x-gateway-groq-fallback: <requested-model>`.
- Known model allowlist is informational; fallback only applies to unknown requested models.
- Cost accounting is always `$0`; token caps still apply through the existing loose-limit/enforce-after-usage policy.

## Per-model limits

Limits are per account + model in `groq_limits`:

- `rpm` requests per UTC minute
- `rpd` requests per UTC day
- `tpm` tokens per UTC minute
- `tpd` tokens per UTC day

The proxy does preflight with `max(50, ceil(JSON.stringify(body).length / 4))` input-token estimate, then records actual usage from upstream `usage` when present.

On upstream `429`, the gateway respects `Retry-After`, writes `groq_model_cooldowns(account_id, model)`, and retries another eligible account before returning `429`.

## Admin UI/API

Admin endpoints:

- `GET /admin/groq`
- `PUT /admin/groq/:id/limits` with `{ model, rpm, rpd, tpm, tpd }`
- `DELETE /admin/groq/:id/limits/:model`
- `POST /admin/groq/:id/clear-cooldowns`

The console Provider Accounts page includes Groq accounts, live counters, `% of cap`, limit editing, and cooldown clearing.
