# UI Redesign — Console v2

Branch: `redesign/ui-v2`. Vanilla JS, no bundler, no framework, no new packages.
Dark theme. Same backend. Same auth. Hash router with new route names + legacy aliases.

---

## 1. Information architecture (IA)

### Why this changes from v1

v1 had **seven** admin tabs (Overview, Accounts, Users, Limits, Usage, Alerts, Audit). That's a
data-shaped IA — each table got its own page. It made onboarding slow because you had to know
which table held which thing, and incident triage was painful (alerts in one tab, the offending
account in another, the affected user in a third).

v2 is **task-shaped**. Four admin tabs, two dev tabs.

### Admin shell (4 tabs)

#### `#health` — “Is the proxy OK?”
Single page that fuses what was Overview + Provider accounts + Alerts.

- **KPI strip** — Requests 24h, Spend 24h, Tokens 24h, Error rate 24h. Big number, delta vs
  previous 24h, mini sparkline. Tabular numerics.
- **Provider status grid** — one card per provider (Anthropic, Codex, OpenAI). Each card lists
  its accounts with status pill (live / cooldown / dead), in-flight, last quota check, last
  used. Click an account row → **account drawer** with edit / disable / delete / run quota
  probe / reveal-and-copy secret. “+ Add account” menu on the card splits into API-key drawer
  vs Codex OAuth drawer (multi-step copy-paste flow).
- **Active incidents** — open (unresolved) alerts, severity-coded, bulk-ack action.
- **Recent activity** — combined feed of audit + alerts (last 50, severity-coded, “see all”
  links into Audit and a dedicated incidents history).

#### `#identity` — “Who can use it?”
Merges Users + Limits because they’re always investigated together.

- **Role defaults** panel at the top — inline-editable role × provider grid (developer / member
  / founder / admin). Save indicator per cell.
- **Users table** below — searchable, with role chip, enabled toggle, and last-active.
  Click a row → **user drawer** with three tabs: Tokens (issue/revoke), Limit overrides, Recent
  usage. The drawer is also where role/admin/full-body-log flags are toggled.
- **+ New user** primary action top-right.

#### `#usage` — “Where is the money going?”
- Date range picker (24h default, 7d, 30d, custom — limited by what `/admin/usage` returns
  today; we render whatever scope the API gives us, with a hint if it’s only 24h).
- Two SVG line charts side-by-side: requests over time, spend over time.
- **Breakdown table** — sortable by spend, columns: email, provider, model, requests, tokens,
  $. Provider mark + clickable email (opens user drawer in Identity).
- **Top spenders** mini-list on the right column at ≥1280px, hidden below.

#### `#audit` — “What happened?”
- Filterable timeline (actor, action type, target type, free-text).
- Row expand → diff view (before / after JSON, monospace, syntax-highlighted).
- Tab toggle at top: All / Resolved alerts (this is where alerts go to retire).

### Developer shell (2 tabs)

#### `#home` — Everything they need on one screen
- Greeting (`Hi, Don.`) + role chip.
- **Quick start** card — base URL + ready-to-paste curl. Expanded if no token; collapses to a
  thin endpoint reminder once a token exists.
- **Cap headroom** — per-provider progress bars: today’s spend / daily $ cap; near-cap warning
  color, no-cap state shown as “unlimited”.
- **Tokens** — clean table (prefix, label, last used, created). Read-only — there is no
  self-revoke endpoint, so we display tokens with a hint that admins manage revocation. A “+
  New token” drawer reveals the raw token once with a copy button and a “store this now”
  reminder.
- **At-a-glance KPI strip** — Requests 24h, Spend 24h, Tokens 24h, Active tokens.

#### `#spend` — Detail
- Per-provider × per-model breakdown of own usage from `/api/me/summary`.
- Empty state with a friendly “you haven’t made any calls yet — try this curl” CTA back to Home.

### Settings (admin only)

The dev admin key input no longer lives in the topbar. It’s tucked behind a cog menu:
- Topbar cog → popover with the `DEV_ADMIN_KEY` field (still id `#adminKeyInline`) and a
  “Test as user” action that opens its own drawer (POST `/admin/test-as-user`). These are
  rarely-used affordances and don’t deserve permanent screen space.

### Hash routes

