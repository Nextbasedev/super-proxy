# Nextbase Model Gateway — limit-enforcement audit

**Repo:** `projects/model-gateway` @ branch `feat/time-bounded-grants` (base `main` `697a073`)
**Prod DB snapshot:** `/root/.openclaw/workspace/archive/prod-db/_*.csv` (copied from `65.21.109.171:/opt/services/model-gateway/data/model-gateway.sqlite`, read-only).
**Date:** 2026-05-15

---

## 1. Where limits are checked

The two enforcement helpers live in `src/proxy/policy.ts`:

- **`checkLooseLimit(user, provider, token?)`** — called *before* the upstream request. Returns `{ok:false, message}` to block with HTTP 429, else `{ok:true}`. Token caps apply to everyone (incl. admin/founder); user/role caps skip for `admin`/`founder` via `isFounder(role)`.
- **`enforceAfterUsage(user, provider, token?)`** — called *after* a successful response is fully consumed and the usage event is recorded. It re-runs `checkLooseLimit`; if the new cumulative spend has crossed the cap, it raises a `user_limit_exceeded` alert. **It does not block, disable, or remediate** — only the *next* request from that user (or token) will be rejected by the entry-side `checkLooseLimit`.

### Per-proxy call order

All five proxies follow the same envelope:

| Proxy file | Entry check (`provider` arg) | After-success hook | Notes |
|------------|------------------------------|--------------------|-------|
| `src/proxy/anthropic.ts` (POST `/v1/messages`) | `checkLooseLimit('anthropic')` line 56 | `enforceAfterUsage('anthropic')` after stream end (170) and after non-stream JSON (185) | Error paths (`upstream.status>=400`, network exception) record a usage event but **skip** `enforceAfterUsage`. |
| `src/proxy/openai.ts` (POST `/v1/responses`, `/v1/chat/completions`) | `checkLooseLimit('openai_codex')` line 62 | `enforceAfterUsage(account.provider)` after stream (213) and non-stream (235). | Entry check is always against `'openai_codex'`, but the post-check uses `account.provider`, which may be `'openai'` for API-key fallback. **Asymmetry.** |
| `src/proxy/openai.ts` (POST `/v1/images/*`) | `checkLooseLimit('openai')` line 285 | `enforceAfterUsage('openai')` (336) for API-key path, `enforceAfterUsage('openai_codex')` (462) for the Codex fallback path | **Asymmetry**: entry blocks on `'openai'` cap only; if the request falls through to the Codex backend (no OpenAI API key configured), spend is billed against `'openai_codex'` and the entry cap never gets a chance to deny. |
| `src/proxy/groq.ts` (POST `/v1/groq/{chat,embeddings,audio/*}`) | `checkLooseLimit('groq')` lines 73 & 188 | `enforceAfterUsage('groq')` after stream (140), non-stream (149), audio (227) | Audio routes use `recordUsage(..., inputTokens:0, outputTokens:0, estimatedCostUsd:0)` — caps measured in USD or tokens never fire on Whisper traffic. |
| `src/proxy/cerebras.ts` (POST `/v1/cerebras/{chat,embeddings}`) | `checkLooseLimit('cerebras')` line 70 | `enforceAfterUsage('cerebras')` (133, 142) | `estimateCost(...,'cerebras')` returns `0` for all current models, so USD caps cannot fire. |
| `src/proxy/kimi.ts` (POST `/v1/kimi/{chat,messages}`) | `checkLooseLimit('kimi')` line 105 | `enforceAfterUsage('kimi')` (177, 184) | `estimateCost(...,'kimi')` also returns `0`. |

Common pattern: error responses (4xx/5xx) bypass `enforceAfterUsage`; only the **next** request from the same caller will be blocked once cumulative usage from successful events crosses the cap.

---

## 2. The limit ladder (`policy.ts:checkLooseLimit`)

Precedence is encoded in two SQL statements:

### Token cap (always applied — incl. admin/founder)
```sql
SELECT cap_usd_daily, cap_tokens_daily
FROM api_tokens WHERE id = :tokenId
-- if either is set, sum usage_events for this token+provider over -1 day
SELECT SUM(estimated_cost_usd), SUM(input_tokens+output_tokens+cache_creation_tokens+cache_read_tokens)
FROM usage_events
WHERE token_id = :tokenId AND provider = :provider AND created_at >= datetime('now','-1 day')
```
- If `cap_usd_daily IS NULL AND cap_tokens_daily IS NULL` → check is skipped.
- Comparison is `>=`, so the request that *causes* the overshoot may still succeed and the *next* one is blocked.

