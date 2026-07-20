# Cerebras provider

Cerebras is a first-class gateway provider using OpenAI-compatible routes under `/v1/cerebras`.

## Routes

- `POST /v1/cerebras/chat/completions`
- `POST /v1/cerebras/embeddings`

Example:

```bash
curl -sS -i \
  -H "Authorization: Bearer sp_..." \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-oss-120b","messages":[{"role":"user","content":"pong"}]}' \
  http://localhost:8080/v1/cerebras/chat/completions
```

## Model fallback

- Provider accounts use `provider='cerebras'` in `provider_accounts`.
- Known models are `gpt-oss-120b` and `zai-glm-4.7`.
- Unknown models fall back to `gpt-oss-120b` and responses include `x-gateway-cerebras-fallback: <requested-model>`.
- Cerebras usage is recorded with `estimated_cost_usd = 0`.

## Rate limits and governor logic

Limits are per account + model in `cerebras_limits`:

- `rpm` — requests per UTC minute
- `rpd` — requests per UTC day
- `tpm` — tokens per UTC minute
- `tpd` — tokens per UTC day

Usage buckets are stored in `cerebras_usage_buckets` by UTC `window_minute` and `window_day`. Selection skips disabled/dead accounts, account-level cooldowns, active model cooldowns, and accounts whose configured buckets would be exceeded by the request estimate.

Routing is sticky by user + token + conversation key (`x-conversation-id`, `session_id`, `x-client-request-id`, `conversation_id`, or model) across currently eligible accounts. Successful requests update the usage buckets and account `last_used_at`.

## Upstream 429 handling

On upstream `429`, the gateway respects `Retry-After` (default 60s), writes `cerebras_model_cooldowns(account_id, model)`, records a zero-cost usage event for the failed attempt, and retries another eligible account before returning `429`.

## Admin API

- `GET /admin/cerebras`
- `PUT /admin/cerebras/:id/limits` with `{ model, rpm, rpd, tpm, tpd }`
- `DELETE /admin/cerebras/:id/limits/:model`
- `POST /admin/cerebras/:id/clear-cooldowns`

The console Provider Accounts page includes Cerebras accounts, live counters, `% of cap`, limit editing, and cooldown clearing.


## Current Cerebras upstream limits
- Models: `gpt-oss-120b` (Production, 65,536 context) and `zai-glm-4.7` (Preview, 64,000 context).
- Per-model account limits: 5 requests/minute, 150 requests/hour, 2,400 requests/day; 30,000 tokens/minute, 1,000,000 tokens/hour, 1,000,000 tokens/day.