| Route       | Role  | Purpose                  | Legacy alias redirect from |
| ----------- | ----- | ------------------------ | -------------------------- |
| `#health`   | admin | Health + accounts + alerts | `#overview`, `#accounts`, `#alerts` |
| `#identity` | admin | Users + limits           | `#users`, `#limits`        |
| `#usage`    | admin | Usage analytics          | `#usage` (kept)            |
| `#audit`    | admin | Audit log + alert history | `#audit` (kept)            |
| `#home`     | dev   | Personal dashboard       | `#overview`                |
| `#spend`    | dev   | Personal usage detail    | `#usage`                   |

JS resolves an unknown / legacy hash to the role’s default route on first load and rewrites
`location.hash` in place so bookmarks self-heal.

### Functional surface map (legacy → new home)

| Legacy surface (v1)                                     | New home (v2)                                     | Mode            |
| ------------------------------------------------------- | ------------------------------------------------- | --------------- |
| Admin Overview KPIs                                     | Health → KPI strip                                | preserved + sparkline |
| Admin “provider mini health” card                       | Health → Provider status grid                     | merged + drilldown |
| Admin Accounts list (per provider sections)             | Health → Provider status grid (nested per card)   | reframed       |
| Admin “+ Add account” (API key)                         | Health → Provider card → “+ Add” → API key drawer | drawer         |
| Admin “+ Add account” (Codex OAuth)                     | Health → Provider card → “+ Add” → OAuth drawer   | multi-step drawer |
| Admin enable/disable/edit/delete account                | Account drawer in Health                          | drawer actions |
| Admin run-quota-probe                                   | Account drawer in Health                          | inline action  |
| Admin reveal account secret                             | Account drawer → click-to-reveal masked field     | inline action  |
| Admin Users table + search                              | Identity → User table                             | preserved      |
| Admin Create user                                       | Identity → “+ New user” drawer                    | drawer         |
| Admin Edit user (role / enabled / isAdmin / fullBody)   | User drawer in Identity                           | drawer fields  |
| Admin issue token for user                              | User drawer → Tokens section                      | inline         |
| Admin revoke token (`PATCH /admin/tokens/:id`)          | User drawer → Tokens section                      | inline         |
| Admin Role limits                                       | Identity → Role defaults panel (page top)         | inline grid    |
| Admin User limit overrides                              | User drawer → Limits section                      | inline         |
| Admin Usage 24h breakdown                               | Usage → Breakdown table                           | preserved + sort |
| Admin Usage trends                                      | Usage → Two SVG line charts                       | new            |
| Admin Alerts list                                       | Health → Active incidents (open)                  | repositioned   |
| Admin alert history (resolved)                          | Audit → Resolved tab                              | new            |
| Admin Audit log + filters                               | Audit (separate tab)                              | preserved      |
| Admin audit row diff (before/after JSON)                | Audit → row expand                                | improved       |
| Admin “Test as user”                                    | Topbar cog → Test as user drawer                  | demoted        |
| Admin DEV_ADMIN_KEY input                               | Topbar cog → popover                              | hidden but reachable |
| Admin Refresh                                           | Topbar refresh icon                               | preserved      |
| Sign out                                                | Sidebar foot user card                            | preserved      |
| Mobile nav toggle                                       | Topbar hamburger → slide-out sidebar              | preserved      |
| Dev Overview / role badge                               | Home → header                                     | preserved      |
| Dev My access                                           | Home → Quick start card                           | improved       |
| Dev My limits                                           | Home → Cap headroom bars                          | improved       |
| Dev My tokens                                           | Home → Tokens table                               | preserved      |
| Dev Create token                                        | Home → “+ New token” drawer (one-shot reveal)     | preserved      |
| Dev My usage                                            | Spend → breakdown table                           | preserved      |

Nothing dropped. A few things demoted (Test-as-user, dev key input) because they’re rare.

---

## 2. Design system

### Tokens (CSS variables)

```
spacing  : 4 / 8 / 12 / 16 / 20 / 24 / 32 / 48 / 64
radii    : 6 / 9 / 12 / 16 / 999
type     : 11 / 12 / 13 / 14 / 16 / 20 / 28 / 36   (variable Inter; tabular nums on metrics)
weight   : 400 / 500 / 600 / 700
motion   : 120ms (cubic-bezier(.2,.8,.2,1)) for hover/focus, 180ms for route transitions
shadows  : sh-1 (raised), sh-2 (overlay/drawer), sh-glow-accent (focus ring)
```

### Color (dark)

