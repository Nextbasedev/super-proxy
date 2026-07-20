# Kimi provider integration

Kimi is a first-class subscription-style provider in Super Proxy.

## Routes

- OpenAI-compatible: `POST /v1/kimi/chat/completions`
- Anthropic-compatible: `POST /v1/kimi/messages`

Both require `Authorization: Bearer <sp_*>` at the gateway. The gateway forwards to `KIMI_UPSTREAM_URL` or `https://api.kimi.com/coding/v1` by default with the selected account secret as `Authorization: Bearer sk-kimi-...`.

For `/v1/kimi/messages`, the gateway forwards the client `anthropic-version` header when present and defaults to `2023-06-01` otherwise.

## Models

Known model allowlist is informational:

- `k3` (Kimi K3; exact upstream ID, not `kimi-k3`)
- `kimi-k2.7-code-highspeed` (high-speed K2.7 Code)
- `kimi-k2.7-code`
- `kimi-k2.6` (default)
- `kimi-for-coding`

Unknown requested model names are rewritten to `kimi-k2.6` and the response includes:

```http
x-gateway-kimi-fallback: <requested-model>
```

K3 uses the same OpenAI-compatible and Anthropic-compatible Kimi Code routes.
Kimi documents K3 context entitlement as plan-dependent: Moderato supports 256k,
while Allegretto and above support up to 1M. This production deployment uses an
Allegretto Kimi Code membership, so K3 is entitled to the full 1M context. On the
OpenAI-compatible route,
K3 defaults `reasoning_effort` to `max`; `ultra` and `xhigh` normalize to
`max`, and `none` disables thinking. The gateway preserves `reasoning_content`
on assistant tool-call history, which Kimi requires for follow-up tool turns.

## Routing and capacity

Kimi uses sticky account routing with no RPM/RPD/TPM/TPD buckets:

```text
${auth.user.email}:${auth.token.label}:${conversationId || model || endpoint}
```

`conversationId` is read from `x-conversation-id`, `session_id`, `x-client-request-id`, or `body.conversation_id`.

Per-account in-flight concurrency is enforced in memory. `max_in_flight` defaults to `10` for Kimi provider accounts when unset. Accounts at their in-flight cap are skipped; if all accounts are full or cooling down, the gateway returns `429` with `Retry-After`.

## 429 cooldown

Kimi has no published fixed quota buckets. On upstream `429`, the gateway:

1. Reads `Retry-After` (seconds or HTTP date), defaulting to 60 seconds.
2. Sets `provider_accounts.cooldown_until` and `status='cooldown'` for that account.
3. Logs a `provider_health_events` row.
4. Retries the next eligible Kimi account.

Successful requests clear stale cooldown state and update `last_used_at`.

## Usage and cost

`usage_events.provider = 'kimi'` is recorded for successful and failed attempts. Token counts are parsed from JSON `usage` blocks or SSE events (`usage`, `response.usage`, or Anthropic `message_start.message.usage`). Estimated cost is always `0` because Kimi is treated as subscription-style.

Per-token caps still apply through the existing `checkLooseLimit` and `enforceAfterUsage` policy checks.

## Admin endpoints

- `GET /admin/kimi` — list Kimi accounts with masked key, status, cooldown, in-flight `n/max`, and last-24h request/token totals.
- `POST /admin/kimi/:id/clear-cooldowns` — clears persisted cooldown and sets the account active.
- `POST /admin/provider-accounts` accepts `provider='kimi'` and defaults `max_in_flight` to 10.
- `POST /admin/provider-accounts/:id/quota` probes `GET https://api.kimi.com/coding/v1/models` (or `KIMI_UPSTREAM_URL/models`) with the account bearer token.

## Deployment

Migration `2026051301` rebuilds `provider_accounts` to add `kimi` to the provider CHECK constraint while preserving rows. No new tables are introduced.