### Role/user cap (skipped for `admin`/`founder` via `isFounder()`)
```sql
SELECT COALESCE(ul.daily_usd, rl.daily_usd) daily_usd,
       COALESCE(ul.daily_tokens, rl.daily_tokens) daily_tokens
FROM users u
LEFT JOIN user_limits ul ON ul.user_id = u.id AND ul.provider = :provider
LEFT JOIN role_limits rl ON rl.role = u.role AND rl.provider = :provider
WHERE u.id = :userId
```

The ladder is therefore:

1. **Token cap** (`api_tokens.cap_usd_daily`, `cap_tokens_daily`) — applies to everyone.
2. **User cap** (`user_limits` row for `(user_id, provider)`).
3. **Role cap** (`role_limits` row for `(user.role, provider)`), used only if no user override.
4. **Role default** = absence of any of the above ⇒ no cap (request allowed).
5. **Admin/founder bypass** for user+role caps (token cap still applies).

There is no per-model or per-model-pattern field anywhere in the ladder.

---

## 3. Per-provider gaps

| Provider | Before-request check | After-usage check | Streaming post-check | USD cap fires? | Token cap fires? | Notes |
|----------|---------------------|-------------------|----------------------|----------------|------------------|-------|
| anthropic | ✅ `'anthropic'` | ✅ `'anthropic'` | ✅ (assembled) | ✅ if non-null | ✅ if non-null | Cleanest path. Cost from `estimateCost(... ,'anthropic')` is real. |
| openai_codex (chat/responses) | ✅ `'openai_codex'` | ✅ `account.provider` | ✅ | Mostly ✅ for Codex; **mismatch** if account is API-key `'openai'` — entry checked `'openai_codex'`, after-hook checks `'openai'`. | Same | Cost from `estimateCost(... ,'openai_codex')` is non-zero for `gpt-5.x`. |
| openai (image-gen) | ✅ `'openai'` | ✅ `'openai'` (API-key) OR `'openai_codex'` (Codex fallback) | n/a (no SSE writeback) | API-key: ✅. Codex fallback: ❌ at entry, ✅ at after-hook against `'openai_codex'` instead. | Same | If only Codex accounts are configured, `'openai'` cap is unreachable; `'openai_codex'` cap is checked after the fact only. |
| groq (chat/embeddings) | ✅ `'groq'` | ✅ `'groq'` | ✅ | USD never fires — `estimateCost(... ,'groq')` returns 0 today. | ✅ if non-null | Only token cap is meaningful. |
| groq (audio) | ✅ `'groq'` | ✅ `'groq'` | n/a | ❌ — recordUsage forces inputTokens=0, outputTokens=0, cost=0; caps stay at 0/0. | ❌ — same reason. | Whisper is effectively uncapped. |
| cerebras | ✅ `'cerebras'` | ✅ `'cerebras'` | ✅ | ❌ — cost=0 in `estimateCost(... ,'cerebras')`. | ✅ if non-null | Same shape as groq. |
| kimi | ✅ `'kimi'` | ✅ `'kimi'` | ✅ | ❌ — cost=0. | ✅ if non-null | Same shape. |

**Streaming.** All five providers call `enforceAfterUsage` *after* the SSE stream finishes (the `reply.raw.end()` line). The only way the post-usage hook is skipped is when the upstream returns 4xx/5xx or the connection errors — in which case there's no successful usage to enforce anyway. So streaming itself is not a gap; **the gap is that 4xx paths never trip an alert even when an attacker generates many failed-but-cost-incurring calls** (e.g., Anthropic still bills for input tokens on some 4xx codes).

---

## 4. Per-model gaps

**Confirmed:** caps live on `(provider, …)`. `role_limits`/`user_limits`/`api_tokens` all key off `provider` only. `usage_events.model` is recorded, but no enforcement query filters by it.

Concretely:

```sql
-- user_limits / role_limits schema
UNIQUE(user_id, provider)
UNIQUE(role, provider)

-- api_tokens has no model column
```

So a developer who is "allowed to use Anthropic but only `claude-haiku`" cannot be expressed in the current schema. They get an Anthropic-level allowlist and can call `claude-opus-4-7` (currently the most expensive Anthropic model at ~$15/M input + $75/M output) freely. The prod data confirms this is happening in practice: Daxit's `Daxit Openclaw` token burned **$1,270.12/day** on `claude-opus-4-7` because there's no model-level guard.