| Token              | Value                          | Use                       |
| ------------------ | ------------------------------ | ------------------------- |
| `--bg`             | `#08090c`                      | App background            |
| `--surface`        | `#101218`                      | Cards, drawer, side panels |
| `--surface-2`      | `#161922`                      | Inset / hover surfaces    |
| `--surface-3`      | `#1c2030`                      | Active selection / pressed |
| `--border`         | `#222632`                      | Hairlines                 |
| `--border-strong`  | `#2c3142`                      | Inputs, buttons           |
| `--text`           | `#e7eaf0`                      | Primary text              |
| `--text-muted`     | `#9aa2b1`                      | Secondary text            |
| `--text-subtle`    | `#6b7282`                      | Tertiary text / hints     |
| `--accent`         | `#10b981`                      | Brand, primary CTAs       |
| `--accent-hi`      | `#34d399`                      | Hover, focus, highlights  |
| `--info`           | `#60a5fa`                      | Info pills                |
| `--success`        | `#34d399`                      | Success state             |
| `--warn`           | `#fbbf24`                      | Cooldowns, near-cap       |
| `--danger`         | `#f87171`                      | Errors, dead accounts     |
| `--violet`         | `#c084fc`                      | Codex provider tint       |
| `--gold`           | `#fbbf24`                      | Anthropic provider tint   |

Status pills use the foreground / soft-background pair derived from each token. Provider marks
use the same hue with a subtle border so the eye locks onto provider quickly.

### Typography

Single variable font: **Inter** via `https://rsms.me/inter/inter.css` (one stylesheet, no
Google Fonts dependency, supports `font-feature-settings: 'tnum','ss01','cv11'`).

- Headings: 600 weight, `letter-spacing: -0.015em`.
- Numbers in metrics, tables, sparklines: `tnum` on (tabular numerics).
- Monospace for IDs / hashes / secrets / curl: ui-monospace stack.

### Components

- **Button** — sizes `sm/md`, variants `primary/secondary/ghost/danger`. Only **one** primary
  per visible region. Loading state: spinner replaces icon, label preserved.
- **IconButton** — 32px square, transparent, hover `--surface-2`. Always has `aria-label`.
- **Pill / Badge** — status (`live / cooldown / dead / disabled`), role (`admin / founder /
  developer / member`), provider (`anthropic / codex / openai`).
- **Input** — 36px tall, `border-strong`, focus shows `accent-soft` glow ring (3px) — visible
  WCAG focus. Inline validation hint slot below.
- **Card** — `surface` with 1px border, 12px radius, shadow `sh-1`. No flat boxes inside cards;
  use hairlines + spacing.
- **Table** — sticky header, hover row `surface-2`, monospace numerics, copy-button on truncated
  IDs/hashes (always visible on hover, keyboard reachable).
- **Drawer** — right-side slide-in (440px desktop, full-width below 720px). Trap-focus on open,
  ESC closes. Sticky header with title + close button, body scrolls, sticky footer with action
  row.
- **Toast** — bottom-right stack, 200ms fade. Variants: ok (accent), warn (gold), error (rose).
- **Confirm dialog** — centered modal with backdrop click-to-close + ESC. Two-button row, danger
  variant tints the primary red.
- **Sparkline** — pure inline SVG `<polyline>` 80×24, accent stroke 1.5px, no fill, no library.
- **Line chart** — 100% width × 200px, two series, axis-less, dotted gridlines. Hover crosshair
  via JS pointer events on the SVG.
- **Empty state** — line illustration (inline SVG), short prose, single CTA.

### Motion

- Route change: 120ms opacity fade on `#view`. No layout shift from the sidebar.
- Hover: 120ms color/border. No transforms on rows (reduces jitter on large tables).
- Drawer slide: 180ms cubic-bezier `(.2,.8,.2,1)`.
- All animations honor `prefers-reduced-motion: reduce` (disabled to a 0ms swap).

### Responsive breakpoints

| Width  | Behavior                                                                 |
| ------ | ------------------------------------------------------------------------ |
| ≥1280  | Two-column layouts (e.g. Usage with “Top spenders” aside)               |
| ≥1024  | Default desktop: 240px sidebar + content                                |
| ≥768   | Sidebar collapses to slide-out, hamburger in topbar                     |
| ≥360   | Tables collapse to card lists; KPI strip wraps to 2×2; drawer is full-width |

### Accessibility

- WCAG AA contrast on all text + iconography (text-muted on surface tested ≥ 4.5:1).
- Visible focus ring (3px accent-soft glow + 1px accent border) on **every** interactive
  element.
