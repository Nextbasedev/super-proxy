# Per-user model access

Model access is controlled with per-user deny rows. The default is allowed: if no row exists, the user can request that provider/model.

## Schema

Migration `2026051801` creates `user_model_denies`:

```sql
CREATE TABLE IF NOT EXISTS user_model_denies (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  created_by_user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, provider, model)
);
```

A row means the exact model is blocked for that user. Empty table means no behavior change.

## Policy

`isModelAllowedForUser(user, provider, model)` runs before daily cap checks:

- missing/empty model: allowed, let upstream handle it
- exact deny row: blocked
- active exact per-model grant (`model_pattern === model`): allowed even if denied
- wildcard grants (`*`) do not override denies
- founders/admins do not bypass denies

Blocked requests return HTTP 400 with `model_not_allowed_for_user`.

## Admin endpoints

- `GET /admin/known-models` returns the editable model list grouped by provider.
- `GET /admin/users/:id/model-access` returns `{ deniedModels: [{ provider, model }] }`.
- `PUT /admin/users/:id/model-access` atomically replaces all denies for a user.

Known models live in `src/providers/known-models.ts`.