This is the core motivation for the time-bounded grants feature: a per-`(user, provider, model)` policy row with an explicit `valid_until`.

---

## 5. Live evidence from prod (24h window)

Source: `archive/prod-db/_*.csv` (CSV dump pulled at 2026-05-15 10:10 UTC via SSH; original DB never modified).

### Aggregate cap inventory (prod)
```
role_limits         : 0 rows
user_limits         : 0 rows
api_tokens w/ USD   : 0
api_tokens w/ token : 0
api_tokens enabled  : 12
users               : 9
```
**There are zero caps configured anywhere in production today.** That means `checkLooseLimit` always returns `{ok:true}` for every user, on every provider, on every model. The "enforcement" code path runs, but it has nothing to enforce against.

### 3 representative users + 24h usage

| # | User | Role | Token | Effective cap | 24h spend | Status |
|---|------|------|-------|---------------|-----------|--------|
| 1 | `daxitm2112@gmail.com` | admin | `Daxit Openclaw` (`nbmg_GYFLrhye3`, id 8) | none (no token/user/role cap, also admin bypass) | **$1,270.12 anthropic + $174.02 codex + $0 groq/cerebras** | Unconstrained by design (admin) but also unconstrained by token-level cap. |
| 2 | `dixit@infinitycorp.tech` | developer | `personal` (`nbmg_JyzZvUuyn`, id 13) | none | **$699.24 codex (gpt-5.5, 1,857 reqs) + $3.56 anthropic + $0.12 codex mini + Kimi 10.85M tokens** | Developer with no cap. If a `role_limits` row had said `daily_usd=100` they would have been blocked at request ~120 of the day. |
| 3 | `khenidarshitz@gmail.com` | admin | `dk` (`nbmg_rVXv9R4MZ`, id 18) | none | **$298.07 anthropic (claude-opus-4-6) + $5.38 codex** | Admin, so even if caps existed they'd bypass; only a token cap could rein in this account. |

**Proof of broken/missing enforcement:** every user in the table above exceeded any "reasonable" daily budget (e.g., $50/day) without ever tripping `checkLooseLimit`, because the cap fields were `NULL`. SQL `COALESCE(ul.daily_usd, rl.daily_usd)` returned `NULL`, the `if (!limit?.daily_usd && !limit?.daily_tokens) return {ok:true};` short-circuit fired, and the request went through.

### Same query on prod for completeness
```sh
sqlite3 -readonly /opt/services/model-gateway/data/model-gateway.sqlite \
  "SELECT u.email, e.provider, ul.daily_usd, ul.daily_tokens, rl.daily_usd, rl.daily_tokens
   FROM users u LEFT JOIN user_limits ul ON ul.user_id=u.id
   LEFT JOIN role_limits rl ON rl.role=u.role
   WHERE u.email IN ('daxitm2112@gmail.com','dixit@infinitycorp.tech','khenidarshitz@gmail.com');"
# → returns no rows from ul or rl (both empty tables).
```

---

## 6. Why enforcement can silently fail