- ARIA: `aria-label` on icon-only buttons, `aria-current="page"` on active nav item,
  `role="dialog"` + `aria-modal` + focus trap on drawer/confirm, `aria-live="polite"` on toasts.
- Keyboard: Tab order top-to-bottom, ESC closes drawer/menu/confirm, arrow keys in nav don’t
  trigger nav (just focus), Enter activates, `/` focuses search.
- All ASCII glyph nav icons replaced by inline SVG (lucide-style strokes, 1.6px).

---

## 3. Trade-offs and decisions

- **Sidebar over top-tabs.** Considered top-tabs (Vercel-style) but with the user/env footer
  living in the sidebar and only 4 admin items, vertical reads cleaner and is less crowded on
  mobile slide-out.
- **No command-K palette.** Tempting given Linear influence but with 6 routes total it adds
  surface-area without payoff. Search inside Identity / Usage is enough.
- **No light theme.** Out of scope; would double the token surface; brief allows dark only.
- **Sparklines without a library.** Pure SVG `<polyline>` is enough at this scale and avoids
  any new dep. A real time-series chart only appears in `#usage`, also pure SVG.
- **Health page does triple duty.** Carries the highest cognitive load. Justified because
  during incidents the admin wants accounts, alerts, and trends side-by-side, not as separate
  navigations.
- **No self-revoke for dev tokens.** Backend doesn’t expose it. UI shows tokens + a clear hint
  pointing to admins. We do not pretend we can revoke and then 401.
- **Demoting “Test as user”.** Extremely rare action. Putting it behind the cog menu prevents
  it from cluttering the IA.
- **Single shared shell.** The login, sidebar, topbar, drawer/toast/confirm hosts are all
  shared. Only the nav items + which routes resolve are role-scoped. Less code, consistent
  behavior, easier to QA.

---

## 4. Self-review

### What changed
- IA: 7 admin tabs → 4. 1 dev tab → 2.
- Hash routes renamed; legacy hashes redirect transparently.
- Sidebar redesigned with proper SVG iconography (ASCII glyphs gone).
- Topbar simplified: dev key input no longer always visible — moved behind cog.
- Login: redesigned typography, real bullet icons, calmer art panel, fallback collapsed.
- Account / user / limit / token interactions consolidated into drawers, opened from the most
  natural pages (Health for accounts, Identity for users/limits/tokens).
- Overview KPIs now have deltas + sparklines.
- Empty states are proper illustrations + single CTA.
- Tables: sticky headers, keyboard-reachable copy buttons, mobile-card collapse at <720px.

### What stayed identical
- Every backend endpoint and request shape used by the console.
- Auth bootstrapping flow (Firebase + DEV_ADMIN_KEY fallback header).
- Hash router pattern (just different route names + aliases).
- Toast/drawer/confirm contract names and signatures.
- DOM IDs that JS reads from outside the renderer (`#login`, `#app`, `#viewTitle`,
  `#viewSubtitle`, `#view`, `#globalSearch`, `#refreshBtn`, `#navList`, `#userEmail`,
  `#userRole`, `#userAvatar`, `#envLabel`, `#signOutBtn`, `#navToggle`, `#adminKeyInline`,
  `#devAdminKey`, `#signInBtn`, `#loginError`, `#drawerHost`, `#toastHost`, `#confirmHost`).
- File set: only `public/index.html`, `public/console.css`, `public/console.js`. No new files
  in `public/`.

### Things I’m unsure about
- Whether the **single Health page** that fuses three legacy pages will feel too dense for very
  busy fleets. With ~3 providers × ~3 accounts each it’s fine; if you grow to 20 accounts per
  provider we may want to give Accounts its own tab again. Easy to split later.
- The **Audit “Resolved alerts” tab** assumes it’s OK to surface resolved alerts inside
  `/admin/audit-logs` view — they’re actually fetched from `/admin/alerts` and filtered
  client-side. If you’d rather keep alerts strictly under Health, removing the Resolved tab is
  one line.
- **Usage charts** assume `/admin/usage` returns time-bucketed rows or that a 24h aggregate is
  acceptable as a single point. The current endpoint returns 24h aggregates only — for v2 I
  render the breakdown faithfully and show a single-bucket sparkline placeholder; richer trend
  charts depend on backend support and are noted in the page footer.
- **Mobile drawer trap-focus**: I rely on JS to send focus into the drawer and listen for Tab
  out of bounds. Edge cases with autofill + soft keyboards on iOS exist; I’ve tested keyboard
  navigation on desktop only.
