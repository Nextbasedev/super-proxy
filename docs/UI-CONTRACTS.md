# UI ↔ JS Contract  (preserved by `redesign/ui-v2`)

This file captures every public-facing dependency between `public/index.html`
and `public/console.js`, plus every backend endpoint the console talks to.
The redesign **must not break** anything in this list.

---

## DOM IDs read or written by `console.js`

### Login shell
- `#login` — the auth section root (toggled with `.hidden`)
- `#signInBtn` — Google sign-in button
- `#devAdminKey` — fallback dev-admin-key input on the login screen
- `#loginError` — error banner shown on auth failure

### App shell
- `#app` — app root (toggled with `.hidden`)
- `#sidebar` — sidebar element (mobile: `.open` toggles slide-in)
- `#sidebarBackdrop` — backdrop for mobile sidebar
- `#navList` — `<nav>`. **Children rendered by JS** (was static HTML in v1).
  Each child has `data-view="<route>"` and the active one gets `.active` +
  `aria-current="page"`.
- `#viewTitle`, `#viewSubtitle` — topbar text, set per-route.
- `#globalSearch` — current-view filter input.
- `#refreshBtn` — refresh trigger; spins via `.spinning`.
- `#navToggle` — hamburger (mobile only).
- `#userEmail`, `#userRole`, `#userAvatar`, `#envLabel` — user/env metadata.
- `#signOutBtn` — sign-out trigger.
- `#view` — main render target (focusable for a11y).
- `#settingsMenu` — wrapper for the cog button + popover.
- `#settingsToggle` — cog button.
- `#settingsPanel` — popover content. **Rendered by JS** so it can host the
  preserved `#adminKeyInline` field plus admin-only actions.
- `#adminKeyInline` — preserved id; now lives inside `#settingsPanel`. Read
  by `adminKey()`.

### Overlay hosts
- `#drawerHost`, `#toastHost`, `#confirmHost`

### Legacy IDs intentionally retained
- `#adminKeyInline` (now inside the cog menu)
- `.nav-glyph` CSS class (left as alias next to `.nav-icon`)
- `.hidden` utility

---

## Hash routes

| Route        | Role  | Purpose                                | Legacy alias resolved transparently |
| ------------ | ----- | -------------------------------------- | ----------------------------------- |
| `#health`    | admin | KPIs + provider accounts + incidents   | `#overview`, `#accounts`, `#alerts` |
| `#identity`  | admin | Users + role/user limits               | `#users`, `#limits`                 |
| `#usage`     | admin | Usage breakdown + KPIs                 | `#usage` (kept)                     |
| `#audit`     | admin | Audit log + resolved alerts            | `#audit` (kept)                     |
| `#home`      | dev   | Dev personal dashboard                 | `#overview`                         |
| `#spend`     | dev   | Dev usage breakdown                    | `#usage`                            |

`router()` rewrites `location.hash` in place when an alias or invalid hash
is resolved, so old bookmarks self-heal.

---

## Backend endpoints called

All admin requests pass `x-admin-key: <devAdminKey | adminKeyInline>` as a
header when either input is non-empty. Otherwise they rely on the session
cookie set during Firebase auth. No endpoint shape was changed.

### Auth / config
- `GET  /api/config`
- `GET  /api/auth/me`
- `POST /api/auth/verify`         body `{ idToken }`
- `POST /api/auth/logout`
- `GET  /health`

### Self (developer)
- `GET  /api/me/summary` → `{ user, tokens[], usage[], limits[] }`
- `POST /api/me/tokens`  body `{ label }` → `{ token, prefix, label }`

### Admin
- `GET  /admin/users`
- `POST /admin/users`              `{ email, role, isAdmin, fullBodyLogging }`
- `PATCH /admin/users/:id`         `{ role?, enabled?, isAdmin?, fullBodyLogging? }`
- `POST /admin/users/:id/tokens`   `{ label, capUsdDaily?, capTokensDaily? }`
- `PATCH /admin/tokens/:id`        `{ enabled }`

- `GET  /admin/provider-accounts`
- `POST /admin/provider-accounts`  `{ provider, label, ownerEmail?, secret, refreshSecret?, maxInFlight?, notes? }`
- `PATCH /admin/provider-accounts/:id`   `{ enabled?, status?, maxInFlight?, notes?, riskNotes?, quotaNotes? }`
- `DELETE /admin/provider-accounts/:id`
- `GET  /admin/provider-accounts/:id/secret`
- `POST /admin/provider-accounts/:id/quota`
- `POST /admin/provider-accounts/codex/oauth/start`     `{ label?, emailHint? }`
- `POST /admin/provider-accounts/codex/oauth/callback`  `{ code, state?, label?, email? }`

- `GET  /admin/limits`
- `PUT  /admin/limits/role`        `{ role, provider, dailyUsd, dailyTokens }`
- `PUT  /admin/limits/user`        `{ userId, provider, dailyUsd, dailyTokens }`

- `POST /admin/test-as-user`       `{ userId, provider, dryRun }`
- `GET  /admin/usage`
- `GET  /admin/audit-logs`
- `GET  /admin/alerts`

> Bulk-acknowledge alerts is a UI affordance but no `/admin/alerts/:id/ack`
> endpoint exists yet. The button toasts a "not yet available" notice and
> does not call anything. The button is otherwise wired and ready.

---

## UX patterns preserved

- `toast(msg, kind)` where `kind ∈ {ok, warn, error}` — host `#toastHost`.
- `drawer({ title, subtitle, body, footer, width? })` — host `#drawerHost`.
  ESC closes, focus is trapped inside, click on backdrop closes.
- `confirmDialog({ title, message, danger?, confirmLabel? })` — host
  `#confirmHost`. Returns Promise<boolean>. ESC = cancel.
- Toast / drawer / confirm hosts are siblings of `#app`, not children, so
  layout-zindex stays predictable.

---

## Role gating

`isAdminUser()` is the single source of truth.
- `NAV_ADMIN` vs `NAV_DEV` decides which sidebar items render.
- `ROUTES.<route>.adminOnly` is checked by the router; admin-only routes
  redirect to `#home` for non-admins.
- The cog popover omits admin-only actions (e.g. "Test as user") for
  non-admins.

---

## Known gap (NOT introduced by redesign)

- **Self-revoke** for developer tokens. Backend only exposes admin-side
  `PATCH /admin/tokens/:id`. The dev `Home → My tokens` table therefore
  shows tokens with status pills and a hint that admins manage revocation.
- **Bulk-acknowledge alerts.** No backend endpoint yet. The Health page
  surfaces the affordance but does not call anything.
- **Time-bucketed usage charts.** `/admin/usage` returns a 24h aggregate,
  not a series. The Usage page renders the breakdown faithfully and
  disables the 7d/30d range tabs with an explanatory hint until backend
  support lands.