| # | Failure mode | Where | Evidence/risk |
|---|--------------|-------|---------------|
| F1 | **All caps NULL ⇒ no enforcement at all.** | `policy.ts:62`: `if (!limit?.daily_usd && !limit?.daily_tokens) return {ok:true};` | Prod has zero rows in `user_limits`/`role_limits` and zero `api_tokens` with caps. Currently this is the live state of the system. |
| F2 | **Admin/founder bypass.** | `policy.ts:33`: `if (isFounder(user.role)) return {ok:true};` | Three of nine prod users (`role IN ('admin','founder')`) bypass non-token caps unconditionally. Two of them are top spenders ($1.27k + $298 in 24h). Token-level caps are the only lever for them, and none are set. |
| F3 | **Per-provider key mismatch in OpenAI image path.** | `proxy/openai.ts:285` checks `'openai'`, falls back to `forwardOpenAiImageViaCodex` which records usage as `'openai_codex'` and post-checks `'openai_codex'`. | If you set `user_limits(user, 'openai', daily_usd=10)` to cap image gen, the entry blocks. But if image gen falls back to Codex (no API-key account), spend bills against `'openai_codex'` and the `'openai'` cap was rechecked against the wrong provider after-the-fact. |
| F4 | **Per-provider key mismatch in chat/responses.** | `proxy/openai.ts:62` entry uses `'openai_codex'`; `proxy/openai.ts:213/235` post-check uses `account.provider`. | If a request lands on an `'openai'` API-key account (mixed pool), entry checked the wrong key. Today the pool is Codex-only so this is dormant, but the moment an API-key OpenAI account is added the cap key disagrees. |
| F5 | **Groq audio + Cerebras + Kimi USD caps are unreachable.** | `proxy/cost.ts:estimateCost` returns 0 for those provider strings; `proxy/groq.ts` audio routes hardcode `estimatedCostUsd: 0`. | A `daily_usd` cap on those providers never fires. Only `daily_tokens` works (and only for non-audio Groq). |
| F6 | **Race condition: `>=` after the fact.** | `policy.ts:65` uses `usage.usd >= cap`. The request that pushes you over is allowed; the *next* one is blocked. With 1500 streaming requests/day, the overshoot can be the cost of one full Opus session. | Acceptable trade-off but worth documenting. |
| F7 | **No per-model cap.** | Schema, not code. `user_limits`/`role_limits`/`api_tokens` all key off `provider` only. | Cannot say "Haiku only" — the motivation for the grants feature. |
| F8 | **`enforceAfterUsage` only alerts; it does not disable the token or refund the call.** | `policy.ts:113-117`. | The first time a user crosses the cap, the call still completes, an alert is filed, and only the *next* call is blocked. If the alert handler is unmonitored or the user goes idle for 24h, the cap "resets" on the rolling window. |
| F9 | **`SUM` over zero rows returns `NULL` in some SQLite drivers; we use `COALESCE(SUM(...),0)` everywhere — verified OK.** | `policy.ts:43, 60`. | Not a bug today, but a future contributor stripping the COALESCE would silently disable enforcement. Flag for code review. |
| F10 | **Integer vs float on `daily_tokens`.** | `daily_tokens INTEGER` in DDL, but JS compares as Number. | Not a real bug today. |

---

## Findings (with severity)

| ID | Severity | Finding | Recommended fix |
|----|----------|---------|-----------------|
| F1 | **BLOCKER** | Prod has zero caps configured. Every user is effectively unlimited on every provider. | Seed sane `role_limits` defaults (`developer`: $25/day Anthropic, $25/day Codex, etc.) AND ship the time-bounded grants feature to allow case-by-case override. Add an admin dashboard warning when `role_limits` for `developer`/`member` is empty. |
| F7 | **HIGH** | No per-model cap. `claude-haiku`-only access can't be expressed. | Ship `user_grants` (this PR). Long-term, add `role_limits.model_pattern` too. |
| F3 | **HIGH** | Image-gen falls through to Codex but the entry cap is keyed on `'openai'`. Spend bills to `'openai_codex'` instead. | When OpenAI API-key accounts are absent, image generation should `checkLooseLimit('openai_codex')` at entry. Easy fix in `forwardOpenAiImageViaCodex`. |
| F4 | **HIGH** | Chat/responses entry check is `'openai_codex'` but `account.provider` may be `'openai'` in mixed pools. | Resolve the effective provider key *before* `checkLooseLimit`. Or check both: `checkLooseLimit(user, 'openai_codex') && checkLooseLimit(user, 'openai')`. |
| F5 | **MED** | USD caps unreachable for Groq audio, Cerebras, Kimi (cost=0 today). | Wire real pricing into `proxy/cost.ts` for these providers, or document explicitly that only token caps apply. |
| F8 | **MED** | Post-usage hook only alerts; doesn't auto-revoke or 429 the in-flight stream. | Add an automatic token disable (or set `enabled=0`) when the cap is exceeded by >X%. Optional. |
| F2 | **LOW (by design)** | admin/founder bypass means `daxitm2112` and `sanketkheni` are uncapped even if role_limits exist. | Document in UI. Token-level caps can still constrain them if desired. Grants feature does NOT change this (founder/admin bypass is preserved). |
| F6 | **LOW** | Overshoot allowed on the request that crosses the threshold. | Pre-debit: estimate worst-case cost before the call. Out of scope for this PR. |
| F9 | **LOW** | `COALESCE(SUM(...),0)` is the only thing keeping NULL out of comparisons. Easy to regress. | Add a unit test that exercises the empty-usage_events case. (Covered by new grants.test.ts.) |
| F10 | **LOW** | None. | n/a |

---


## Final summary — `feat/time-bounded-grants`

### Findings re-list (severity)

