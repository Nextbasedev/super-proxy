# Time-bounded grants

A **user grant** is a temporary policy override that lets one user reach a
specific `(provider, model_pattern)` for a bounded time window. It sits *above*
the existing `role_limits` / `user_limits` ladder.

Use it for things like:

- "Grant `dixit@infinitycorp.tech` Anthropic Opus access for the next 7 days,
  capped at $50/day."
- "Let `vishva@infinitycorp.tech` use Groq Whisper for a 24h audio test."
- "Give a contractor a single-model grant for `claude-haiku-4` for 30 days,
  unlimited."

Grants are revocable, audited, and expire automatically.

---

## Data model

Migration `2026051502`:

```sql
CREATE TABLE user_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,                -- 'anthropic' | 'openai_codex' | 'openai' | 'groq' | 'cerebras' | 'kimi'
  model_pattern TEXT,                    -- exact model id, or '*' / NULL for "any model on this provider"
  daily_usd REAL,                        -- if NULL, USD is unlimited under this grant
  daily_tokens INTEGER,                  -- if NULL, tokens are unlimited under this grant
  valid_from INTEGER NOT NULL,           -- epoch ms; 0/now = effective immediately
  valid_until INTEGER NOT NULL,          -- epoch ms; must be in the future at create time
  reason TEXT,
  created_by_user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_user_grants_active
  ON user_grants(user_id, provider, valid_until);
```

---

## Policy semantics

`src/proxy/policy.ts` evaluates limits in this order, top wins:

1. **Token cap** (`api_tokens.cap_usd_daily`, `cap_tokens_daily`) — explicit
   per-token guardrail. Applies to *everyone*, including admin/founder, and
   *including* users with a generous grant.
2. **Active grant** for `(user_id, provider, model)`:
   - "Active" = `valid_from <= now() <= valid_until`.
   - Exact `model_pattern` matches beat wildcard (`*` or NULL) matches.
   - If both `daily_usd` and `daily_tokens` are NULL the grant is "unlimited"
     for this `(provider, model)`.
   - Otherwise the grant's caps are compared to the user's `usage_events`
     over the rolling 24h window, just like the user/role caps.
3. **Founder/admin bypass** for the user/role ladder.
4. **User cap** (`user_limits.daily_usd|daily_tokens`).
5. **Role cap** (`role_limits.daily_usd|daily_tokens`).
6. **No row anywhere** ⇒ unlimited (current production default — flagged as a
   BLOCKER in the audit).

The same logic runs both *before* the request (`checkLooseLimit`) and *after*
a successful upstream call (`enforceAfterUsage`).

---

## Admin REST API

All endpoints require admin (either Firebase session with `is_admin=1` or the
`x-admin-key` dev header). All writes go through `audit()`.

### `GET /admin/grants`
Query: `userId?`, `activeOnly?` (boolean).
Response:
```json
{ "grants": [
  {
    "id": 12,
    "user_id": 5,
    "email": "dixit@infinitycorp.tech",
    "provider": "anthropic",
    "model_pattern": "claude-opus-4-7",
    "daily_usd": 50,
    "daily_tokens": null,
    "valid_from": 1715683200000,
    "valid_until": 1716288000000,
    "reason": "release week",
    "created_by_user_id": 1,
    "created_by_email": "daxitm2112@gmail.com",
    "created_at": "2026-05-14 06:00:00",
    "active": true,
    "status": "active",
    "expires_in_ms": 432123456,
    "starts_in_ms": 0
  }
] }
```

### `POST /admin/grants`
Body:
```json
{
  "userId": 5,
  "provider": "anthropic",
  "modelPattern": "claude-opus-4-7",
  "dailyUsd": 50,
  "dailyTokens": null,
  "validFrom": null,
  "validUntil": 1716288000000,
  "reason": "release week"
}
```
Validation:
- `provider` ∈ {`anthropic`,`openai_codex`,`openai`,`groq`,`cerebras`,`kimi`}.
- `validUntil > now()`.
- `validUntil - (validFrom || now()) <= 30 days`.
- `modelPattern` defaults to `*`.

### `PATCH /admin/grants/:id`
Body: any subset of `{ dailyUsd, dailyTokens, validUntil, reason }`.
Same validation rules apply for `validUntil`.

### `DELETE /admin/grants/:id`
Immediately revokes (hard-deletes) the grant.

---

## Admin UI

Identity → click a user → **Grants** tab.

- Top of the tab: an "Add grant" form (provider select, model text field
  defaulting to `*`, optional `$/d` and `tok/d`, duration quick-picks
  `1h/4h/24h/7d/30d` + custom `<datetime-local>` input, reason).
- Below: a table of this user's grants with revoke button per row.
- The Identity row shows a small badge `"N grant(s)"` whenever the user has
  one or more *active* grants.

---

## Worked examples

### Unlimited Anthropic for 24h
```bash
curl -X POST https://.../admin/grants \
  -H "x-admin-key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": 5,
    "provider": "anthropic",
    "modelPattern": "*",
    "validUntil": '"$(($(date +%s%3N) + 86400000))"',
    "reason": "incident response"
  }'
```

### Haiku-only for 7 days, capped at $20/day
```bash
curl -X POST https://.../admin/grants \
  -H "x-admin-key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": 6,
    "provider": "anthropic",
    "modelPattern": "claude-haiku-4",
    "dailyUsd": 20,
    "validUntil": '"$(($(date +%s%3N) + 7*86400000))"',
    "reason": "trial period"
  }'
```

### Revoke immediately
```bash
curl -X DELETE https://.../admin/grants/12 -H "x-admin-key: $ADMIN_KEY"
```

---

## Operational notes

- Expired grants are kept in the DB for audit, but `findActiveGrant()`
  ignores them. Periodically prune with
  `DELETE FROM user_grants WHERE valid_until < strftime('%s','now','-90 day')*1000;`
  if disk is a concern.
- Grants are **per-user**, not per-token. Every token a user owns inherits
  their grants. Use token-level `cap_usd_daily` for finer-grained control.
- Founders/admins technically *can* have a grant attached, but since they
  already bypass user/role caps the grant only matters if it *tightens* the
  cap below their (otherwise unlimited) usage. Practically: don't bother.
- The 30-day max is a soft sanity ceiling. If you need longer, set up a
  proper `user_limits` row instead of stacking grants.

## Interaction with per-user model access

Per-user model denies (`user_model_denies`) are evaluated before usage caps. An active exact per-model grant (`model_pattern` equal to the requested model id) overrides a deny for that user during the grant window. Wildcard grants (`*` or NULL) do **not** override model denies.