| ID | Severity | Status |
|----|----------|--------|
| F1 | BLOCKER  | **Mitigated** by grants (operator can now set per-user/per-model overrides). Underlying gap remains: prod `role_limits` is empty and the recommendation to seed sane developer/member defaults is a follow-up. |
| F7 | HIGH     | **Resolved** — `user_grants.model_pattern` plus model-aware `checkLooseLimit` provides per-model enforcement on a temporary basis. Long-term, extend `role_limits`/`user_limits` with `model_pattern` too. |
| F3 | HIGH     | **Not addressed** in this branch (out of scope). Recommend a follow-up PR. |
| F4 | HIGH     | **Not addressed** (dormant; flag for review when OpenAI API-key accounts are added to the pool). |
| F5 | MED      | **Not addressed** (still cost=0 for groq audio, cerebras, kimi). |
| F8 | MED      | **Not addressed** (post-usage hook still only alerts). |
| F2 | LOW      | Documented in `docs/grants.md`; intentional. |
| F6 | LOW      | Documented. |
| F9 | LOW      | Covered by new tests (empty `usage_events` exercised via `findActiveGrant` + `checkLooseLimit`). |

### Commits added (local `feat/time-bounded-grants`)
```
5b1264e docs: limit-enforcement audit (2026-05-15) — see /workspace/reports/nextbase-limits-audit.md
215a20c feat(grants): add user_grants migration + policy override
7d5f7e3 feat(grants): admin REST API + tests
edf3ebb feat(grants): admin console UI — Grants tab + Identity-row badge
2da827d docs(grants): ROUTING-CONFIG section + docs/grants.md
```

### Files changed
```
docs/ROUTING-CONFIG.md  |  +18
docs/grants.md          | +192   (new)
docs/limits-audit.md    | +177   (new — copy of this report)
public/console.css      |  +12
public/console.js       | +162
src/admin/admin-api.ts  | +109
src/db/migrate.ts       |  +23
src/grants.test.ts      | +246   (new, 8 tests)
src/proxy/anthropic.ts  |  +6 -6
src/proxy/cerebras.ts   |  +7 -7
src/proxy/groq.ts       | +13 -13
src/proxy/kimi.ts       |  +7 -7
src/proxy/openai.ts     | +11 -11
src/proxy/policy.ts     | +66 -5
```
Build: `npm run build` clean. Tests: `npm test` → 28/28 (20 pre-existing + 8 new).

### Deploy plan

1. **Review** the branch locally:
   ```bash
   cd projects/model-gateway
   git checkout feat/time-bounded-grants
   npm run build && npm test
   git log --oneline main..HEAD
   git diff main..HEAD
   ```
2. **Merge** locally once Don approves:
   ```bash
   git checkout main
   git merge --ff-only feat/time-bounded-grants
   ```
3. **Push to origin** (production auto-deploys from `main` per TOOLS.md rule):
   ```bash
   git push origin main
   ```
   *Do not* push the branch before merging — production auto-deploys.
4. **Verify migration** ran on the box: SSH to `65.21.109.171`, watch the
   service logs, then:
   ```bash
   sqlite3 -readonly /opt/services/model-gateway/data/model-gateway.sqlite \
     "SELECT version FROM schema_migrations WHERE version = 2026051502;"
   sqlite3 -readonly /opt/services/model-gateway/data/model-gateway.sqlite \
     ".schema user_grants"
   ```
5. **Smoke test** the new endpoints with the dev admin key (production sets a
   real `SESSION_SECRET`; from the console you can use a logged-in admin
   cookie):
   ```bash
   curl https://nextbase-model-gateway.infinitycorp.tech/admin/grants \
     -H "x-admin-key: $ADMIN_KEY"
   ```
6. **First real grant**: create one through the UI (Identity → user → Grants
   tab) for a developer who needs Anthropic Opus access for a fixed window.
   Watch the audit log row appear in `/admin/audit-logs`.
7. **Follow-up tickets** (out of scope here, recommended next):
   - Seed `role_limits` defaults (`developer`: \$25/day on `anthropic` and
     `openai_codex`; `member`: \$5/day) — F1.
   - Fix `forwardOpenAiImageViaCodex` to cap on `openai_codex` when no
     OpenAI API-key account is configured — F3.
   - Make chat/responses entry check key off `account.provider` instead of
     hardcoding `openai_codex` — F4.
   - Wire real pricing for groq/cerebras/kimi in `proxy/cost.ts` — F5.
