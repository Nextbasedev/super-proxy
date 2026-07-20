/* ═══════════════════════════════════════════════════════════════════
   Super Proxy — console.js  (v2)
   Vanilla JS SPA. Hash-based router. Task-shaped IA.
   See docs/UI-REDESIGN.md for the IA + design system.
   See docs/UI-CONTRACTS.md for the JS↔HTML contract.
   ═══════════════════════════════════════════════════════════════════ */
(() => {
'use strict';

/* ──────────────── DOM helpers ──────────────── */
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    else if (k === 'data') for (const [dk, dv] of Object.entries(v)) node.dataset[dk] = dv;
    else if (k === 'aria') for (const [ak, av] of Object.entries(v)) node.setAttribute('aria-' + ak, av);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k in node && typeof node[k] !== 'object') node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const svgNS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}, ...children) => {
  const node = document.createElementNS(svgNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c) node.appendChild(c);
  return node;
};

/* ──────────────── Icon library ────────────────
   Lucide-style line icons, 24×24 viewBox.
   Use: icon('home'), icon('home', 16). Returns SVG element. */
const ICONS = {
  // brand-ish
  pulse:    'M22 12h-4l-3 9L9 3l-3 9H2',
  activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
  // nav
  home:     'M3 9l9-7 9 7v11a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-5h-2v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  heartpulse:'M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z M3.5 12h4l2-3 3 6 2-3h4',
  users:    'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M23 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75',
  bar:      'M12 20V10 M18 20V4 M6 20v-6',
  history:  'M3 3v5h5 M3.05 13a9 9 0 1 0 .47-3.5 M12 7v5l3 3',
  // actions
  plus:     'M12 5v14 M5 12h14',
  minus:    'M5 12h14',
  trash:    'M3 6h18 M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2 M10 11v6 M14 11v6',
  edit:     'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7 M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z',
  copy:     'M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2z M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
  eye:      'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  eyeoff:   'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94 M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19 M14.12 14.12A3 3 0 0 1 9.88 9.88 M1 1l22 22',
  refresh:  'M23 4v6h-6 M1 20v-6h6 M3.51 9a9 9 0 0 1 14.85-3.36L23 10 M20.49 15A9 9 0 0 1 5.64 18.36L1 14',
  search:   'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M21 21l-4.35-4.35',
  settings: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  signout:  'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4 M16 17l5-5-5-5 M21 12H9',
  x:        'M18 6L6 18 M6 6l12 12',
  check:    'M20 6L9 17l-5-5',
  warn:     'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z M12 9v4 M12 17h.01',
  shield:   'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  power:    'M18.36 6.64a9 9 0 1 1-12.73 0 M12 2v10',
  key:      'M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4',
  token:    'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z M12 6v6l4 2',
  clock:    'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 6v6l4 2',
  link:     'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71 M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
  external: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6 M15 3h6v6 M10 14L21 3',
  filter:   'M22 3H2l8 9.46V19l4 2v-8.54L22 3z',
  chevron:  'M6 9l6 6 6-6',
  chevronD: 'M6 9l6 6 6-6',
  chevronR: 'M9 18l6-6-6-6',
  chevronL: 'M15 18l-6-6 6-6',
  arrowUp:  'M12 19V5 M5 12l7-7 7 7',
  arrowDown:'M12 5v14 M19 12l-7 7-7-7',
  trendUp:  'M23 6l-9.5 9.5-5-5L1 18 M17 6h6v6',
  trendDown:'M23 18l-9.5-9.5-5 5L1 6 M17 18h6v-6',
  alert:    'M12 9v4 M12 17h.01 M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z',
  inbox:    'M22 12h-6l-2 3h-4l-2-3H2 M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z',
  zap:      'M13 2L3 14h9l-1 8 10-12h-9l1-8z',
  dollar:   'M12 1v22 M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
  hash:     'M4 9h16 M4 15h16 M10 3L8 21 M16 3l-2 18',
  cpu:      'M4 4h16v16H4z M9 9h6v6H9z M9 1v3 M15 1v3 M9 20v3 M15 20v3 M20 9h3 M20 14h3 M1 9h3 M1 14h3',
  mail:     'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M22 6l-10 7L2 6',
  flame:    'M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z',
  user:     'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2 M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  globe:    'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M2 12h20 M12 2a15 15 0 0 1 4 10 15 15 0 0 1-4 10 15 15 0 0 1-4-10 15 15 0 0 1 4-10z',
  plug:     'M9 2v6 M15 2v6 M5 8h14 M7 8v6a5 5 0 0 0 10 0V8 M12 19v3',
};
function icon(name, size = 16, extra = '') {
  const path = ICONS[name];
  if (!path) return el('span');
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('width', size); svg.setAttribute('height', size);
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  if (extra) svg.setAttribute('class', extra);
  // multi-path: split by space-M jumps via two-path approach (we just inject html for simplicity)
  svg.innerHTML = `<path d="${path}"/>`;
  return svg;
}
function svgIcon(name, size = 16) { // alias
  return icon(name, size);
}
// Fill data-icon attributes (used for static HTML bullets)
function hydrateInlineIcons(root = document) {
  $$('[data-icon]', root).forEach(node => {
    if (node.dataset.iconHydrated) return;
    const name = node.dataset.icon;
    const sz = parseInt(node.dataset.size || '14', 10);
    node.replaceChildren(icon(name, sz));
    node.dataset.iconHydrated = '1';
  });
}

/* ──────────────── Format helpers ──────────────── */
const fmt = {
  usd(n) {
    if (n == null || isNaN(n)) return '—';
    const v = Number(n);
    if (v >= 1000) return '$' + Math.round(v).toLocaleString();
    if (v >= 10) return '$' + v.toFixed(2);
    if (v <= 0)  return '$0.00';
    return '$' + v.toFixed(4).replace(/0+$/,'').replace(/\.$/,'');
  },
  num(n) {
    if (n == null || isNaN(n)) return '—';
    const v = Number(n);
    if (v >= 1e9) return (v/1e9).toFixed(2) + 'B';
    if (v >= 1e6) return (v/1e6).toFixed(2) + 'M';
    if (v >= 1e3) return (v/1e3).toFixed(2) + 'k';
    return v.toLocaleString();
  },
  int(n) { return n == null ? '—' : Number(n).toLocaleString(); },
  pct(n, digits = 1) { return (n == null || isNaN(n)) ? '—' : (Number(n) * 100).toFixed(digits) + '%'; },
  ago(ts) {
    if (!ts) return '—';
    const d = typeof ts === 'string' ? new Date(toUtcIso(ts)).getTime() : Number(ts);
    if (!Number.isFinite(d)) return '—';
    const s = Math.max(0, (Date.now() - d) / 1000);
    if (s < 5)   return 'just now';
    if (s < 60)  return Math.floor(s) + 's ago';
    if (s < 3600) return Math.floor(s/60) + 'm ago';
    if (s < 86400) return Math.floor(s/3600) + 'h ago';
    if (s < 86400*7) return Math.floor(s/86400) + 'd ago';
    return new Date(d).toISOString().slice(0,10);
  },
  date(ts) {
    if (!ts) return '—';
    const d = typeof ts === 'string' ? new Date(toUtcIso(ts)) : new Date(Number(ts));
    if (isNaN(d)) return '—';
    return d.toISOString().replace('T',' ').slice(0,16) + 'Z';
  },
};
// Render audit target_id consistently. Numeric ids (users, tokens, accounts)
// get a leading '#' so they read as 'user #4'. String ids (e.g. provider OAuth
// flow keys like 'provider.example') are rendered verbatim, no fake ID glyph.
function formatAuditTargetId(targetType, targetId) {
  if (targetId == null) return '';
  const s = String(targetId);
  return /^\d+$/.test(s) ? '#' + s : s;
}
// SQLite stores `YYYY-MM-DD HH:MM:SS` without a timezone. Treat such strings
// as UTC instead of letting the browser parse them as local time, which would
// shift relative timestamps by the user's UTC offset.
function toUtcIso(ts) {
  if (typeof ts !== 'string') return ts;
  const m = ts.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}:?\d{2})?$/);
  if (!m) return ts;
  if (m[3]) return ts.replace(' ', 'T');
  return `${m[1]}T${m[2]}Z`;
}

/* ──────────────── Constants ──────────────── */
const PROVIDERS = ['anthropic', 'openai_codex', 'openai', 'groq', 'cerebras', 'kimi', 'glm', 'gemini', 'openrouter', 'fusion', 'deepgram', 'fish', 'xai', 'runpod', 'serper'];
const PROVIDER_LABEL = { anthropic: 'Anthropic', openai_codex: 'Codex', openai: 'OpenAI', groq: 'Groq', cerebras: 'Cerebras', kimi: 'Kimi', glm: 'GLM', gemini: 'Gemini', openrouter: 'OpenRouter', fusion: 'Fusion', deepgram: 'Deepgram', fish: 'Fish Audio', xai: 'xAI', runpod: 'Runpod', serper: 'Serper' };
const PROVIDER_GLYPH = { anthropic: 'A', openai_codex: 'C', openai: 'O', groq: 'G', cerebras: 'Cb', kimi: 'K', glm: 'GL', gemini: 'Gm', openrouter: 'OR', fusion: 'Fu', deepgram: 'DG', fish: 'FA', xai: 'xAI', runpod: 'RP', serper: 'S' };

const ROUTES = {
  // admin
  health:   { title: 'Health',    subtitle: 'Provider accounts, incidents, recent activity', adminOnly: true,  render: () => renderHealth() },
  identity: { title: 'Identity',  subtitle: 'Users, roles and per-user limit overrides',     adminOnly: true,  render: () => renderIdentity() },
  usage:    { title: 'Usage',     subtitle: 'Where requests and spend are going (24h)',      adminOnly: false, render: () => isAdminUser() ? renderUsageAdmin() : renderSpend() },
  audit:    { title: 'Audit log', subtitle: 'Every admin action and resolved incidents',     adminOnly: true,  render: () => renderAudit() },
  // dev
  home:     { title: 'Overview',  subtitle: 'Your access, limits and recent activity',       adminOnly: false, render: () => renderHome() },
  spend:    { title: 'Spend',     subtitle: 'Your usage broken down by provider and model',  adminOnly: false, render: () => renderSpend() },
  fusion:   { title: 'Fusion',    subtitle: 'Multi-model presets and call history',              adminOnly: false, render: () => renderFusion() },
  monitoring: { title: 'Monitoring', subtitle: 'Cost, cache efficiency, pool health and reliability', adminOnly: false, render: () => renderMonitoring() },

};
const ROUTE_ALIASES = {
  // legacy v1 hash → v2 hash
  overview: () => isAdminUser() ? 'health' : 'home',
  accounts: () => 'health',
  alerts:   () => 'health',
  users:    () => 'identity',
  limits:   () => 'identity',
  // usage / audit unchanged
};
const ADMIN_ROUTES = Object.entries(ROUTES).filter(([,v]) => v.adminOnly).map(([k]) => k);

const NAV_ADMIN = [
  { route: 'health',   label: 'Health',     icon: 'heartpulse', countKey: 'incidents' },
  { route: 'identity', label: 'Identity',   icon: 'users',      countKey: 'users' },
  { route: 'usage',    label: 'Usage',      icon: 'bar' },
  { route: 'monitoring', label: 'Monitoring', icon: 'activity' },
  { route: 'audit',    label: 'Audit log',  icon: 'history' },

  { route: 'fusion',   label: 'Fusion',     icon: 'zap' },
];
const NAV_DEV = [
  { route: 'home',     label: 'Overview',   icon: 'home' },
  { route: 'spend',    label: 'Spend',      icon: 'bar' },
  { route: 'fusion',   label: 'Fusion',     icon: 'zap' },
];
// Monitor allowlist users (MONITOR_ACCESS_EMAILS) get the read-only Monitoring view.
const NAV_MONITORING_ITEM = { route: 'monitoring', label: 'Monitoring', icon: 'activity' };

/* ──────────────── State ──────────────── */
const state = {
  user: null,
  data: {
    accounts: [], users: [], roleLimits: [], userLimits: [],
    usage: [], alerts: [], audit: [], groq: null, cerebras: null, knownModels: {},
    tokens: [], myUsage: [], myLimits: [],
    health: null,
  },
  view: 'health',
  filters: { q: '' },
  loaded: false,
  loading: false,
};
const isAdminUser = () => !!state.user?.isAdmin;

/* ──────────────── API ──────────────── */
const adminKey = () => ($('#adminKeyInline')?.value || $('#devAdminKey')?.value || '').trim();
async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body != null && !headers['content-type'] && !headers['Content-Type']) {
    headers['content-type'] = 'application/json';
  }
  const k = adminKey();
  if (k) headers['x-admin-key'] = k;
  const r = await fetch(path, { ...opts, credentials: 'include', headers });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text, status: r.status }; }
  if (!r.ok) {
    const msg = json?.error || json?.detail || `HTTP ${r.status}`;
    const err = new Error(msg);
    err.status = r.status; err.payload = json;
    throw err;
  }
  return json;
}

/* ──────────────── Toast ──────────────── */
function toast(msg, kind = 'ok') {
  const t = el('div', { class: `toast ${kind === 'ok' ? '' : kind}` },
    el('span', { class: 'glyph' }, kind === 'error' ? '✕' : kind === 'warn' ? '!' : '✓'),
    el('span', {}, msg)
  );
  $('#toastHost').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateY(8px)'; t.style.transition = 'all 200ms'; setTimeout(() => t.remove(), 220); }, 2400);
}

/* ──────────────── Confirm dialog ──────────────── */
function confirmDialog({ title, message, danger = false, confirmLabel = 'Confirm' }) {
  return new Promise((resolve) => {
    const close = (val) => { backdrop.remove(); document.removeEventListener('keydown', onKey); resolve(val); };
    const card = el('div', { class: 'confirm', role: 'dialog', 'aria-modal': 'true' },
      el('h3', {}, title),
      el('p', {}, message),
      el('div', { class: 'confirm-actions' },
        el('button', { class: 'btn btn--ghost', on: { click: () => close(false) } }, 'Cancel'),
        el('button', { class: `btn ${danger ? 'btn--danger' : 'btn--primary'}`, on: { click: () => close(true) } }, confirmLabel),
      )
    );
    const onKey = (e) => { if (e.key === 'Escape') close(false); };
    const backdrop = el('div', { class: 'confirm-backdrop', on: { click: (e) => { if (e.target === backdrop) close(false); } } }, card);
    $('#confirmHost').appendChild(backdrop);
    document.addEventListener('keydown', onKey);
    setTimeout(() => card.querySelector('button').focus(), 30);
  });
}

/* ──────────────── Drawer ──────────────── */
function drawer({ title, subtitle, body, footer, width }) {
  const closeFn = () => {
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('keydown', onTab, true);
    back.style.opacity = '0';
    d.style.transform = 'translateX(20px)'; d.style.opacity = '0';
    d.style.transition = 'all 180ms';
    setTimeout(() => back.remove(), 180);
  };
  const onKey = (e) => { if (e.key === 'Escape') closeFn(); };
  // Focus trap
  const onTab = (e) => {
    if (e.key !== 'Tab') return;
    const focusables = $$('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])', d);
    if (!focusables.length) return;
    const first = focusables[0], last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  const back = el('div', { class: 'drawer-backdrop', on: { click: (e) => { if (e.target === back) closeFn(); } } });
  const d = el('div', { class: 'drawer', role: 'dialog', 'aria-modal': 'true', style: width ? { width } : null },
    el('div', { class: 'drawer__head' },
      el('div', {},
        el('h2', {}, title),
        subtitle ? el('p', {}, subtitle) : null,
      ),
      el('div', { class: 'spacer' }),
      el('button', { class: 'iconbtn', title: 'Close', 'aria-label': 'Close drawer', on: { click: closeFn } }, icon('x', 16)),
    ),
    el('div', { class: 'drawer__body' }, body),
    footer ? el('div', { class: 'drawer__foot' }, footer) : null,
  );
  back.appendChild(d);
  $('#drawerHost').appendChild(back);
  document.addEventListener('keydown', onKey);
  document.addEventListener('keydown', onTab, true);
  setTimeout(() => {
    const i = d.querySelector('input,textarea,select,button');
    if (i) i.focus();
  }, 80);
  return { close: closeFn, root: d };
}

/* ──────────────── Auth ──────────────── */
const FB = { app: null, auth: null, provider: null };
let bootPromise = null;

async function boot() {
  hydrateInlineIcons();
  let cfg;
  try { cfg = await (await fetch('/api/config')).json(); }
  catch { showError('Could not load config.'); return; }

  if (cfg?.firebase?.apiKey) {
    try {
      firebase.initializeApp(cfg.firebase);
      FB.auth = firebase.auth();
      FB.provider = new firebase.auth.GoogleAuthProvider();
      FB.provider.setCustomParameters({ prompt: 'select_account' });
      try {
        const redirect = await FB.auth.getRedirectResult();
        if (redirect?.user && await ensureSession(redirect.user)) return showApp();
      } catch (e) { showError(cleanAuthError(e)); }
      FB.auth.onAuthStateChanged(async (user) => {
        if (user) { if (await ensureSession(user)) return showApp(); }
        showLogin();
      });
    } catch (e) {
      console.warn('Firebase init failed', e); showLogin();
    }
  } else {
    try {
      const me = await fetch('/api/auth/me', { credentials: 'include' });
      if (me.ok) { const j = await me.json(); state.user = j; return showApp(); }
    } catch {}
    showLogin();
  }
}

async function ensureSession(user) {
  try {
    let r = await fetch('/api/auth/me', { credentials: 'include' });
    if (r.ok) { state.user = await r.json(); return true; }
    const idToken = await user.getIdToken();
    r = await fetch('/api/auth/verify', {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idToken }),
    });
    if (r.ok) { state.user = await r.json(); return true; }
    const err = await r.json().catch(() => ({}));
    showError(err.error || err.detail || 'Access denied');
    return false;
  } catch (e) { showError(e.message); return false; }
}

function showError(msg) {
  const e = $('#loginError');
  if (e) { e.textContent = msg; e.classList.remove('hidden'); }
}

function cleanAuthError(e) {
  const code = e?.code ? `${e.code}: ` : '';
  const msg = e?.message || String(e || 'Sign-in failed');
  if (/unauthorized-domain/i.test(msg + code))
    return 'This domain is not authorized in Firebase Auth. Add it to Firebase authorized domains.';
  if (/popup-blocked/i.test(msg + code)) return 'Popup was blocked. Trying redirect sign-in…';
  if (/popup-closed/i.test(msg + code)) return 'Google sign-in popup was closed before completion.';
  return code + msg;
}

async function signIn() {
  const btn = $('#signInBtn');
  if (btn) { btn.disabled = true; btn.classList.add('loading'); }
  try {
    if (bootPromise) await bootPromise;
    if (!FB.auth) {
      showError('Google login is still loading. Refresh once and try again.');
      return;
    }
    try {
      const r = await FB.auth.signInWithPopup(FB.provider);
      if (await ensureSession(r.user)) showApp();
    } catch (e) {
      const message = cleanAuthError(e);
      showError(message);
      if (/popup-blocked|operation-not-supported|cancelled-popup-request/i.test(String(e?.code || '') + String(e?.message || ''))) {
        await FB.auth.signInWithRedirect(FB.provider);
      }
    }
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove('loading'); }
  }
}

async function signOut() {
  try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }); } catch {}
  try { if (FB.auth) await FB.auth.signOut(); } catch {}
  state.user = null;
  showLogin();
}

function showLogin() {
  $('#login').classList.remove('hidden');
  $('#app').classList.add('hidden');
}

function showApp() {
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  const email = state.user?.email || '—';
  $('#userEmail').textContent = email;
  const role = state.user?.role || (state.user?.isAdmin ? 'admin' : 'user');
  $('#userRole').textContent = role;
  $('#userAvatar').textContent = (email[0] || '·').toUpperCase();
  $('#envLabel').textContent = location.hostname.includes('localhost') ? 'local dev' : 'production';
  renderNav();
  renderSettingsPanel();
  router();
  refresh();
}

/* ──────────────── Nav rendering ──────────────── */
function renderNav() {
  const nav = $('#navList');
  nav.replaceChildren();
  const items = isAdminUser() ? NAV_ADMIN : (state.user?.monitorAccess ? [...NAV_DEV, NAV_MONITORING_ITEM] : NAV_DEV);
  for (const item of items) {
    const a = el('a', {
      class: 'nav-item',
      href: '#' + item.route,
      data: { view: item.route },
      'aria-current': state.view === item.route ? 'page' : null,
    },
      el('span', { class: 'nav-icon' }, icon(item.icon, 16)),
      el('span', { class: 'nav-label' }, item.label),
      el('span', { class: 'nav-count', id: navCountId(item.countKey) }),
    );
    if (state.view === item.route) a.classList.add('active');
    nav.appendChild(a);
  }
  updateNavCounts();
}
function navCountId(key) {
  if (!key) return '';
  if (key === 'incidents') return 'navIncidentsCount';
  if (key === 'users')     return 'navUsersCount';
  return '';
}
function updateNavCounts() {
  const inc = state.data.alerts.filter(a => !a.resolved && !a.resolved_at).length;
  const uEl = document.getElementById('navUsersCount');
  if (uEl) uEl.textContent = state.data.users.length || '';
  const iEl = document.getElementById('navIncidentsCount');
  if (iEl) {
    iEl.textContent = inc || '';
    iEl.classList.toggle('warn', inc > 0);
  }
}

/* ──────────────── Settings menu ──────────────── */
function renderSettingsPanel() {
  const p = $('#settingsPanel');
  p.replaceChildren();
  // Admin key (always available, used as auth fallback)
  p.append(
    el('div', { class: 'menu__title' }, 'Dev admin key'),
    el('input', { id: 'adminKeyInline', type: 'password', placeholder: 'DEV_ADMIN_KEY', autocomplete: 'off' }),
    el('p', { class: 'hint' }, 'Header-based fallback when Firebase auth is unavailable.'),
  );
  if (isAdminUser()) {
    p.append(
      el('div', { class: 'menu-divider' }),
      el('button', { class: 'menu-action', on: { click: () => { closeSettings(); openTestAsUser(); } } },
        icon('zap', 14), el('span', {}, 'Test as user…')),
      el('button', { class: 'menu-action', on: { click: () => { closeSettings(); refresh(); } } },
        icon('refresh', 14), el('span', {}, 'Refresh data')),
    );
  }
}
function openSettings() {
  $('#settingsPanel').classList.add('open');
  $('#settingsToggle').setAttribute('aria-expanded', 'true');
}
function closeSettings() {
  $('#settingsPanel').classList.remove('open');
  $('#settingsToggle').setAttribute('aria-expanded', 'false');
}

/* ─────────────── Router ──────────────── */
// The hash may carry sub-state for the active view (e.g. `#setup&setup=codex`).
// Only the first `&`-separated chunk is the route name; the rest is opaque
// state owned by the rendered view.
function parseHash(hash) {
  const raw = (hash || '').replace(/^#\/?/, '').trim();
  if (!raw) return { route: '', rest: '' };
  const [routeRaw, ...rest] = raw.split('&');
  return { route: routeRaw, rest: rest.join('&') };
}

function resolveRoute(hash) {
  const { route } = parseHash(hash);
  if (!route) return isAdminUser() ? 'health' : 'home';
  if (ROUTE_ALIASES[route]) return ROUTE_ALIASES[route]();
  if (!ROUTES[route])       return isAdminUser() ? 'health' : 'home';
  if (ROUTES[route].adminOnly && !isAdminUser()) return 'home';
  return route;
}

function router() {
  const target = resolveRoute(location.hash);
  const { rest } = parseHash(location.hash);
  const want = rest ? `#${target}&${rest}` : `#${target}`;
  if (location.hash !== want) {
    history.replaceState(null, '', want);
  }
  setView(target);
}
window.addEventListener('hashchange', router);

function setView(name) {
  state.view = name;
  const r = ROUTES[name];
  $('#viewTitle').textContent = r.title;
  $('#viewSubtitle').textContent = r.subtitle;
  // nav active state
  $$('#navList .nav-item').forEach(a => {
    const isActive = a.dataset.view === name;
    a.classList.toggle('active', isActive);
    a.setAttribute('aria-current', isActive ? 'page' : 'false');
  });
  // reset filter
  state.filters.q = '';
  const search = $('#globalSearch');
  if (search) {
    search.value = '';
    search.placeholder = `Filter ${r.title.toLowerCase()}…`;
  }
  // close mobile sidebar
  $('#sidebar')?.classList.remove('open');
  $('#sidebarBackdrop')?.classList.add('hidden');
  $('#sidebarBackdrop')?.classList.remove('show');
  render();
}

/* ──────────────── Refresh ──────────────── */
async function refresh() {
  if (state.loading) return;
  state.loading = true;
  const btn = $('#refreshBtn');
  if (btn) btn.classList.add('spinning');
  try {
    if (!isAdminUser()) {
      const [health, mine] = await Promise.allSettled([
        fetch('/health').then(r => r.json()),
        api('/api/me/summary'),
      ]);
      state.data.health = health.status === 'fulfilled' ? health.value : null;
      const m = mine.status === 'fulfilled' ? mine.value : { tokens: [], usage: [], limits: [] };
      state.data.tokens = m.tokens || [];
      state.data.myUsage = m.usage || [];
      state.data.myLimits = m.limits || [];
    } else {
      const [health, users, accts, limits, usage, alerts, audit, groq, cerebras, knownModels] = await Promise.allSettled([
        fetch('/health').then(r => r.json()),
        api('/admin/users'),
        api('/admin/provider-accounts'),
        api('/admin/limits'),
        api('/admin/usage'),
        api('/admin/alerts'),
        api('/admin/audit-logs'),
        api('/admin/groq'),
        api('/admin/cerebras'),
        api('/admin/known-models'),
      ]);
      state.data.health     = health.status === 'fulfilled' ? health.value : null;
      state.data.users      = users.status  === 'fulfilled' ? (users.value.users || []) : [];
      state.data.accounts   = accts.status  === 'fulfilled' ? (accts.value.accounts || []) : [];
      state.data.roleLimits = limits.status === 'fulfilled' ? (limits.value.roleLimits || []) : [];
      state.data.userLimits = limits.status === 'fulfilled' ? (limits.value.userLimits || []) : [];
      state.data.usage      = usage.status  === 'fulfilled' ? (usage.value.usage || []) : [];
      state.data.alerts     = alerts.status === 'fulfilled' ? (alerts.value.alerts || []) : [];
      state.data.audit      = audit.status  === 'fulfilled' ? (audit.value.logs || []) : [];
      state.data.groq       = groq.status   === 'fulfilled' ? groq.value : null;
      state.data.cerebras   = cerebras.status === 'fulfilled' ? cerebras.value : null;
      state.data.knownModels = knownModels.status === 'fulfilled' ? (knownModels.value.providers || {}) : {};

      const failed = [users, accts, limits, usage, alerts, audit].filter(p => p.status === 'rejected');
      if (failed.length === 6) {
        const first = failed[0].reason;
        if (first?.status === 401 || first?.status === 403) {
          toast('Not authorized — set the dev admin key (cog menu) or sign in.', 'error');
        } else {
          toast(first?.message || 'Failed to load admin data', 'error');
        }
      }
    }
    state.loaded = true;
    updateNavCounts();
    render();
  } finally {
    state.loading = false;
    if (btn) btn.classList.remove('spinning');
  }
}

/* ──────────────── Render entry point ──────────────── */
function render() {
  const view = $('#view');
  if (!state.loaded) {
    view.innerHTML = '<div class="view-loading"><div class="spinner"></div><span>Loading…</span></div>';
    return;
  }
  const r = ROUTES[state.view];
  view.replaceChildren();
  const out = r.render();
  if (out) view.appendChild(out);
}

/* ══════════════════════════════════════════════════════════════════
   COPY-TO-CLIPBOARD HELPER
   ══════════════════════════════════════════════════════════════════ */
function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).then(() => toast('Copied to clipboard'));
  }
  const ta = el('textarea', { value: text, style: { position: 'fixed', opacity: '0' } });
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); toast('Copied to clipboard'); }
  catch { toast('Copy failed', 'error'); }
  ta.remove();
}
function copyButton(text, label = 'Copy') {
  return el('button', {
    class: 'iconbtn copy-btn',
    title: label,
    'aria-label': label,
    on: { click: (e) => { e.stopPropagation(); copyToClipboard(text); } },
  }, icon('copy', 14));
}

/* ══════════════════════════════════════════════════════════════════
   SPARKLINE  (pure SVG)
   ══════════════════════════════════════════════════════════════════ */
function sparkline(data = [], { width = 96, height = 28, kind = 'spark' } = {}) {
  if (!data || !data.length) {
    return el('span', { class: 'kpi__spark', style: { width: width + 'px', height: height + 'px' } });
  }
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = (max - min) || 1;
  const stepX = data.length > 1 ? width / (data.length - 1) : 0;
  const pts = data.map((v, i) => {
    const x = i * stepX;
    const y = height - ((v - min) / range) * (height - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  // area path
  const areaPath = `M0,${height} L${pts.replace(/ /g, ' L')} L${(data.length - 1) * stepX},${height} Z`;
  const span = el('span', { class: `kpi__spark spark ${kind === 'spark' ? '' : 'spark--' + kind}` });
  span.innerHTML =
    `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">
       <path class="area" d="${areaPath}"/>
       <polyline points="${pts}"/>
     </svg>`;
  return span;
}

/* ══════════════════════════════════════════════════════════════════
   KPI CARD  (label + big number + delta + sparkline)
   ══════════════════════════════════════════════════════════════════ */
function kpi({ label, value, sub, delta, deltaKind, spark, iconName, sparkKind, tone }) {
  const node = el('div', { class: 'kpi' + (tone ? ' kpi--' + tone : '') },
    el('div', { class: 'kpi__label' },
      iconName ? el('span', { class: 'kpi__icon' }, icon(iconName, 14)) : null,
      el('span', {}, label),
    ),
    el('div', { class: 'kpi__row' },
      el('div', { class: 'kpi__value' }, value),
      spark ? sparkline(spark, { kind: sparkKind || 'spark', width: 80, height: 26 }) : null,
    ),
    el('div', { class: 'kpi__row' },
      delta != null ? el('span', { class: `kpi__delta ${deltaKind === 'up' ? 'kpi__delta--up' : deltaKind === 'down' ? 'kpi__delta--down' : ''}` },
        deltaKind === 'up' ? icon('arrowUp', 12) : deltaKind === 'down' ? icon('arrowDown', 12) : null,
        delta,
      ) : null,
      sub ? el('span', { class: 'kpi__sub' }, sub) : null,
    ),
  );
  return node;
}

/* ══════════════════════════════════════════════════════════════════
   PROGRESS BAR ROW
   ══════════════════════════════════════════════════════════════════ */
function progressRow({ providerKey, label, used, cap, capUnit = '$' }) {
  const pct = cap > 0 ? Math.min(used / cap, 1) : 0;
  const fillCls = pct >= 0.9 ? 'progress__fill--danger' : pct >= 0.7 ? 'progress__fill--warn' : '';
  const subText = cap > 0
    ? `${capUnit}${(used).toFixed(2)} / ${capUnit}${cap.toLocaleString()} · ${(pct * 100).toFixed(0)}%`
    : 'Unlimited';
  return el('div', { class: 'progress-row' },
    el('span', { class: 'provider-mark', data: { provider: providerKey || 'openai' } }, PROVIDER_GLYPH[providerKey] || '?'),
    el('div', { class: 'pr-meta' },
      el('div', { class: 'pr-name' }, label),
      el('div', { class: 'progress' }, el('div', { class: `progress__fill ${fillCls}`, style: { width: (pct * 100).toFixed(1) + '%' } })),
    ),
    el('div', { class: 'pr-num' }, subText),
  );
}

/* ══════════════════════════════════════════════════════════════════
   EMPTY STATE
   ══════════════════════════════════════════════════════════════════ */
function emptyState({ iconName = 'inbox', title, sub, action }) {
  return el('div', { class: 'empty' },
    el('div', { class: 'empty__art' }, icon(iconName, 24)),
    el('div', { class: 'empty__title' }, title),
    sub ? el('div', { class: 'empty__sub' }, sub) : null,
    action || null,
  );
}

/* ══════════════════════════════════════════════════════════════════
   STATUS PILL (account)
   ══════════════════════════════════════════════════════════════════ */
function statusPill(account) {
  if (account.enabled === 0 || account.enabled === false) {
    return el('span', { class: 'pill' }, el('span', { class: 'dot' }), 'disabled');
  }
  const s = account.status || 'active';
  if (s === 'cooldown') return el('span', { class: 'pill pill--warn' }, el('span', { class: 'dot' }), 'cooldown');
  // Codex rate-limits live in codex_bucket_cooldowns, not provider_accounts.status.
  if (account.provider === 'openai_codex' && account.codex_cooldown_until && account.codex_cooldown_until > Date.now()) {
    return el('span', { class: 'pill pill--warn' }, el('span', { class: 'dot' }), 'cooldown');
  }
  if (s === 'dead' || s === 'error') return el('span', { class: 'pill pill--danger' }, el('span', { class: 'dot' }), 'dead');
  return el('span', { class: 'pill pill--success' }, el('span', { class: 'dot' }), 'live');
}
function accountStatus(account) {
  if (!account.enabled) return 'off';
  if (account.status === 'cooldown') return 'cooldown';
  if (account.provider === 'openai_codex' && account.codex_cooldown_until && account.codex_cooldown_until > Date.now()) return 'cooldown';
  return (account.status === 'dead' || account.status === 'error') ? 'dead' : 'live';
}

/* ══════════════════════════════════════════════════════════════════
   CARD HELPER
   ══════════════════════════════════════════════════════════════════ */
function card({ title, sub, actions, body, flush }) {
  return el('section', { class: 'card' },
    (title || actions) ? el('div', { class: 'card__head' },
      title ? el('div', {},
        el('h2', {}, title),
        sub ? el('div', { class: 'sub' }, sub) : null,
      ) : null,
      actions ? el('div', { class: 'actions' }, actions) : null,
    ) : null,
    el('div', { class: flush ? 'card__body card__body--flush' : 'card__body' }, body),
  );
}

/* ══════════════════════════════════════════════════════════════════
   USAGE AGGREGATE HELPER
   ══════════════════════════════════════════════════════════════════ */
function aggregateUsage(rows) {
  let requests = 0, tokens = 0, usd = 0;
  for (const r of (rows || [])) {
    requests += Number(r.requests || 0);
    tokens   += Number(r.tokens || 0);
    usd      += Number(r.usd || 0);
  }
  return { requests, tokens, usd };
}

/* ══════════════════════════════════════════════════════════════════
   ▓▓▓▓▓ HEALTH PAGE  (admin) ▓▓▓▓▓
   ══════════════════════════════════════════════════════════════════ */
const COMPRESSIBLE_PROVIDERS = ['anthropic','openai','groq','cerebras','kimi','glm','gemini','openrouter','runpod','fusion','xai'];

function renderHeadroomCard() {
  const wrap = el('div', { class: 'card', id: 'headroom-settings' });

  async function load() {
    try {
      const settings = await api('/admin/headroom');
      const enabledToggle = el('input', { type: 'checkbox', checked: settings.enabled,
        on: { change: async (e) => {
          try {
            await api('/admin/headroom', { method: 'PATCH', body: JSON.stringify({ enabled: e.target.checked }) });
            toast(e.target.checked ? 'Compression enabled' : 'Compression disabled');
          } catch (err) { toast(err.message, 'error'); e.target.checked = !e.target.checked; }
        }}
      });

      const skipSet = new Set(settings.skipProviders || []);
      const providerChecks = COMPRESSIBLE_PROVIDERS.map(p => {
        const isSkipped = skipSet.has(p);
        return el('label', { class: 'row-toggle', style: { display: 'inline-flex', gap: '6px', marginRight: '14px', fontSize: '12px' } },
          el('input', { type: 'checkbox', checked: !isSkipped,
            on: { change: async (e) => {
              if (e.target.checked) skipSet.delete(p); else skipSet.add(p);
              try {
                await api('/admin/headroom', { method: 'PATCH', body: JSON.stringify({ skipProviders: [...skipSet] }) });
                toast(`${p}: compression ${e.target.checked ? 'enabled' : 'disabled'}`);
              } catch (err) { toast(err.message, 'error'); e.target.checked = !e.target.checked; }
            }}
          }),
          p,
        );
      });

      wrap.replaceChildren(
        el('div', { class: 'card__header' },
          el('div', {},
            el('div', { class: 'card__title' }, 'Context Compression (Headroom)'),
            el('div', { class: 'card__sub' }, 'Reduces LLM input tokens by 50-74%. Changes take effect immediately.'),
          ),
        ),
        el('div', { style: { padding: '12px 18px' } },
          el('div', { class: 'row-toggle', style: { marginBottom: '12px' } },
            el('div', {},
              el('div', { class: 'label' }, 'Global compression'),
              el('div', { class: 'fs-11 text-subtle' }, 'Master switch — disable to stop all compression'),
            ),
            el('label', { class: 'switch' },
              enabledToggle,
              el('span', { class: 'switch__track' }), el('span', { class: 'switch__thumb' }),
            ),
          ),
          el('div', {},
            el('div', { class: 'label', style: { marginBottom: '6px' } }, 'Providers'),
            el('div', { class: 'fs-11 text-subtle', style: { marginBottom: '8px' } }, 'Uncheck to skip compression for a provider'),
            el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px 0' } }, ...providerChecks),
          ),
        ),
      );
    } catch (e) {
      wrap.replaceChildren(el('div', { style: { padding: '12px 18px', color: 'var(--text-subtle)' } }, 'Compression settings unavailable'));
    }
  }

  load();
  return wrap;
}

function renderHealth() {
  const root = el('div', { class: 'stack stack--lg' });

  // KPI strip
  const agg = aggregateUsage(state.data.usage);
  const accts = state.data.accounts || [];
  const liveAccts = accts.filter(a => a.enabled && a.status !== 'dead' && a.status !== 'error').length;
  // pseudo-sparkline from usage rows (no time-series available; flatten)
  const sparkReq = (state.data.usage.slice(0, 12).map(r => Number(r.requests || 0))).reverse();
  const sparkUsd = (state.data.usage.slice(0, 12).map(r => Number(r.usd || 0))).reverse();

  const kpiStrip = el('div', { class: 'grid-4' },
    kpi({
      label: 'Requests · 24h',
      value: fmt.num(agg.requests),
      sub: state.data.usage.length ? `${state.data.usage.length} model/provider rows` : 'No traffic yet',
      iconName: 'activity',
      spark: sparkReq.length ? sparkReq : null,
    }),
    kpi({
      label: 'Spend · 24h',
      value: fmt.usd(agg.usd),
      sub: 'Estimated from upstream',
      iconName: 'dollar',
      spark: sparkUsd.length ? sparkUsd : null,
      sparkKind: 'spark',
    }),
    kpi({
      label: 'Tokens · 24h',
      value: fmt.num(agg.tokens),
      sub: 'Input + output + cache',
      iconName: 'hash',
    }),
    kpi({
      label: 'Active accounts',
      value: `${liveAccts}/${accts.length}`,
      sub: liveAccts < accts.length ? `${accts.length - liveAccts} not live` : 'All providers green',
      iconName: 'shield',
    }),
  );

  // Provider status grid (one card per provider)
  const providerGrid = el('div', { class: 'grid-3' },
    ...PROVIDERS.map(p => providerCard(p, accts.filter(a => a.provider === p))),
  );

  // Active incidents
  const openAlerts = (state.data.alerts || []).filter(a => !a.resolved && !a.resolved_at);
  const incidentsCard = card({
    title: 'Active incidents',
    sub: openAlerts.length ? `${openAlerts.length} open` : 'All clear',
    actions: openAlerts.length ? [
      el('button', { class: 'btn btn--ghost btn--sm', on: { click: () => bulkAckAlerts(openAlerts) } },
        icon('check', 14), 'Acknowledge all'),
    ] : null,
    flush: true,
    body: openAlerts.length
      ? el('div', { class: 'feed' }, ...openAlerts.slice(0, 8).map(a => alertFeedItem(a, true)))
      : emptyState({
          iconName: 'shield',
          title: 'No active incidents',
          sub: 'Provider accounts are healthy and there are no unacknowledged alerts.',
        }),
  });

  // Recent activity (combined audit + alerts)
  const activity = combinedActivity().slice(0, 12);
  const activityCard = card({
    title: 'Recent activity',
    sub: 'Latest admin actions and signals',
    actions: el('a', { class: 'btn btn--ghost btn--sm', href: '#audit' }, 'See all', icon('chevronR', 12)),
    flush: true,
    body: activity.length
      ? el('div', { class: 'feed' }, ...activity.map(activityFeedItem))
      : emptyState({ iconName: 'inbox', title: 'No activity yet', sub: 'Admin actions and signals will appear here.' }),
  });

  // Sticky routing card — lazy-loaded.
  const stickyHost = el('div', {}, el('div', { class: 'fs-12 text-subtle' }, 'Loading…'));
  (async () => {
    try {
      const r = await api('/admin/sticky-routing?hours=24');
      const total = r.stable + r.split;
      const pct = total > 0 ? Math.round(100 * r.stable / total) : null;
      stickyHost.replaceChildren(
        el('div', { class: 'flex gap-3 items-center' },
          el('div', { class: 'sticky-stat' },
            el('div', { class: 'fs-26 fw-700' }, pct == null ? '—' : pct + '%'),
            el('div', { class: 'fs-12 text-subtle' }, 'sticky stable (24h)'),
          ),
          el('div', { class: 'fs-12 text-subtle' },
            `${r.stable} session-key${r.stable === 1 ? '' : 's'} pinned to one account, ${r.split} split across multiple accounts.`,
          ),
        ),
        r.sessions.length
          ? el('div', { class: 'table-wrap mt-3' },
              el('table', { class: 'tbl' },
                el('thead', {}, el('tr', {},
                  el('th', {}, 'User'),
                  el('th', {}, 'Token'),
                  el('th', {}, 'Provider'),
                  el('th', { class: 'right' }, 'Reqs'),
                  el('th', {}, 'Accounts'),
                )),
                el('tbody', {}, ...r.sessions.slice(0, 10).map(s => el('tr', {},
                  el('td', { class: 'mono fs-12' }, s.email || `#${s.user_id}`),
                  el('td', { class: 'fs-12' }, s.token_label || `#${s.token_id}`),
                  el('td', {}, PROVIDER_LABEL[s.provider] || s.provider),
                  el('td', { class: 'right num fs-12' }, s.requests),
                  el('td', { class: 'fs-12' },
                    s.distinct_accounts > 1
                      ? el('span', { class: 'pill pill--warn' }, `${s.distinct_accounts}: ${s.accounts}`)
                      : el('span', { class: 'pill pill--success' }, s.accounts || '—')),
                ))),
              ),
            )
          : el('div', { class: 'fs-12 text-subtle mt-2' }, 'No multi-request sessions in the last 24h.'),
      );
    } catch (e) {
      stickyHost.replaceChildren(el('div', { class: 'fs-12 text-subtle' }, `Sticky routing unavailable: ${e.message}`));
    }
  })();
  const stickyCard = card({
    title: 'Sticky routing',
    sub: 'A session-key (user + token + provider) should land on the same upstream account each time. Splits hint at pool changes or cooldowns.',
    flush: true,
    body: el('div', { style: { padding: '12px 18px 18px' } }, stickyHost),
  });

  // Headroom compression settings card
  const headroomCard = renderHeadroomCard();

  root.append(kpiStrip, providerGrid, headroomCard, incidentsCard, stickyCard, activityCard);
  return root;
}

function providerCard(providerKey, accounts) {
  const live = accounts.filter(a => a.enabled && a.status !== 'dead' && a.status !== 'error').length;
  const down = accounts.filter(a => a.status === 'dead' || a.status === 'error').length;
  const cool = accounts.filter(a => a.status === 'cooldown').length;
  const sub = accounts.length === 0
    ? 'No accounts configured'
    : `${live} live${cool ? ' · ' + cool + ' cooldown' : ''}${down ? ' · ' + down + ' down' : ''}`;
  const subClass = down ? 'pill pill--danger' : cool ? 'pill pill--warn' : 'pill pill--success';
  const head = el('div', { class: 'provider-card__head' },
    el('span', { class: 'provider-mark', data: { provider: providerKey } }, PROVIDER_GLYPH[providerKey]),
    el('div', {},
      el('div', { class: 'title' }, PROVIDER_LABEL[providerKey]),
      el('div', { class: 'meta' }, `${accounts.length} account${accounts.length === 1 ? '' : 's'}`),
    ),
    el('div', { class: 'spacer' }),
    accounts.length ? el('span', { class: subClass }, sub) : null,
    el('button', {
      class: 'iconbtn', title: 'Add account', 'aria-label': `Add ${PROVIDER_LABEL[providerKey]} account`,
      on: { click: () => openAddAccount(providerKey) },
    }, icon('plus', 16)),
  );
  const body = accounts.length
    ? el('div', { class: 'provider-card__body' },
        ...accounts.map(a => accountRow(a)),
      )
    : el('div', { class: 'card__body' },
        emptyState({
          iconName: 'key',
          title: `No ${PROVIDER_LABEL[providerKey]} accounts`,
          sub: 'Add one to start routing requests through this provider.',
          action: el('button', { class: 'btn btn--primary btn--sm', on: { click: () => openAddAccount(providerKey) } },
            icon('plus', 14), 'Add account'),
        }),
      );
  return el('section', { class: 'provider-card' }, head, body);
}

function accountRow(a) {
  const lastUsed = a.last_used_at ? fmt.ago(a.last_used_at) : 'never';
  const lastQuota = a.last_quota_check ? fmt.ago(a.last_quota_check) : 'never';
  const subParts = [
    `${Number(a.live_in_flight ?? a.in_flight ?? 0)}/${a.max_in_flight ?? '∞'} in-flight`,
    `last used ${lastUsed}`,
    `quota ${lastQuota}`,
  ];
  return el('div', {
    class: 'acct-row',
    role: 'button',
    tabindex: '0',
    on: {
      click: () => openAccountDrawer(a),
      keydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openAccountDrawer(a); } },
    },
  },
    el('span', { class: 'acct-row__dot', data: { status: accountStatus(a) } }),
    el('div', { class: 'acct-row__main' },
      el('div', { class: 'acct-row__name' }, a.label || `(unnamed ${a.id})`),
      el('div', { class: 'acct-row__sub' }, subParts.join(' · ')),
    ),
    el('div', { class: 'acct-row__meta' },
      statusPill(a),
      icon('chevronR', 14),
    ),
  );
}

/* ──── Activity feed helpers ──── */
function alertFeedItem(a, withActions) {
  const sev = (a.level || a.severity || 'info').toLowerCase();
  const type = a.type || a.kind || a.source || 'alert';
  const isOpen = !a.resolved && !a.resolved_at;
  return el('div', { class: 'feed-item', data: { sev: sev === 'error' || sev === 'critical' ? 'error' : sev === 'warn' || sev === 'warning' ? 'warn' : 'info' } },
    el('span', { class: 'feed-item__dot' }),
    el('div', { style: { flex: '1 1 auto' } },
      el('div', { class: 'feed-item__title' }, a.message || `${type} alert`),
      el('div', { class: 'feed-item__sub' }, [
        type,
        a.target_id != null ? `target ${formatAuditTargetId(a.target_type, a.target_id)}` : null,
      ].filter(Boolean).join(' · ')),
    ),
    el('div', { class: 'flex items-center gap-2' },
      el('div', { class: 'feed-item__time' }, fmt.ago(a.created_at)),
      withActions && isOpen
        ? el('button', { class: 'btn btn--ghost btn--sm', title: 'Mark resolved', on: { click: (e) => { e.stopPropagation(); resolveAlert(a.id); } } }, icon('check', 12))
        : null,
    ),
  );
}
function activityFeedItem(item) {
  if (item.kind === 'alert') return alertFeedItem(item.row);
  // audit
  const a = item.row;
  return el('div', { class: 'feed-item', data: { sev: 'info' } },
    el('span', { class: 'feed-item__dot' }),
    el('div', {},
      el('div', { class: 'feed-item__title' }, `${a.action || 'action'}${a.target_type ? ' · ' + a.target_type : ''}`),
      el('div', { class: 'feed-item__sub' }, [
        a.actor_email || (a.actor_user_id ? 'user ' + a.actor_user_id : 'system'),
        a.target_id != null ? formatAuditTargetId(a.target_type, a.target_id) : null,
      ].filter(Boolean).join(' · ')),
    ),
    el('div', { class: 'feed-item__time' }, fmt.ago(a.created_at)),
  );
}
function combinedActivity() {
  const audit = (state.data.audit || []).map(a => ({ kind: 'audit', ts: new Date(a.created_at).getTime(), row: a }));
  const alerts = (state.data.alerts || []).map(a => ({ kind: 'alert', ts: new Date(a.created_at).getTime(), row: a }));
  return [...audit, ...alerts].sort((a, b) => b.ts - a.ts);
}
async function bulkAckAlerts(_alerts) {
  if (!await confirmDialog({ title: 'Resolve all alerts?', message: 'Mark every open alert as resolved.', confirmLabel: 'Resolve all' })) return;
  try {
    const r = await api('/admin/alerts/resolve-all', { method: 'POST' });
    toast(`Resolved ${r.resolved || 0} alert${r.resolved === 1 ? '' : 's'}`);
    refresh();
  } catch (e) { toast(e.message, 'error'); }
}
async function resolveAlert(id) {
  try {
    await api(`/admin/alerts/${id}`, { method: 'PATCH', body: JSON.stringify({ resolved: true }) });
    toast('Alert resolved');
    refresh();
  } catch (e) { toast(e.message, 'error'); }
}

/* ══════════════════════════════════════════════════════════════════
   ACCOUNT DRAWERS
   ══════════════════════════════════════════════════════════════════ */
async function openAccountDrawer(a) {
  let secretShown = false;
  let secretValue = null;
  let editLabel = a.label || '';
  let editEnabled = !!a.enabled;
  let editMaxInFlight = a.max_in_flight ?? '';
  let editStatus = a.status || 'active';
  let editNotes = a.notes || '';
  let editRiskNotes = a.risk_notes || '';
  let editQuotaNotes = a.quota_notes || '';

  const secretRow = el('div', { class: 'field' },
    el('label', { class: 'field-label' }, 'Secret'),
    el('div', { class: 'row' },
      el('div', { class: 'code', style: { flex: '1', minHeight: '38px', padding: '8px 12px' }, id: 'secretReveal' }, '••••••••••••••••'),
      el('button', { class: 'btn btn--ghost btn--sm', id: 'revealBtn', on: { click: revealSecret } }, icon('eye', 14), 'Reveal'),
    ),
    el('p', { class: 'field-hint' }, 'Click reveal to fetch and copy the upstream key/token.'),
  );

  async function revealSecret() {
    if (secretShown && secretValue) {
      copyToClipboard(secretValue);
      return;
    }
    try {
      const r = await api(`/admin/provider-accounts/${a.id}/secret`);
      secretValue = r.secret || '';
      secretShown = true;
      $('#secretReveal').textContent = secretValue;
      $('#revealBtn').replaceChildren(icon('copy', 14), document.createTextNode('Copy'));
    } catch (e) { toast(e.message, 'error'); }
  }

  const body = el('div', { class: 'field-group' },
    el('div', { class: 'row' },
      el('span', { class: 'provider-mark', data: { provider: a.provider } }, PROVIDER_GLYPH[a.provider]),
      el('div', {},
        el('div', { class: 'fw-600' }, PROVIDER_LABEL[a.provider]),
        el('div', { class: 'fs-12 text-subtle' }, 'Provider account'),
      ),
      el('div', { class: 'spacer' }),
      statusPill(a),
    ),
    el('div', { class: 'field-row' },
      el('div', { class: 'field' },
        el('label', { class: 'field-label' }, 'Label'),
        el('input', { id: 'acct_label', value: editLabel, on: { input: (e) => editLabel = e.target.value } }),
      ),
      el('div', { class: 'field' },
        el('label', { class: 'field-label' }, 'Max in-flight'),
        el('input', { id: 'acct_mif', type: 'number', value: editMaxInFlight, placeholder: 'unbounded', on: { input: (e) => editMaxInFlight = e.target.value } }),
      ),
    ),
    el('div', { class: 'field-row' },
      el('div', { class: 'field' },
        el('label', { class: 'field-label' }, 'Status'),
        el('select', { id: 'acct_status', on: { change: (e) => editStatus = e.target.value } },
          ...['active', 'cooldown', 'dead', 'error'].map(s =>
            el('option', { value: s, selected: editStatus === s ? 'selected' : null }, s)),
        ),
      ),
      el('div', { class: 'field' },
        el('label', { class: 'field-label' }, 'Enabled'),
        el('label', { class: 'switch' },
          el('input', { type: 'checkbox', id: 'acct_enabled', checked: editEnabled, on: { change: (e) => editEnabled = e.target.checked } }),
          el('span', { class: 'switch__track' }),
          el('span', { class: 'switch__thumb' }),
        ),
      ),
    ),
    secretRow,
    a.provider === 'groq' ? providerModelLimitsPanel(a, 'groq', 'openai/gpt-oss-120b') : null,
    a.provider === 'cerebras' ? providerModelLimitsPanel(a, 'cerebras', 'gpt-oss-120b') : null,
    el('div', { class: 'field' },
      el('label', { class: 'field-label' }, 'Notes'),
      el('textarea', { id: 'acct_notes', placeholder: 'Operator notes…', on: { input: (e) => editNotes = e.target.value } }, editNotes),
    ),
    el('div', { class: 'field-row' },
      el('div', { class: 'field' },
        el('label', { class: 'field-label' }, 'Risk notes'),
        el('textarea', { rows: 2, on: { input: (e) => editRiskNotes = e.target.value } }, editRiskNotes),
      ),
      el('div', { class: 'field' },
        el('label', { class: 'field-label' }, 'Quota notes'),
        el('textarea', { rows: 2, on: { input: (e) => editQuotaNotes = e.target.value } }, editQuotaNotes),
      ),
    ),
    el('div', { class: 'flex flex-col gap-2' },
      el('div', { class: 'fs-12 text-subtle' }, [
        a.account_id ? `id ${a.account_id}` : null,
        `created ${fmt.date(a.created_at)}`,
        a.last_used_at ? `last used ${fmt.ago(a.last_used_at)}` : null,
        a.last_quota_check ? `last quota ${fmt.ago(a.last_quota_check)}` : null,
        a.cooldown_until ? `cooldown until ${fmt.date(a.cooldown_until)}` : null,
        (a.codex_cooldown_until && a.codex_cooldown_until > Date.now()) ? `codex cooldown until ${fmt.date(a.codex_cooldown_until)}${(a.codex_bucket_cooldowns && a.codex_bucket_cooldowns[0] && a.codex_bucket_cooldowns[0].reason) ? ' (' + a.codex_bucket_cooldowns[0].reason + ')' : ''}` : null,
        a.last_event_status ? `last incident ${a.last_event_status}${a.last_event_reason ? ': ' + a.last_event_reason : ''} (${fmt.ago(a.last_event_at)})` : null,
        a.owner_email ? `owner ${a.owner_email}` : null,
        Number.isFinite(a.live_in_flight) ? `${a.live_in_flight} in flight (live)` : null,
      ].filter(Boolean).join(' · ')),
    ),
    el('div', { class: 'field' },
      el('label', { class: 'field-label' }, 'Recent incidents'),
      el('div', { id: 'acct_events', class: 'feed' }, el('div', { class: 'fs-12 text-subtle' }, 'Loading…')),
    ),
  );

  // Lazy-load health events (fire and forget).
  (async () => {
    try {
      const r = await api(`/admin/provider-accounts/${a.id}/events`);
      const host = $('#acct_events');
      if (!host) return;
      const events = (r.events || []);
      if (!events.length) {
        host.replaceChildren(el('div', { class: 'fs-12 text-subtle' }, 'No incidents recorded.'));
        return;
      }
      host.replaceChildren(...events.slice(0, 10).map(ev =>
        el('div', { class: 'feed-item', data: { sev: ev.status === 'dead' || ev.status === 'invalid' ? 'error' : ev.status === 'cooldown' || ev.status === 'rate_limited' ? 'warn' : 'info' } },
          el('span', { class: 'feed-item__dot' }),
          el('div', { style: { flex: '1 1 auto' } },
            el('div', { class: 'feed-item__title' }, ev.status + (ev.reason ? ' · ' + ev.reason : '')),
            ev.detail ? el('div', { class: 'feed-item__sub mono fs-12' }, String(ev.detail).slice(0, 200)) : null,
          ),
          el('div', { class: 'feed-item__time' }, fmt.ago(ev.created_at)),
        ),
      ));
    } catch {/* drawer can stay open without events */}
  })();

  const footer = el('div', { class: 'flex gap-2', style: { width: '100%' } },
    el('button', { class: 'btn btn--ghost btn--sm', on: { click: runQuotaProbe } },
      icon('zap', 14), 'Run quota probe'),
    a.provider === 'openai_codex'
      ? el('button', { class: 'btn btn--ghost btn--sm', on: { click: clearCodexCooldowns } }, 'Clear cooldowns')
      : null,
    el('button', { class: 'btn btn--danger btn--sm', on: { click: deleteAccount } },
      icon('trash', 14), 'Delete'),
    el('div', { class: 'spacer' }),
    el('button', { class: 'btn btn--ghost', on: { click: () => d.close() } }, 'Cancel'),
    el('button', { class: 'btn btn--primary', on: { click: saveAccount } },
      icon('check', 14), 'Save'),
  );

  const d = drawer({
    title: a.label || 'Account',
    subtitle: `${PROVIDER_LABEL[a.provider]} · #${a.id}`,
    body, footer,
  });

  async function saveAccount() {
    try {
      const payload = {
        enabled: !!editEnabled,
        status: editStatus,
        maxInFlight: editMaxInFlight === '' ? null : Number(editMaxInFlight),
        notes: editNotes,
        riskNotes: editRiskNotes,
        quotaNotes: editQuotaNotes,
      };
      await api(`/admin/provider-accounts/${a.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      // Note: label change isn't supported by PATCH endpoint as of writing — we omit it from payload to be safe.
      toast('Account updated');
      d.close();
      refresh();
    } catch (e) { toast(e.message, 'error'); }
  }
  async function clearCodexCooldowns() {
    try {
      const r = await api(`/admin/codex/${a.id}/clear-cooldowns`, { method: 'POST' });
      toast(`Cleared ${r.clearedBucketCooldowns ?? 0} Codex cooldown(s). Note: upstream quota is not reset.`);
      d.close();
      refresh();
    } catch (e) { toast(e.message, 'error'); }
  }
  async function runQuotaProbe() {
    try {
      const r = await api(`/admin/provider-accounts/${a.id}/quota`, { method: 'POST' });
      toast(r.message || `Quota probed (HTTP ${r.httpStatus || 'OK'})`);
      d.close();
      refresh();
    } catch (e) { toast(e.message, 'error'); }
  }
  async function deleteAccount() {
    const ok = await confirmDialog({
      title: 'Delete account?',
      message: `This will remove "${a.label || a.id}" from ${PROVIDER_LABEL[a.provider]}. The upstream key/token is not invalidated, only forgotten by the gateway.`,
      danger: true, confirmLabel: 'Delete',
    });
    if (!ok) return;
    try {
      await api(`/admin/provider-accounts/${a.id}`, { method: 'DELETE' });
      toast('Account deleted');
      d.close();
      refresh();
    } catch (e) { toast(e.message, 'error'); }
  }
}

function providerModelLimitsPanel(a, provider, defaultModel) {
  const providerState = state.data[provider] || { accounts: [] };
  const label = PROVIDER_LABEL[provider] || provider;
  const account = (providerState.accounts || []).find(x => x.id === a.id) || {};
  const counters = account.counters || [];
  let model = defaultModel, rpm = '', rpd = '', tpm = '', tpd = '';
  const pct = (used, cap) => cap ? `${Math.round(100 * Number(used || 0) / Number(cap))}%` : '—';
  return el('div', { class: 'field' },
    el('label', { class: 'field-label' }, `${label} per-model limits`),
    counters.length ? el('div', { class: 'table-wrap mb-2' },
      el('table', { class: 'tbl' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Model'), el('th', {}, 'RPM'), el('th', {}, 'RPD'), el('th', {}, 'TPM'), el('th', {}, 'TPD'))),
        el('tbody', {}, ...counters.map(c => el('tr', {},
          el('td', { class: 'mono fs-12' }, c.model),
          el('td', {}, `${c.minuteRequests}/${c.limit?.rpm ?? '∞'} (${pct(c.minuteRequests, c.limit?.rpm)})`),
          el('td', {}, `${c.dayRequests}/${c.limit?.rpd ?? '∞'} (${pct(c.dayRequests, c.limit?.rpd)})`),
          el('td', {}, `${c.minuteTokens}/${c.limit?.tpm ?? '∞'} (${pct(c.minuteTokens, c.limit?.tpm)})`),
          el('td', {}, `${c.dayTokens}/${c.limit?.tpd ?? '∞'} (${pct(c.dayTokens, c.limit?.tpd)})`),
        ))),
      ),
    ) : el('p', { class: 'field-hint' }, 'No model counters or limits yet.'),
    el('div', { class: 'field-row' },
      el('input', { placeholder: 'model', value: model, on: { input: e => model = e.target.value } }),
      el('input', { placeholder: 'rpm', type: 'number', on: { input: e => rpm = e.target.value } }),
      el('input', { placeholder: 'rpd', type: 'number', on: { input: e => rpd = e.target.value } }),
      el('input', { placeholder: 'tpm', type: 'number', on: { input: e => tpm = e.target.value } }),
      el('input', { placeholder: 'tpd', type: 'number', on: { input: e => tpd = e.target.value } }),
    ),
    el('div', { class: 'flex gap-2 mt-2' },
      el('button', { class: 'btn btn--ghost btn--sm', on: { click: async () => {
        await api(`/admin/${provider}/${a.id}/limits`, { method: 'PUT', body: JSON.stringify({ model, rpm: rpm ? Number(rpm) : null, rpd: rpd ? Number(rpd) : null, tpm: tpm ? Number(tpm) : null, tpd: tpd ? Number(tpd) : null }) });
        toast(`${label} limits saved`); refresh();
      } } }, icon('check', 14), 'Save limits'),
      el('button', { class: 'btn btn--ghost btn--sm', on: { click: async () => { await api(`/admin/${provider}/${a.id}/clear-cooldowns`, { method: 'POST' }); toast(`${label} cooldowns cleared`); refresh(); } } }, 'Clear cooldowns'),
    ),
  );
}

function openAddAccount(providerHint) {
  // Picker drawer
  const body = el('div', { class: 'stack' },
    el('p', { class: 'text-muted' }, 'Pick how this account authenticates with the upstream provider.'),
    el('button', {
      class: 'card', style: { textAlign: 'left', width: '100%' },
      on: { click: () => { d.close(); openAddAccountApiKey(providerHint); } },
    },
      el('div', { class: 'card__body row' },
        el('span', { class: 'provider-mark', data: { provider: providerHint || 'openai' } }, icon('key', 14)),
        el('div', {},
          el('div', { class: 'fw-600' }, 'API key'),
          el('div', { class: 'fs-12 text-subtle' }, 'Anthropic, OpenAI, or Codex with a static key.'),
        ),
        el('div', { class: 'spacer' }),
        icon('chevronR', 14),
      )),
    el('button', {
      class: 'card', style: { textAlign: 'left', width: '100%' },
      on: { click: () => { d.close(); openAddAccountOAuth(); } },
    },
      el('div', { class: 'card__body row' },
        el('span', { class: 'provider-mark', data: { provider: 'openai_codex' } }, icon('link', 14)),
        el('div', {},
          el('div', { class: 'fw-600' }, 'Codex OAuth'),
          el('div', { class: 'fs-12 text-subtle' }, 'Sign-in flow with copy-paste authorization code.'),
        ),
        el('div', { class: 'spacer' }),
        icon('chevronR', 14),
      )),
  );
  const d = drawer({ title: 'Add provider account', subtitle: 'Choose authentication method', body });
}

function openAddAccountApiKey(providerHint) {
  let provider = providerHint || 'anthropic';
  let label = '', ownerEmail = '', secret = '', refreshSecret = '', maxInFlight = '', notes = '';

  const body = el('div', { class: 'field-group' },
    el('div', { class: 'field' },
      el('label', { class: 'field-label' }, 'Provider'),
      el('select', { on: { change: (e) => provider = e.target.value } },
        ...PROVIDERS.map(p => el('option', { value: p, selected: p === provider ? 'selected' : null }, PROVIDER_LABEL[p])),
      ),
    ),
    el('div', { class: 'field-row' },
      el('div', { class: 'field' },
        el('label', { class: 'field-label' }, 'Label'),
        el('input', { placeholder: 'e.g. primary-account', on: { input: (e) => label = e.target.value } }),
      ),
      el('div', { class: 'field' },
        el('label', { class: 'field-label' }, 'Owner email (optional)'),
        el('input', { type: 'email', placeholder: 'who owns this key?', on: { input: (e) => ownerEmail = e.target.value } }),
      ),
    ),
    el('div', { class: 'field' },
      el('label', { class: 'field-label' }, 'Secret · API key or access token'),
      el('textarea', { rows: 3, placeholder: 'sk-...', on: { input: (e) => secret = e.target.value } }),
    ),
    el('div', { class: 'field' },
      el('label', { class: 'field-label' }, 'Refresh token (optional, Codex)'),
      el('textarea', { rows: 2, placeholder: 'Refresh token if applicable', on: { input: (e) => refreshSecret = e.target.value } }),
    ),
    el('div', { class: 'field-row' },
      el('div', { class: 'field' },
        el('label', { class: 'field-label' }, 'Max in-flight (optional)'),
        el('input', { type: 'number', placeholder: 'e.g. 50', on: { input: (e) => maxInFlight = e.target.value } }),
      ),
      el('div', { class: 'field' },
        el('label', { class: 'field-label' }, 'Notes'),
        el('input', { placeholder: 'optional', on: { input: (e) => notes = e.target.value } }),
      ),
    ),
  );
  const footer = el('div', { class: 'flex gap-2', style: { width: '100%' } },
    el('div', { class: 'spacer' }),
    el('button', { class: 'btn btn--ghost', on: { click: () => d.close() } }, 'Cancel'),
    el('button', { class: 'btn btn--primary', on: { click: submit } }, icon('plus', 14), 'Add account'),
  );

  async function submit() {
    if (!label.trim()) return toast('Label is required', 'error');
    if (!secret.trim()) return toast('Secret is required', 'error');
    try {
      await api('/admin/provider-accounts', {
        method: 'POST',
        body: JSON.stringify({
          provider, label: label.trim(),
          ownerEmail: ownerEmail.trim() || null,
          secret: secret.trim(),
          refreshSecret: refreshSecret.trim() || null,
          maxInFlight: maxInFlight === '' ? null : Number(maxInFlight),
          notes: notes.trim() || null,
        }),
      });
      toast('Account added');
      d.close();
      refresh();
    } catch (e) { toast(e.message, 'error'); }
  }
  const d = drawer({ title: 'Add API-key account', subtitle: 'Static key or access token', body, footer });
}

function openAddAccountOAuth() {
  let label = 'codex', emailHint = '';
  let authUrl = null, oauthState = null;
  let code = '';

  const stepStart = el('div', { class: 'field-group' },
    el('p', { class: 'text-muted' }, 'Codex requires an OAuth round-trip. We\'ll generate an authorization URL — open it in a new tab, sign in, then paste the code back here.'),
    el('div', { class: 'field-row' },
      el('div', { class: 'field' },
        el('label', { class: 'field-label' }, 'Label'),
        el('input', { value: label, on: { input: (e) => label = e.target.value } }),
      ),
      el('div', { class: 'field' },
        el('label', { class: 'field-label' }, 'Email hint (optional)'),
        el('input', { type: 'email', placeholder: 'pre-fill the OpenAI sign-in', on: { input: (e) => emailHint = e.target.value } }),
      ),
    ),
  );
  const stepCode = el('div', { class: 'field-group hidden' },
    el('div', { class: 'alert alert--info' }, icon('external', 14),
      el('div', {},
        el('div', { class: 'fw-600' }, 'Authorize in another tab'),
        el('div', { class: 'fs-12 mt-1' }, 'Use the link below, sign in, then paste the resulting code.'),
      ),
    ),
    el('div', { class: 'field' },
      el('label', { class: 'field-label' }, 'Authorization URL'),
      el('div', { class: 'code', id: 'oauthUrl' }, '—'),
      el('div', { class: 'flex gap-2 mt-2' },
        el('button', { class: 'btn btn--ghost btn--sm', on: { click: () => copyToClipboard(authUrl || '') } },
          icon('copy', 14), 'Copy URL'),
        el('a', { class: 'btn btn--ghost btn--sm', href: '#', target: '_blank', id: 'oauthOpen' },
          icon('external', 14), 'Open in new tab'),
      ),
    ),
    el('div', { class: 'field' },
      el('label', { class: 'field-label' }, 'Authorization code'),
      el('input', { id: 'oauthCode', placeholder: 'Paste the code you received', on: { input: (e) => code = e.target.value } }),
    ),
  );

  const body = el('div', {}, stepStart, stepCode);
  let onPrimary = startFlow;
  let primaryLabel = 'Generate URL';
  let primaryIcon = 'link';

  const primaryBtn = el('button', { class: 'btn btn--primary', on: { click: () => onPrimary() } }, icon(primaryIcon, 14), primaryLabel);
  const footer = el('div', { class: 'flex gap-2', style: { width: '100%' } },
    el('div', { class: 'spacer' }),
    el('button', { class: 'btn btn--ghost', on: { click: () => d.close() } }, 'Cancel'),
    primaryBtn,
  );

  async function startFlow() {
    try {
      const r = await api('/admin/provider-accounts/codex/oauth/start', {
        method: 'POST',
        body: JSON.stringify({ label, emailHint: emailHint || null }),
      });
      authUrl = r.authUrl; oauthState = r.state;
      stepStart.classList.add('hidden');
      stepCode.classList.remove('hidden');
      $('#oauthUrl').textContent = authUrl || '—';
      $('#oauthOpen').setAttribute('href', authUrl || '#');
      onPrimary = exchange;
      primaryBtn.replaceChildren(icon('check', 14), document.createTextNode('Complete'));
    } catch (e) { toast(e.message, 'error'); }
  }
  async function exchange() {
    if (!code.trim()) return toast('Paste the authorization code', 'error');
    try {
      await api('/admin/provider-accounts/codex/oauth/callback', {
        method: 'POST',
        body: JSON.stringify({ code: code.trim(), state: oauthState, label, email: emailHint || null }),
      });
      toast('Codex account added');
      d.close();
      refresh();
    } catch (e) { toast(e.message, 'error'); }
  }

  const d = drawer({ title: 'Add Codex account · OAuth', subtitle: 'Two-step authorization', body, footer });
}

/* ══════════════════════════════════════════════════════════════════
   ▓▓▓▓▓ IDENTITY PAGE  (admin: users + limits) ▓▓▓▓▓
   ══════════════════════════════════════════════════════════════════ */
function renderIdentity() {
  const root = el('div', { class: 'stack stack--lg' });
  root.append(roleDefaultsSection(), usersSection());
  return root;
}

// Roles whose usage is intentionally never rate-limited (matches src/proxy/policy.ts isFounder()).
const UNLIMITED_ROLES = new Set(['admin', 'founder']);

function roleDefaultsSection() {
  const CAPPED_ROLES = ['developer', 'member'];
  // Width of the grid scales with the number of providers we expose.
  // CSS custom property is set via raw style attribute so it survives
  // Object.assign(node.style, ...) which doesn't write `--*` keys.
  const grid = el('div', { class: 'role-grid', style: `--role-cols: ${PROVIDERS.length}` },
    el('div', { class: 'head' }, 'Role'),
    ...PROVIDERS.map(p => el('div', { class: 'head role' },
      el('span', { class: 'provider-mark', data: { provider: p } }, PROVIDER_GLYPH[p]),
      el('span', {}, PROVIDER_LABEL[p]),
    )),
  );
  for (const role of CAPPED_ROLES) {
    grid.appendChild(el('div', {}, el('span', { class: 'role-chip', data: { role } }, role)));
    for (const provider of PROVIDERS) {
      const lim = state.data.roleLimits.find(l => l.role === role && l.provider === provider);
      const usd = lim?.daily_usd ?? '';
      const tokens = lim?.daily_tokens ?? '';
      const cell = el('div', { class: 'flex flex-col gap-1' },
        el('div', { class: 'currency-affix' },
          el('span', {}, '$/d'),
          el('input', { type: 'number', value: usd, placeholder: 'unlimited', 'aria-label': `${role} ${PROVIDER_LABEL[provider]} daily $`, on: { change: (e) => saveRoleLimit(role, provider, { dailyUsd: e.target.value, dailyTokens: tokens }) } }),
        ),
        el('div', { class: 'currency-affix' },
          el('span', {}, 'tok/d'),
          el('input', { type: 'number', value: tokens, placeholder: 'unlimited', 'aria-label': `${role} ${PROVIDER_LABEL[provider]} daily tokens`, on: { change: (e) => saveRoleLimit(role, provider, { dailyUsd: usd, dailyTokens: e.target.value }) } }),
        ),
      );
      grid.appendChild(cell);
    }
  }
  // Render founder/admin as locked unlimited rows so it's clear they bypass caps.
  for (const role of ['founder', 'admin']) {
    grid.appendChild(el('div', {}, el('span', { class: 'role-chip', data: { role } }, role)));
    for (const _provider of PROVIDERS) {
      grid.appendChild(el('div', { class: 'role-cell role-cell--unlimited', title: `${role}s bypass usage caps by policy` },
        el('span', { class: 'pill pill--success' }, 'unlimited'),
      ));
    }
  }
  return card({
    title: 'Role defaults',
    sub: 'Daily caps per role × provider for capped roles. Founder and admin are unlimited by policy. Per-user overrides take precedence for capped roles.',
    flush: true,
    body: el('div', { style: { padding: '8px' } }, grid),
  });
}

async function saveRoleLimit(role, provider, { dailyUsd, dailyTokens }) {
  const payload = {
    role, provider,
    dailyUsd: dailyUsd === '' || dailyUsd == null ? null : Number(dailyUsd),
    dailyTokens: dailyTokens === '' || dailyTokens == null ? null : Number(dailyTokens),
  };
  try {
    await api('/admin/limits/role', { method: 'PUT', body: JSON.stringify(payload) });
    toast(`${role}/${PROVIDER_LABEL[provider]} limits saved`);
    refresh();
  } catch (e) { toast(e.message, 'error'); }
}

function usersSection() {
  const q = (state.filters.q || '').toLowerCase();
  const users = (state.data.users || [])
    .filter(u => !q || (u.email || '').toLowerCase().includes(q) || (u.role || '').toLowerCase().includes(q));

  const tbl = el('div', { class: 'table-wrap' },
    el('table', { class: 'tbl tbl-collapse' },
      el('thead', {},
        el('tr', {},
          el('th', {}, 'Email'),
          el('th', {}, 'Role'),
          el('th', {}, 'Status'),
          el('th', {}, 'Last seen'),
          el('th', { class: 'right' }, 'Actions'),
        )),
      el('tbody', {},
        ...(users.length ? users.map(userRow) : [
          el('tr', { class: 'empty-row' }, el('td', { colspan: 5 },
            el('div', { class: 'empty' },
              el('div', { class: 'empty__art' }, icon('users', 24)),
              el('div', { class: 'empty__title' }, 'No users yet'),
              el('div', { class: 'empty__sub' }, 'Add your first user to issue them a token.'),
              el('button', { class: 'btn btn--primary', on: { click: () => openCreateUser() } }, icon('plus', 14), 'Create user'),
            )))]),
      ),
    ),
  );

  return card({
    title: 'Users',
    sub: `${state.data.users.length} total`,
    actions: el('button', { class: 'btn btn--primary btn--sm', on: { click: () => openCreateUser() } }, icon('plus', 14), 'New user'),
    flush: true,
    body: tbl,
  });
}

function userRow(u) {
  const grantBadge = (u.activeGrantCount || 0) > 0
    ? el('span', { class: 'pill pill--info grant-badge', title: `${u.activeGrantCount} active grant${u.activeGrantCount === 1 ? '' : 's'}` },
        icon('zap', 11), `${u.activeGrantCount} grant${u.activeGrantCount === 1 ? '' : 's'}`)
    : null;
  const denyBadge = (u.deniedModelCount || 0) > 0
    ? el('span', { class: 'pill pill--warn', title: `${u.deniedModelCount} model denies` }, `${u.deniedModelCount} denies`)
    : null;
  return el('tr', { class: 'clickable', on: { click: () => openUserDrawer(u) } },
    el('td', { data: { label: 'Email' } },
      el('div', { class: 'flex flex-col' },
        el('span', { class: 'fw-500' }, u.email || '—'),
        el('div', { class: 'flex gap-1 items-center' },
          u.isAdmin ? el('span', { class: 'fs-11 text-subtle' }, 'admin') : null,
          grantBadge,
          denyBadge,
        ),
      ),
    ),
    el('td', { data: { label: 'Role' } }, el('span', { class: 'role-chip', data: { role: u.role || 'member' } }, u.role || 'member')),
    el('td', { data: { label: 'Status' } }, u.enabled
      ? el('span', { class: 'pill pill--success' }, el('span', { class: 'dot' }), 'enabled')
      : el('span', { class: 'pill' }, el('span', { class: 'dot' }), 'disabled')),
    el('td', { data: { label: 'Last seen' }, class: 'fs-12 text-muted' }, fmt.ago(u.last_seen_at || u.lastAccessAt || u.created_at)),
    el('td', { class: 'actions-cell', data: { label: 'Actions' } },
      el('button', { class: 'iconbtn', title: 'Open', 'aria-label': 'Open user', on: { click: (e) => { e.stopPropagation(); openUserDrawer(u); } } }, icon('chevronR', 14)),
    ),
  );
}


function modelAccessKey(provider, model) { return `${provider}:::${model}`; }
function deniedSetToRows(set) { return [...set].map(k => { const [provider, model] = k.split(':::'); return { provider, model }; }); }
function providerModesToRows(map) { return PROVIDERS.map(provider => ({ provider, mode: map.get(provider) || 'allow_all' })); }

function modelAccessMatrix(deniedSet, providerModes = new Map(), onToggle) {
  const root = el('div', { class: 'model-access-matrix stack' });
  const known = state.data.knownModels || {};
  const changed = () => { if (onToggle) onToggle(); else render(); };
  function render() {
    root.replaceChildren();
    for (const provider of PROVIDERS) {
      const models = known[provider] || [];
      if (!models.length) continue;
      const modelKeys = models.map(model => modelAccessKey(provider, model));
      const allowedCount = modelKeys.filter(key => !deniedSet.has(key)).length;
      let mode = providerModes.get(provider);
      if (!mode) mode = allowedCount === 0 ? 'deny_all' : allowedCount === modelKeys.length ? 'allow_all' : 'custom';
      const allAllowed = mode === 'allow_all';
      const noneAllowed = mode === 'deny_all';
      const providerState = allAllowed ? 'ALL ON' : noneAllowed ? 'ALL OFF' : 'MIXED';
      root.appendChild(el('div', { class: 'model-access-provider card' },
        el('div', { class: 'card__body' },
          el('div', { class: 'model-access-provider-head' },
            el('div', { class: 'model-access-provider-title' },
              el('span', { class: 'provider-mark', data: { provider } }, PROVIDER_GLYPH[provider]),
              PROVIDER_LABEL[provider],
            ),
            el('div', { class: 'spacer' }),
            el('span', { class: allAllowed ? 'pill pill--success' : noneAllowed ? 'pill pill--warn' : 'pill' }, providerState),
            el('label', { class: 'switch model-access-provider-bulk', title: `Toggle all ${PROVIDER_LABEL[provider]} models` },
              el('input', { type: 'checkbox', checked: allAllowed, indeterminate: !allAllowed && !noneAllowed, on: { change: (e) => {
                providerModes.set(provider, e.target.checked ? 'allow_all' : 'deny_all');
                for (const key of modelKeys) {
                  if (e.target.checked) deniedSet.delete(key); else deniedSet.add(key);
                }
                changed();
              } } }),
              el('span', { class: 'switch__track' }), el('span', { class: 'switch__thumb' }),
            ),
          ),
          ...models.map(model => {
            const key = modelAccessKey(provider, model);
            const checked = !deniedSet.has(key);
            return el('div', { class: 'model-access-row' },
              el('code', { class: 'mono fs-12' }, model),
              el('span', { class: checked ? 'pill pill--success' : 'pill pill--warn' }, checked ? 'ON' : 'OFF'),
              el('label', { class: 'switch' },
                el('input', { type: 'checkbox', checked, on: { change: (e) => {
                  providerModes.set(provider, 'custom');
                  if (e.target.checked) deniedSet.delete(key); else deniedSet.add(key);
                  changed();
                } } }),
                el('span', { class: 'switch__track' }), el('span', { class: 'switch__thumb' }),
              ),
            );
          }),
        ),
      ));
    }
  }
  render();
  return root;
}

/* ──── Create user ──── */
function openCreateUser() {
  let email = '', role = 'developer', isAdmin = false, fullBodyLogging = false;
  const createDenied = new Set();
  const createProviderModes = new Map();
  const body = el('div', { class: 'field-group' },
    el('div', { class: 'field' },
      el('label', { class: 'field-label' }, 'Email'),
      el('input', { type: 'email', placeholder: 'user@example.com', on: { input: (e) => email = e.target.value } }),
    ),
    el('div', { class: 'field' },
      el('label', { class: 'field-label' }, 'Role'),
      el('select', { on: { change: (e) => role = e.target.value } },
        ...['developer', 'member', 'founder', 'admin'].map(r => el('option', { value: r, selected: r === role ? 'selected' : null }, r)),
      ),
    ),
    el('div', { class: 'row-toggle' },
      el('div', {},
        el('div', { class: 'label' }, 'Admin'),
        el('div', { class: 'sub' }, 'Grants console + API admin endpoints.'),
      ),
      el('label', { class: 'switch' },
        el('input', { type: 'checkbox', on: { change: (e) => isAdmin = e.target.checked } }),
        el('span', { class: 'switch__track' }), el('span', { class: 'switch__thumb' }),
      ),
    ),
    el('div', { class: 'row-toggle' },
      el('div', {},
        el('div', { class: 'label' }, 'Full body logging'),
        el('div', { class: 'sub' }, 'Stores request/response bodies. Use sparingly.'),
      ),
      el('label', { class: 'switch' },
        el('input', { type: 'checkbox', on: { change: (e) => fullBodyLogging = e.target.checked } }),
        el('span', { class: 'switch__track' }), el('span', { class: 'switch__thumb' }),
      ),
    ),
    el('div', { class: 'field' },
      el('label', { class: 'field-label' }, 'Model access'),
      modelAccessMatrix(createDenied, createProviderModes),
    ),
  );
  const footer = el('div', { class: 'flex gap-2', style: { width: '100%' } },
    el('div', { class: 'spacer' }),
    el('button', { class: 'btn btn--ghost', on: { click: () => d.close() } }, 'Cancel'),
    el('button', { class: 'btn btn--primary', on: { click: submit } }, icon('check', 14), 'Create user'),
  );
  async function submit() {
    if (!email.trim() || !email.includes('@')) return toast('Valid email required', 'error');
    try {
      const created = await api('/admin/users', { method: 'POST', body: JSON.stringify({ email: email.trim(), role, isAdmin, fullBodyLogging }) });
      if (createDenied.size || createProviderModes.size) {
        await api(`/admin/users/${created.id}/model-access`, {
          method: 'PUT',
          body: JSON.stringify({ deniedModels: deniedSetToRows(createDenied), providerModes: providerModesToRows(createProviderModes) }),
        });
      }
      toast('User created');
      d.close();
      refresh();
    } catch (e) { toast(e.message, 'error'); }
  }
  const d = drawer({ title: 'Create user', subtitle: 'They\'ll be able to sign in with this email.', body, footer });
}

/* ──── User drawer ──── */
function openUserDrawer(u) {
  let activeTab = 'tokens';
  const tabsEl = el('div', { class: 'tabs' });
  const contentEl = el('div', { class: 'stack' });

  function setTab(t) {
    activeTab = t;
    $$('.tab', tabsEl).forEach(x => x.classList.toggle('active', x.dataset.tab === t));
    renderTabBody();
  }
  function renderTabBody() {
    contentEl.replaceChildren();
    if (activeTab === 'tokens') contentEl.appendChild(tokensSection());
    else if (activeTab === 'limits') contentEl.appendChild(limitsSection());
    else if (activeTab === 'models') contentEl.appendChild(modelAccessSection());
    else if (activeTab === 'grants') contentEl.appendChild(grantsSection());
    else contentEl.appendChild(usageSection());
  }
  tabsEl.append(
    el('button', { class: 'tab active', data: { tab: 'tokens' }, on: { click: () => setTab('tokens') } }, 'Tokens'),
    el('button', { class: 'tab', data: { tab: 'limits' }, on: { click: () => setTab('limits') } }, 'Limit overrides'),
    el('button', { class: 'tab', data: { tab: 'models' }, on: { click: () => setTab('models') } }, 'Model access'),
    el('button', { class: 'tab', data: { tab: 'grants' }, on: { click: () => setTab('grants') } }, 'Grants'),
    el('button', { class: 'tab', data: { tab: 'usage' }, on: { click: () => setTab('usage') } }, 'Usage'),
  );

  // Header form
  let role = u.role || 'member', enabled = !!u.enabled, isAdmin = !!u.isAdmin, fullBody = !!u.fullBodyLogging, compressionOn = u.compressionEnabled !== false;

  const head = el('div', { class: 'field-group' },
    el('div', { class: 'row' },
      el('div', { class: 'user__avatar', style: { width: '40px', height: '40px', fontSize: '15px' } }, (u.email?.[0] || '·').toUpperCase()),
      el('div', {},
        el('div', { class: 'fw-600' }, u.email || '—'),
        el('div', { class: 'fs-12 text-subtle' }, `created ${fmt.date(u.created_at)}`),
      ),
      el('div', { class: 'spacer' }),
      el('span', { class: 'role-chip', data: { role } }, role),
    ),
    el('div', { class: 'field-row' },
      el('div', { class: 'field' },
        el('label', { class: 'field-label' }, 'Role'),
        el('select', { on: { change: (e) => role = e.target.value } },
          ...['developer', 'member', 'founder', 'admin'].map(r => el('option', { value: r, selected: r === role ? 'selected' : null }, r))),
      ),
      el('div', { class: 'field' },
        el('label', { class: 'field-label' }, 'Status'),
        el('label', { class: 'switch', style: { marginTop: '6px' } },
          el('input', { type: 'checkbox', checked: enabled, on: { change: (e) => enabled = e.target.checked } }),
          el('span', { class: 'switch__track' }), el('span', { class: 'switch__thumb' }),
        ),
      ),
    ),
    el('div', { class: 'field-row' },
      el('div', { class: 'row-toggle' },
        el('div', { class: 'label' }, 'Admin'),
        el('label', { class: 'switch' },
          el('input', { type: 'checkbox', checked: isAdmin, on: { change: (e) => isAdmin = e.target.checked } }),
          el('span', { class: 'switch__track' }), el('span', { class: 'switch__thumb' }),
        ),
      ),
      el('div', { class: 'row-toggle' },
        el('div', { class: 'label' }, 'Full body logs'),
        el('label', { class: 'switch' },
          el('input', { type: 'checkbox', checked: fullBody, on: { change: (e) => fullBody = e.target.checked } }),
          el('span', { class: 'switch__track' }), el('span', { class: 'switch__thumb' }),
        ),
      ),
      el('div', { class: 'row-toggle' },
        el('div', { class: 'label' }, 'Context compression'),
        el('label', { class: 'switch' },
          el('input', { type: 'checkbox', checked: compressionOn, on: { change: (e) => compressionOn = e.target.checked } }),
          el('span', { class: 'switch__track' }), el('span', { class: 'switch__thumb' }),
        ),
      ),
    ),
  );

  function tokensSection() {
    const tokens = (u.tokens || []).filter(Boolean);
    const list = tokens.length
      ? el('div', { class: 'table-wrap' },
          el('table', { class: 'tbl' },
            el('thead', {}, el('tr', {},
              el('th', {}, 'Prefix'), el('th', {}, 'Label'), el('th', {}, 'Last used'), el('th', { class: 'right' }, ''),
            )),
            el('tbody', {}, ...tokens.map(t => el('tr', {},
              el('td', { class: 'mono fs-12' }, t.token_prefix || '—'),
              el('td', {}, t.label || '—'),
              el('td', { class: 'fs-12 text-muted' }, fmt.ago(t.last_used_at)),
              el('td', { class: 'actions-cell' },
                el('div', { class: 'flex gap-1 justify-end' },
                  (t.enabled === false || t.enabled === 0)
                    ? el('span', { class: 'pill' }, 'revoked')
                    : el('button', { class: 'btn btn--ghost btn--sm', on: { click: () => revokeToken(t) } }, icon('x', 12), 'Revoke'),
                  el('button', { class: 'btn btn--ghost btn--sm', title: 'Delete permanently', on: { click: () => deleteToken(t) } }, icon('trash', 12)),
                ),
              ),
            ))),
          ),
        )
      : emptyState({ iconName: 'token', title: 'No tokens issued', sub: 'Issue a proxy token for this user.' });
    return el('div', { class: 'stack' },
      el('div', { class: 'flex justify-between items-center' },
        el('div', { class: 'fs-12 text-subtle' }, `${tokens.length} token${tokens.length === 1 ? '' : 's'}`),
        el('button', { class: 'btn btn--primary btn--sm', on: { click: () => openIssueToken(u) } }, icon('plus', 14), 'Issue token'),
      ),
      list,
    );
  }

  async function revokeToken(t) {
    const ok = await confirmDialog({
      title: 'Revoke token?',
      message: `Disable token ${t.token_prefix}…? Existing requests using it will be rejected.`,
      danger: true, confirmLabel: 'Revoke',
    });
    if (!ok) return;
    try {
      await api(`/admin/tokens/${t.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: false }) });
      toast('Token revoked');
      d.close();
      refresh();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function deleteToken(t) {
    const ok = await confirmDialog({
      title: 'Delete token permanently?',
      message: `Hard-delete ${t.token_prefix}… (${t.label || 'unlabeled'}). The hash row is removed; usage history is preserved (token reference cleared).`,
      danger: true, confirmLabel: 'Delete',
    });
    if (!ok) return;
    try {
      await api(`/admin/tokens/${t.id}`, { method: 'DELETE' });
      toast('Token deleted');
      d.close();
      refresh();
    } catch (e) { toast(e.message, 'error'); }
  }

  function limitsSection() {
    const myOverrides = (state.data.userLimits || []).filter(l => l.user_id === u.id || l.email === u.email);
    const root = el('div', { class: 'stack' });
    const activeGrants = Number(u.activeGrantCount || 0);
    if (activeGrants > 0) {
      root.appendChild(el('div', { class: 'notice notice--warn' },
        el('strong', {}, `⚠ ${activeGrants} active grant${activeGrants === 1 ? '' : 's'}`),
        ' override these per-user limits for any matching provider/model until they expire. ',
        el('a', { href: '#', class: 'fw-500', on: { click: (e) => { e.preventDefault(); setTab('grants'); } } }, 'See Grants tab →')));
    }
    for (const provider of PROVIDERS) {
      const cur = myOverrides.find(l => l.provider === provider) || {};
      const usd = cur.daily_usd ?? '';
      const tokens = cur.daily_tokens ?? '';
      let editUsd = usd, editTokens = tokens;
      root.appendChild(el('div', { class: 'card' },
        el('div', { class: 'card__body row' },
          el('span', { class: 'provider-mark', data: { provider } }, PROVIDER_GLYPH[provider]),
          el('div', { class: 'fw-500' }, PROVIDER_LABEL[provider]),
          el('div', { class: 'spacer' }),
          el('div', { class: 'currency-affix' }, el('span', {}, '$/d'),
            el('input', { type: 'number', placeholder: 'role default', value: editUsd, style: { width: '120px' }, on: { input: (e) => editUsd = e.target.value } })),
          el('div', { class: 'currency-affix' }, el('span', {}, 'tok/d'),
            el('input', { type: 'number', placeholder: 'role default', value: editTokens, style: { width: '140px' }, on: { input: (e) => editTokens = e.target.value } })),
          el('button', {
            class: 'btn btn--primary btn--sm',
            on: { click: () => saveUserLimit(u.id, provider, editUsd, editTokens) },
          }, icon('check', 12), 'Save'),
        ),
      ));
    }
    root.appendChild(el('p', { class: 'text-subtle fs-12' },
      'Empty fields fall through to the role default. Override only what you need.'));
    return root;
  }

  async function saveUserLimit(userId, provider, dailyUsd, dailyTokens) {
    try {
      await api('/admin/limits/user', {
        method: 'PUT',
        body: JSON.stringify({
          userId, provider,
          dailyUsd: dailyUsd === '' || dailyUsd == null ? null : Number(dailyUsd),
          dailyTokens: dailyTokens === '' || dailyTokens == null ? null : Number(dailyTokens),
        }),
      });
      toast('Override saved');
      refresh();
    } catch (e) { toast(e.message, 'error'); }
  }


  function modelAccessSection() {
    const root = el('div', { class: 'stack' }, el('div', { class: 'text-subtle fs-12' }, 'Loading model access…'));
    (async () => {
      try {
        const res = await api(`/admin/users/${u.id}/model-access`);
        let denied = new Set((res.deniedModels || []).map(d => modelAccessKey(d.provider, d.model)));
        // Prefer `effectiveProviderModes` (computed by the gateway using the
        // same logic as request-time enforcement) over raw `providerModes`,
        // so the dashboard never disagrees with what the proxy will allow.
        const effective = res.effectiveProviderModes || res.providerModes || [];
        let providerModes = new Map(effective.map(m => [m.provider, m.mode]));
        async function save() {
          const payload = { deniedModels: deniedSetToRows(denied), providerModes: providerModesToRows(providerModes) };
          try {
            await api(`/admin/users/${u.id}/model-access`, { method: 'PUT', body: JSON.stringify(payload) });
            u.deniedModelCount = payload.deniedModels.length;
            toast('Model access saved');
            await refresh();
            rerender();
          } catch (e) { toast(e.message || 'Failed to save model access', 'error'); }
        }
        function rerender() {
          root.replaceChildren(
            el('div', { class: 'notice notice--info' }, 'Provider ALL ON allows any model for most providers, including future/unknown names. OpenRouter is stricter: only listed models are allowed. Fusion controls the meta-route; underlying panel/synthesizer models still need their own provider access. ALL OFF blocks the provider. MIXED allows only listed ON models.'),
            modelAccessMatrix(denied, providerModes, save),
          );
        }
        rerender();
      } catch (e) { root.replaceChildren(el('div', { class: 'alert alert--danger' }, icon('alert', 14), e.message || 'Failed to load model access')); }
    })();
    return root;
  }

  /* ─── Grants tab ─── */
  function grantsSection() {
    const root = el('div', { class: 'stack' });
    const tableMount = el('div', {});
    root.append(addGrantForm(() => reloadGrants()), tableMount);

    async function reloadGrants() {
      tableMount.replaceChildren(el('div', { class: 'text-subtle fs-12' }, 'Loading…'));
      try {
        const res = await api(`/admin/grants?userId=${u.id}`);
        const grants = res.grants || [];
        tableMount.replaceChildren(grants.length ? grantsTable(grants, reloadGrants) : emptyState({
          iconName: 'zap', title: 'No grants', sub: 'Time-bounded overrides let this user access a specific provider/model temporarily.',
        }));
      } catch (e) { toast(e.message, 'error'); }
    }
    reloadGrants();
    return root;
  }

  function grantsTable(grants, onChange) {
    return el('div', { class: 'table-wrap' },
      el('table', { class: 'tbl' },
        el('thead', {}, el('tr', {},
          el('th', {}, 'Provider'),
          el('th', {}, 'Model'),
          el('th', { class: 'right' }, '$/d'),
          el('th', { class: 'right' }, 'tok/d'),
          el('th', {}, 'From'),
          el('th', {}, 'Until'),
          el('th', {}, 'Status'),
          el('th', { class: 'right' }, ''),
        )),
        el('tbody', {}, ...grants.map(g => el('tr', {},
          el('td', {}, el('span', { class: 'flex items-center gap-2' },
            el('span', { class: 'provider-mark', data: { provider: g.provider } }, PROVIDER_GLYPH[g.provider] || '?'),
            el('span', {}, PROVIDER_LABEL[g.provider] || g.provider),
          )),
          el('td', { class: 'mono fs-12' }, g.model_pattern || '*'),
          el('td', { class: 'right num' }, g.daily_usd == null ? '∞' : fmt.usd(g.daily_usd)),
          el('td', { class: 'right num' }, g.daily_tokens == null ? '∞' : fmt.num(g.daily_tokens)),
          el('td', { class: 'fs-12 text-muted' }, fmt.date(new Date(g.valid_from).toISOString())),
          el('td', { class: 'fs-12 text-muted' }, fmt.date(new Date(g.valid_until).toISOString())),
          el('td', {},
            g.status === 'active' ? el('span', { class: 'pill pill--success' }, 'active')
            : g.status === 'pending' ? el('span', { class: 'pill pill--warn' }, 'pending')
            : el('span', { class: 'pill' }, 'expired'),
          ),
          el('td', { class: 'actions-cell' },
            el('button', { class: 'btn btn--ghost btn--sm', on: { click: async () => {
              const ok = await confirmDialog({ title: 'Revoke grant?', message: `Immediately revoke this ${g.provider} grant.`, danger: true, confirmLabel: 'Revoke' });
              if (!ok) return;
              try { await api(`/admin/grants/${g.id}`, { method: 'DELETE' }); toast('Grant revoked'); onChange(); refresh(); } catch (e) { toast(e.message, 'error'); }
            } } }, icon('trash', 12), 'Revoke'),
          ),
        ))),
      ),
    );
  }

  function addGrantForm(onCreated) {
    let provider = 'anthropic';
    let modelPattern = '*';
    let dailyUsd = '';
    let dailyTokens = '';
    let durationMs = 24 * 3600_000; // default 24h
    let customUntil = '';
    let reason = '';
    const DURATIONS = [
      { label: '1h', ms: 1 * 3600_000 },
      { label: '4h', ms: 4 * 3600_000 },
      { label: '24h', ms: 24 * 3600_000 },
      { label: '7d', ms: 7 * 24 * 3600_000 },
      { label: '30d', ms: 30 * 24 * 3600_000 },
    ];
    const quickPicks = el('div', { class: 'flex gap-1 items-center' });
    function renderPicks() {
      quickPicks.replaceChildren(
        ...DURATIONS.map(d => el('button', {
          class: `btn btn--sm ${durationMs === d.ms ? 'btn--primary' : 'btn--ghost'}`,
          on: { click: () => { durationMs = d.ms; customUntil = ''; renderPicks(); } },
        }, d.label)),
        el('span', { class: 'text-subtle fs-12 ml-2' }, 'or'),
        el('input', {
          type: 'datetime-local', value: customUntil,
          on: { input: (e) => { customUntil = e.target.value; renderPicks(); } },
        }),
      );
    }
    renderPicks();

    const form = el('div', { class: 'card' }, el('div', { class: 'card__body stack' },
      el('div', { class: 'fw-600' }, 'Add grant'),
      el('div', { class: 'field-row' },
        el('div', { class: 'field' },
          el('label', { class: 'field-label' }, 'Provider'),
          el('select', { on: { change: (e) => provider = e.target.value } },
            ...PROVIDERS.map(p => el('option', { value: p, selected: p === provider ? 'selected' : null }, PROVIDER_LABEL[p])),
          ),
        ),
        el('div', { class: 'field' },
          el('label', { class: 'field-label' }, 'Model pattern'),
          el('input', { placeholder: '* (any model)', value: modelPattern, on: { input: (e) => modelPattern = e.target.value || '*' } }),
        ),
      ),
      el('div', { class: 'field-row' },
        el('div', { class: 'field' },
          el('label', { class: 'field-label' }, '$/d (blank = unlimited)'),
          el('input', { type: 'number', step: '0.01', placeholder: '∞', on: { input: (e) => dailyUsd = e.target.value } }),
        ),
        el('div', { class: 'field' },
          el('label', { class: 'field-label' }, 'Tokens/d (blank = unlimited)'),
          el('input', { type: 'number', placeholder: '∞', on: { input: (e) => dailyTokens = e.target.value } }),
        ),
      ),
      el('div', { class: 'field' },
        el('label', { class: 'field-label' }, 'Duration'),
        quickPicks,
      ),
      el('div', { class: 'field' },
        el('label', { class: 'field-label' }, 'Reason'),
        el('input', { placeholder: 'why?', on: { input: (e) => reason = e.target.value } }),
      ),
      el('div', { class: 'flex justify-end gap-2' },
        el('button', { class: 'btn btn--primary btn--sm', on: { click: submit } }, icon('plus', 14), 'Add grant'),
      ),
    ));

    async function submit() {
      const validUntil = customUntil
        ? new Date(customUntil).getTime()
        : Date.now() + durationMs;
      if (!Number.isFinite(validUntil) || validUntil <= Date.now()) { toast('Pick a future expiry', 'error'); return; }
      try {
        await api('/admin/grants', {
          method: 'POST',
          body: JSON.stringify({
            userId: u.id, provider, modelPattern: modelPattern || '*',
            dailyUsd: dailyUsd === '' ? null : Number(dailyUsd),
            dailyTokens: dailyTokens === '' ? null : Number(dailyTokens),
            validUntil, reason: reason || null,
          }),
        });
        toast('Grant created');
        onCreated();
        refresh();
      } catch (e) { toast(e.message, 'error'); }
    }
    return form;
  }

  function usageSection() {
    // Filter usage to this user's email, then collapse provider-account splits.
    // User-level views should not expose how many upstream accounts back the pool.
    const rawRows = (state.data.usage || []).filter(r => (r.email || '') === u.email);
    const byModel = new Map();
    for (const r of rawRows) {
      const key = `${r.provider || ''}::${r.model || ''}`;
      const cur = byModel.get(key) || { ...r, requests: 0, tokens: 0, usd: 0 };
      cur.requests += Number(r.requests || 0);
      cur.tokens += Number(r.tokens || 0);
      cur.usd += Number(r.usd || 0);
      byModel.set(key, cur);
    }
    const rows = Array.from(byModel.values()).sort((a, b) => Number(b.requests || 0) - Number(a.requests || 0));
    if (!rows.length) return emptyState({ iconName: 'bar', title: 'No recent usage', sub: 'No requests recorded for this user in the last 24h.' });
    return el('div', { class: 'table-wrap' },
      el('table', { class: 'tbl' },
        el('thead', {}, el('tr', {},
          el('th', {}, 'Provider'),
          el('th', {}, 'Model'),
          el('th', { class: 'right' }, 'Requests'),
          el('th', { class: 'right' }, 'Tokens'),
          el('th', { class: 'right' }, 'Spend'),
        )),
        el('tbody', {}, ...rows.map(r => el('tr', {},
          el('td', {},
            el('span', { class: 'flex items-center gap-2' },
              el('span', { class: 'provider-mark', data: { provider: r.provider } }, PROVIDER_GLYPH[r.provider] || '?'),
              el('span', {}, PROVIDER_LABEL[r.provider] || r.provider),
            ),
          ),
          el('td', { class: 'mono fs-12' }, r.model || '—'),
          el('td', { class: 'right num' }, fmt.int(r.requests)),
          el('td', { class: 'right num' }, fmt.num(r.tokens)),
          el('td', { class: 'right num' }, fmt.usd(r.usd)),
        ))),
      ),
    );
  }

  setTab('tokens');
  const body = el('div', { class: 'stack' }, head, tabsEl, contentEl);
  const footer = el('div', { class: 'user-drawer__footer' },
    el('button', {
      class: u.enabled ? 'btn btn--danger btn--ghost' : 'btn btn--ghost',
      on: { click: toggleEnabled },
    }, icon('power', 14), u.enabled ? 'Disable' : 'Enable'),
    el('button', { class: 'btn btn--danger btn--ghost', on: { click: deleteUser } }, icon('trash', 14), 'Delete'),
    el('button', { class: 'btn btn--ghost', on: { click: () => openTestAsUser(u) } }, icon('zap', 14), 'Test as user'),
    el('div', { class: 'spacer' }),
    el('button', { class: 'btn btn--ghost user-drawer__cancel', on: { click: () => d.close() } }, 'Cancel'),
    el('button', { class: 'btn btn--primary user-drawer__save', on: { click: save } }, icon('check', 14), 'Save changes'),
  );

  async function toggleEnabled() {
    if (state.user?.email && state.user.email === u.email && u.enabled) {
      toast("You can't disable the currently signed-in admin", 'error');
      return;
    }
    const next = !u.enabled;
    if (!next) {
      const ok = await confirmDialog({
        title: 'Disable user?',
        message: `Disable ${u.email}. Their account and all API tokens stop working immediately (existing usage history is preserved). You can re-enable any time.`,
        danger: true, confirmLabel: 'Disable user',
      });
      if (!ok) return;
    }
    try {
      await api(`/admin/users/${u.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: next }) });
      toast(next ? 'User enabled' : 'User disabled');
      d.close();
      refresh();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function save() {
    try {
      await api(`/admin/users/${u.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ role, enabled, isAdmin, fullBodyLogging: fullBody, compressionEnabled: compressionOn }),
      });
      toast('User updated');
      d.close();
      refresh();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function deleteUser() {
    if (state.user?.email && state.user.email === u.email) {
      toast("You can't delete the currently signed-in admin", 'error');
      return;
    }
    const ok = await confirmDialog({
      title: 'Delete user permanently?',
      message: `Hard-delete ${u.email}. All their tokens and per-user limit overrides will be removed. Usage history is preserved (user reference cleared). This cannot be undone.`,
      danger: true, confirmLabel: 'Delete user',
    });
    if (!ok) return;
    try {
      await api(`/admin/users/${u.id}`, { method: 'DELETE' });
      toast('User deleted');
      d.close();
      refresh();
    } catch (e) { toast(e.message, 'error'); }
  }

  const d = drawer({ title: u.email || 'User', subtitle: `#${u.id}`, body, footer });
}

/* ──── Issue token (admin) ──── */
function openIssueToken(u) {
  let label = 'personal', capUsd = '', capTokens = '';
  let createdToken = null;

  const formBody = el('div', { class: 'field-group', id: 'issueForm' },
    el('div', { class: 'field' },
      el('label', { class: 'field-label' }, 'Label'),
      el('input', { value: label, on: { input: (e) => label = e.target.value } }),
    ),
    el('div', { class: 'field-row' },
      el('div', { class: 'field' },
        el('label', { class: 'field-label' }, 'Cap · daily $ (optional)'),
        el('input', { type: 'number', placeholder: 'unlimited', on: { input: (e) => capUsd = e.target.value } }),
      ),
      el('div', { class: 'field' },
        el('label', { class: 'field-label' }, 'Cap · daily tokens (optional)'),
        el('input', { type: 'number', placeholder: 'unlimited', on: { input: (e) => capTokens = e.target.value } }),
      ),
    ),
  );
  const revealBody = el('div', { class: 'stack hidden', id: 'revealForm' });
  const body = el('div', {}, formBody, revealBody);

  const primary = el('button', { class: 'btn btn--primary', on: { click: submit } }, icon('plus', 14), 'Issue token');
  const footer = el('div', { class: 'flex gap-2', style: { width: '100%' } },
    el('div', { class: 'spacer' }),
    el('button', { class: 'btn btn--ghost', on: { click: () => d.close() } }, 'Done'),
    primary,
  );

  async function submit() {
    try {
      const r = await api(`/admin/users/${u.id}/tokens`, {
        method: 'POST',
        body: JSON.stringify({
          label,
          capUsdDaily: capUsd === '' ? null : Number(capUsd),
          capTokensDaily: capTokens === '' ? null : Number(capTokens),
        }),
      });
      createdToken = r.token;
      formBody.classList.add('hidden');
      revealBody.classList.remove('hidden');
      revealBody.replaceChildren(
        el('div', { class: 'alert alert--success' }, icon('check', 14),
          el('div', {}, el('div', { class: 'fw-600' }, 'Token created'),
            el('div', { class: 'fs-12 mt-1' }, 'Copy it now — you won\'t see it again.'))),
        el('div', { class: 'code mt-2' }, createdToken,
          el('button', { class: 'btn btn--ghost btn--sm copy-btn', on: { click: () => copyToClipboard(createdToken) } },
            icon('copy', 14), 'Copy')),
      );
      primary.classList.add('hidden');
      refresh();
    } catch (e) { toast(e.message, 'error'); }
  }
  const d = drawer({ title: 'Issue token', subtitle: `for ${u.email}`, body, footer });
}

/* ══════════════════════════════════════════════════════════════════
   ▓▓▓▓▓ USAGE PAGE  (admin) ▓▓▓▓▓
   ══════════════════════════════════════════════════════════════════ */
function renderUsageAdmin() {
  const root = el('div', { class: 'stack stack--lg' });
  let activeRange = state._usageRange || '24h';
  let usage = state.data.usage || [];

  const kpiHost = el('div', { class: 'grid-3' });
  const tableHost = el('div', { class: 'table-wrap' });
  let sortKey = 'usd';

  async function loadRange(range) {
    activeRange = range;
    state._usageRange = range;
    try {
      const r = await api(`/admin/usage?range=${encodeURIComponent(range)}`);
      usage = r.usage || [];
      state.data.usage = usage;
    } catch (e) { toast(e.message, 'error'); }
    paint();
  }

  function paint() {
    const agg = aggregateUsage(usage);
    kpiHost.replaceChildren(
      kpi({ label: 'Requests', value: fmt.num(agg.requests), iconName: 'activity', sub: rangeLabel(activeRange) }),
      kpi({ label: 'Tokens',   value: fmt.num(agg.tokens),   iconName: 'hash',     sub: 'Input + output + cache' }),
      kpi({ label: 'Spend',    value: fmt.usd(agg.usd),      iconName: 'dollar',   sub: 'Estimated' }),
    );
    renderTable();
  }
  function rangeLabel(r) { return ({ '1h': 'Last hour', '24h': 'Last 24h', '7d': 'Last 7 days', '30d': 'Last 30 days', 'all': 'All time' }[r] || r); }

  const rangeBar = el('div', { class: 'flex gap-3 items-center mb-3' },
    el('div', { class: 'range-tabs' },
      ...['1h','24h','7d','30d','all'].map(r =>
        el('button', { class: r === activeRange ? 'active' : '', on: { click: () => loadRange(r) } }, r)),
    ),
  );

  // Breakdown table
  function renderTable() {
    const q = (state.filters.q || '').toLowerCase();
    const rows = usage
      .filter(r => !q || (r.email || '').toLowerCase().includes(q) || (r.model || '').toLowerCase().includes(q) || (r.provider || '').toLowerCase().includes(q))
      .slice()
      .sort((a, b) => Number(b[sortKey] || 0) - Number(a[sortKey] || 0));
    tableHost.replaceChildren(el('table', { class: 'tbl tbl-collapse' },
      el('thead', {}, el('tr', {},
        el('th', {}, 'User'),
        el('th', {}, 'Provider'),
        el('th', {}, 'Account'),
        el('th', {}, 'Model'),
        el('th', { class: 'right' }, sortHead('Requests', 'requests')),
        el('th', { class: 'right' }, sortHead('Tokens', 'tokens')),
        el('th', { class: 'right' }, sortHead('Spend', 'usd')),
      )),
      el('tbody', {}, rows.length ? rows.map(r => el('tr', {},
        el('td', { data: { label: 'User' } }, el('span', { class: 'mono fs-12' }, r.email || el('span', { class: 'text-subtle' }, '(deleted user)'))),
        el('td', { data: { label: 'Provider' } }, el('span', { class: 'flex items-center gap-2' },
          el('span', { class: 'provider-mark', data: { provider: r.provider } }, PROVIDER_GLYPH[r.provider] || '?'),
          el('span', {}, PROVIDER_LABEL[r.provider] || r.provider))),
        el('td', { data: { label: 'Account' }, class: 'fs-12 text-muted' }, r.provider_account_label || '—'),
        el('td', { data: { label: 'Model' }, class: 'mono fs-12' }, r.model || '—'),
        el('td', { data: { label: 'Requests' }, class: 'right num' }, fmt.int(r.requests)),
        el('td', { data: { label: 'Tokens' }, class: 'right num' }, fmt.num(r.tokens)),
        el('td', { data: { label: 'Spend' }, class: 'right num fw-500' }, fmt.usd(r.usd)),
      )) : [el('tr', { class: 'empty-row' }, el('td', { colspan: 7 },
          emptyState({ iconName: 'bar', title: `No requests in ${rangeLabel(activeRange)}`, sub: 'Once requests start flowing through the gateway you\'ll see usage here.' })))]),
    ));
  }
  function sortHead(label, key) {
    return el('button', { class: 'btn btn--quiet btn--sm', style: { fontSize: '11px', height: '24px', textTransform: 'uppercase', letterSpacing: '.06em' }, on: { click: () => { sortKey = key; renderTable(); } } },
      label, sortKey === key ? icon('arrowDown', 12) : null);
  }

  paint();
  state._usageRerender = renderTable;

  // Recent events panel — lazy-loaded.
  const eventsHost = el('div', { class: 'table-wrap' });
  let onlyErrors = false;
  async function loadEvents() {
    try {
      const params = new URLSearchParams({ range: activeRange, limit: '50' });
      if (onlyErrors) params.set('onlyErrors', '1');
      const r = await api(`/admin/usage-events?${params}`);
      paintEvents(r.events || []);
    } catch (e) { toast(e.message, 'error'); }
  }
  function paintEvents(events) {
    eventsHost.replaceChildren(el('table', { class: 'tbl tbl-collapse' },
      el('thead', {}, el('tr', {},
        el('th', {}, 'When'),
        el('th', {}, 'User'),
        el('th', {}, 'Provider'),
        el('th', {}, 'Account'),
        el('th', {}, 'Model'),
        el('th', { class: 'right' }, 'Status'),
        el('th', { class: 'right' }, 'Tokens'),
        el('th', { class: 'right' }, 'Spend'),
        el('th', { class: 'right' }, 'Latency'),
        el('th', { class: 'right' }, ''),
      )),
      el('tbody', {}, events.length ? events.map(ev => el('tr', { class: ev.has_log ? 'clickable' : '', on: ev.has_log ? { click: () => openRequestLog(ev) } : {} },
        el('td', { class: 'fs-12 text-muted' }, fmt.ago(ev.created_at)),
        el('td', { class: 'mono fs-12' }, ev.email || '—'),
        el('td', {}, PROVIDER_LABEL[ev.provider] || ev.provider),
        el('td', { class: 'fs-12 text-muted' }, ev.provider_account_label || '—'),
        el('td', { class: 'mono fs-12' }, ev.model || '—'),
        el('td', { class: 'right' }, statusCodePill(ev.status_code)),
        el('td', { class: 'right num fs-12' }, fmt.num((ev.input_tokens||0)+(ev.output_tokens||0)+(ev.cache_creation_tokens||0)+(ev.cache_read_tokens||0))),
        el('td', { class: 'right num fs-12' }, fmt.usd(ev.estimated_cost_usd)),
        el('td', { class: 'right num fs-12' }, ev.latency_ms != null ? `${ev.latency_ms}ms` : '—'),
        el('td', { class: 'right' }, ev.has_log ? el('span', { class: 'pill pill--info' }, 'body') : ''),
      )) : [el('tr', { class: 'empty-row' }, el('td', { colspan: 10 },
        emptyState({ iconName: 'inbox', title: 'No events match', sub: 'Try a wider range or clear the errors filter.' })))]),
    ));
  }
  loadEvents();
  root.append(card({
    title: 'Recent events',
    sub: 'Each row is a single proxied request',
    actions: el('label', { class: 'flex items-center gap-2 fs-12 text-subtle' },
      el('input', { type: 'checkbox', on: { change: (e) => { onlyErrors = e.target.checked; loadEvents(); } } }),
      'Errors only',
    ),
    flush: true,
    body: eventsHost,
  }));

  return root;
}

function statusCodePill(code) {
  if (code == null) return el('span', { class: 'pill' }, '—');
  const cls = code >= 500 ? 'pill--danger' : code >= 400 ? 'pill--warn' : 'pill--success';
  return el('span', { class: `pill ${cls}` }, String(code));
}

async function openRequestLog(ev) {
  let body = el('div', {}, el('div', { class: 'fs-12 text-subtle' }, 'Loading…'));
  const d = drawer({
    title: 'Request body',
    subtitle: `event #${ev.id} · ${ev.email || 'unknown user'} · ${PROVIDER_LABEL[ev.provider] || ev.provider}`,
    body,
    footer: el('div', { class: 'flex gap-2', style: { width: '100%' } },
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn btn--ghost', on: { click: () => d.close() } }, 'Close'),
    ),
  });
  try {
    const r = await api(`/admin/usage-events/${ev.id}/log`);
    body.replaceChildren(
      el('div', { class: 'fs-12 text-subtle' }, `Captured ${fmt.ago(r.created_at)} · expires ${fmt.ago(r.expires_at)}`),
      el('div', { class: 'fs-12 mt-3' }, 'Request'),
      el('div', { class: 'code mt-1', style: { maxHeight: '40vh', overflow: 'auto' } }, JSON.stringify(r.request, null, 2)),
      el('div', { class: 'fs-12 mt-3' }, 'Response'),
      el('div', { class: 'code mt-1', style: { maxHeight: '40vh', overflow: 'auto' } }, r.response || ''),
    );
  } catch (e) {
    body.replaceChildren(
      el('div', { class: 'alert alert--warn' }, e.message || 'Log not available'),
      el('p', { class: 'fs-12 text-subtle mt-2' }, 'Body logs are only retained when the user has full body logging enabled.'),
    );
  }
}

/* ══════════════════════════════════════════════════════════════════
   ▓▓▓▓▓ AUDIT PAGE  (admin) ▓▓▓▓▓
   ══════════════════════════════════════════════════════════════════ */
function renderAudit() {
  let activeTab = 'all';
  const root = el('div', { class: 'stack' });

  const tabsEl = el('div', { class: 'tabs' },
    el('button', { class: 'tab active', data: { tab: 'all' }, on: { click: () => { activeTab = 'all'; renderBody(); } } }, 'All actions'),
    el('button', { class: 'tab', data: { tab: 'resolved' }, on: { click: () => { activeTab = 'resolved'; renderBody(); } } }, 'Resolved alerts'),
  );
  const bodyEl = el('div', { class: 'stack' });

  function renderBody() {
    $$('.tab', tabsEl).forEach(x => x.classList.toggle('active', x.dataset.tab === activeTab));
    bodyEl.replaceChildren();
    if (activeTab === 'all') bodyEl.appendChild(auditTable());
    else bodyEl.appendChild(resolvedAlertsTable());
  }

  function auditTable() {
    const q = (state.filters.q || '').toLowerCase();
    const rows = (state.data.audit || []).filter(a => !q
      || (a.action || '').toLowerCase().includes(q)
      || (a.target_type || '').toLowerCase().includes(q)
      || (a.actor_email || '').toLowerCase().includes(q));
    if (!rows.length) return emptyState({ iconName: 'history', title: 'No audit entries', sub: 'Admin actions will appear here.' });
    const tbl = el('table', { class: 'tbl tbl-collapse' },
      el('thead', {}, el('tr', {},
        el('th', {}, 'When'),
        el('th', {}, 'Actor'),
        el('th', {}, 'Action'),
        el('th', {}, 'Target'),
        el('th', { class: 'right' }, ''),
      )),
      el('tbody', {}, ...rows.map(auditRow)),
    );
    return el('div', { class: 'table-wrap' }, tbl);
  }

  function auditRow(a) {
    const tr = el('tr', {},
      el('td', { data: { label: 'When' }, class: 'mono fs-12 text-muted', title: fmt.date(a.created_at) }, fmt.ago(a.created_at)),
      el('td', { data: { label: 'Actor' } }, el('span', { class: 'mono fs-12' }, a.actor_email || (a.actor_user_id ? 'user ' + a.actor_user_id : 'system'))),
      el('td', { data: { label: 'Action' } }, el('span', { class: 'fw-500' }, a.action || '—')),
      el('td', { data: { label: 'Target' } }, el('span', { class: 'fs-12' }, [a.target_type, a.target_id != null ? formatAuditTargetId(a.target_type, a.target_id) : null].filter(Boolean).join(' '))),
      el('td', { class: 'actions-cell' },
        (a.before || a.after) ? el('button', {
          class: 'btn btn--ghost btn--sm',
          on: { click: () => toggleExpand(tr, a) },
        }, icon('chevron', 14), 'Diff') : null,
      ),
    );
    return tr;
  }
  function toggleExpand(tr, a) {
    const next = tr.nextElementSibling;
    if (next?.classList?.contains('audit-row-expand')) { next.remove(); tr.classList.remove('expanded'); return; }
    const exp = el('tr', { class: 'audit-row-expand' },
      el('td', { colspan: 5 },
        el('div', { class: 'audit-diff' },
          el('div', {}, el('div', { class: 'label' }, 'Before'), jsonView(safeJson(a.before))),
          el('div', {}, el('div', { class: 'label' }, 'After'),  jsonView(safeJson(a.after))),
        )));
    tr.classList.add('expanded');
    tr.parentNode.insertBefore(exp, tr.nextSibling);
  }

  function resolvedAlertsTable() {
    const q = (state.filters.q || '').toLowerCase();
    const rows = (state.data.alerts || [])
      .filter(a => a.resolved || a.resolved_at)
      .filter(a => !q || (a.message || '').toLowerCase().includes(q) || (a.type || a.kind || a.source || '').toLowerCase().includes(q));
    if (!rows.length) return emptyState({ iconName: 'shield', title: 'No resolved alerts', sub: 'Alerts that have been acknowledged or auto-resolved will appear here.' });
    return el('div', { class: 'feed' }, ...rows.map(a => alertFeedItem(a)));
  }

  state._auditRerender = renderBody;
  root.append(tabsEl, bodyEl);
  renderBody();
  return root;
}

function safeJson(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return v; }
}
function jsonView(v) {
  if (v == null) return el('div', { class: 'json-view text-subtle' }, '—');
  const text = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  // Light syntax highlight
  const html = esc(text)
    .replace(/("(?:[^"\\]|\\.)*")(\s*:)/g, '<span class="json-key">$1</span>$2')
    .replace(/: ("(?:[^"\\]|\\.)*")/g, ': <span class="json-str">$1</span>')
    .replace(/: (-?\d+(?:\.\d+)?)/g, ': <span class="json-num">$1</span>')
    .replace(/: (true|false)/g, ': <span class="json-bool">$1</span>')
    .replace(/: null/g, ': <span class="json-null">null</span>');
  return el('pre', { class: 'json-view', html });
}

/* ══════════════════════════════════════════════════════════════════
   ▓▓▓▓▓ DEV HOME PAGE  ▓▓▓▓▓
   ══════════════════════════════════════════════════════════════════ */
function renderHome() {
  const root = el('div', { class: 'stack stack--lg' });
  const tokens = state.data.tokens || [];
  const usage = state.data.myUsage || [];
  const limits = state.data.myLimits || [];
  const agg = aggregateUsage(usage);
  const myEmail = state.user?.email || 'there';
  const firstName = (state.user?.email || '').split('@')[0].split('.')[0];
  const helloName = firstName ? firstName[0].toUpperCase() + firstName.slice(1) : myEmail;
  const baseUrl = `${location.protocol}//${location.host}`;

  // Hello header
  root.appendChild(el('div', { class: 'hello' },
    el('h1', {}, `Hi, ${helloName}.`),
    el('span', { class: 'role-chip', data: { role: state.user?.role || 'developer' } }, state.user?.role || 'developer'),
  ));

  // Quick start
  const hasToken = tokens.length > 0;
  if (!hasToken) {
    const curl = `curl ${baseUrl}/v1/messages \\\n  -H "x-api-key: <YOUR_TOKEN>" \\\n  -H "content-type: application/json" \\\n  -d '{"model":"claude-3-5-sonnet-latest","max_tokens":256,"messages":[{"role":"user","content":"hello"}]}'`;
    root.appendChild(el('div', { class: 'qs-card' },
      el('h2', {}, 'Get started'),
      el('p', {}, 'Issue your first token and call the gateway. The token is the only thing your app needs — provider keys stay in here.'),
      el('div', { class: 'qs-row' },
        el('span', { class: 'label' }, 'Base URL'),
        el('span', { class: 'mono fs-13' }, baseUrl),
      ),
      el('div', { class: 'code mt-3' }, curl,
        el('button', { class: 'btn btn--ghost btn--sm copy-btn', on: { click: () => copyToClipboard(curl) } }, icon('copy', 14), 'Copy')),
      el('div', { class: 'flex gap-2 mt-3' },
        el('button', { class: 'btn btn--primary', on: { click: openSelfNewToken } }, icon('plus', 14), 'Create my first token'),
      ),
    ));
  } else {
    root.appendChild(el('div', { class: 'qs-card' },
      el('div', { class: 'flex justify-between items-center' },
        el('div', {},
          el('div', { class: 'fs-12 text-subtle', style: { textTransform: 'uppercase', letterSpacing: '.08em' } }, 'Base URL'),
          el('div', { class: 'mono fs-13 mt-1' }, baseUrl),
        ),
        el('button', { class: 'btn btn--ghost btn--sm', on: { click: () => copyToClipboard(baseUrl) } }, icon('copy', 14), 'Copy'),
      ),
    ));
  }

  // KPI strip
  root.appendChild(el('div', { class: 'grid-4' },
    kpi({ label: 'Requests · 24h', value: fmt.num(agg.requests), iconName: 'activity' }),
    kpi({ label: 'Tokens · 24h',   value: fmt.num(agg.tokens),   iconName: 'hash' }),
    kpi({ label: 'Spend · 24h',    value: fmt.usd(agg.usd),      iconName: 'dollar' }),
    kpi({ label: 'Active tokens',  value: fmt.int(tokens.length),iconName: 'token' }),
  ));

  // Cap headroom
  const headroomBody = limits.length
    ? el('div', {}, ...limits.map(l => {
        const used = (usage.filter(u => u.provider === l.provider).reduce((s, u) => s + Number(u.usd || 0), 0));
        return progressRow({
          providerKey: l.provider,
          label: PROVIDER_LABEL[l.provider] || l.provider,
          used,
          cap: Number(l.daily_usd || 0),
        });
      }))
    : emptyState({ iconName: 'shield', title: 'No caps configured', sub: 'Your role and per-user overrides aren\'t set yet. Ask an admin if you need limits in place.' });
  root.appendChild(card({
    title: 'Cap headroom',
    sub: 'Today\'s spend versus your daily $ cap',
    flush: true,
    body: el('div', { style: { padding: '8px 18px 12px' } }, headroomBody),
  }));

  // Tokens
  const tokenBody = tokens.length
    ? el('div', { class: 'table-wrap' },
        el('table', { class: 'tbl tbl-collapse' },
          el('thead', {}, el('tr', {},
            el('th', {}, 'Prefix'),
            el('th', {}, 'Label'),
            el('th', {}, 'Last used'),
            el('th', {}, 'Created'),
            el('th', { class: 'right' }, 'Status'),
          )),
          el('tbody', {}, ...tokens.map(t => el('tr', {},
            el('td', { data: { label: 'Prefix' }, class: 'mono fs-12' }, t.token_prefix || '—'),
            el('td', { data: { label: 'Label' } }, t.label || '—'),
            el('td', { data: { label: 'Last used' }, class: 'fs-12 text-muted' }, fmt.ago(t.last_used_at)),
            el('td', { data: { label: 'Created' }, class: 'fs-12 text-muted' }, fmt.ago(t.created_at)),
            el('td', { data: { label: 'Status' }, class: 'right' },
              el('div', { class: 'flex gap-2 items-center justify-end' },
                t.enabled === false || t.enabled === 0
                  ? el('span', { class: 'pill' }, 'revoked')
                  : el('span', { class: 'pill pill--success' }, el('span', { class: 'dot' }), 'active'),
                el('button', { class: 'btn btn--ghost btn--sm', title: 'Delete this token permanently', on: { click: () => selfDeleteToken(t) } }, icon('trash', 12)),
              ),
            ),
          ))),
        ),
      )
    : emptyState({
        iconName: 'token',
        title: 'No tokens yet',
        sub: 'Create one to start calling the gateway. The raw token is shown only once.',
        action: el('button', { class: 'btn btn--primary', on: { click: openSelfNewToken } }, icon('plus', 14), 'Create token'),
      });

  root.appendChild(card({
    title: 'My tokens',
    sub: tokens.length ? `${tokens.length} on file.` : null,
    actions: tokens.length ? el('button', { class: 'btn btn--primary btn--sm', on: { click: openSelfNewToken } }, icon('plus', 14), 'New token') : null,
    flush: true,
    body: tokenBody,
  }));

  return root;
}

async function selfDeleteToken(t) {
  const ok = await confirmDialog({
    title: 'Delete this token?',
    message: `Hard-delete ${t.token_prefix}… (${t.label || 'unlabeled'}). Apps using it will start failing immediately. This cannot be undone.`,
    danger: true, confirmLabel: 'Delete',
  });
  if (!ok) return;
  try {
    await api(`/api/me/tokens/${t.id}`, { method: 'DELETE' });
    toast('Token deleted');
    refresh();
  } catch (e) { toast(e.message, 'error'); }
}

function openSelfNewToken() {
  let label = 'personal';
  let createdToken = null;
  const formBody = el('div', { class: 'field-group', id: 'newTokenForm' },
    el('div', { class: 'field' },
      el('label', { class: 'field-label' }, 'Label'),
      el('input', { value: label, on: { input: (e) => label = e.target.value } }),
      el('p', { class: 'field-hint' }, 'A short name to identify the token (e.g. "web", "my-mac").'),
    ),
  );
  const revealBody = el('div', { class: 'stack hidden' });
  const body = el('div', {}, formBody, revealBody);
  const primary = el('button', { class: 'btn btn--primary', on: { click: submit } }, icon('plus', 14), 'Create token');
  const footer = el('div', { class: 'flex gap-2', style: { width: '100%' } },
    el('div', { class: 'spacer' }),
    el('button', { class: 'btn btn--ghost', on: { click: () => d.close() } }, 'Done'),
    primary,
  );

  async function submit() {
    if (!label.trim()) return toast('Label is required', 'error');
    try {
      const r = await api('/api/me/tokens', { method: 'POST', body: JSON.stringify({ label: label.trim() }) });
      createdToken = r.token;
      formBody.classList.add('hidden');
      revealBody.classList.remove('hidden');
      revealBody.replaceChildren(
        el('div', { class: 'alert alert--success' }, icon('check', 14),
          el('div', {}, el('div', { class: 'fw-600' }, 'Token created'),
            el('div', { class: 'fs-12 mt-1' }, 'Copy it now — for security, you won\'t see it again.'))),
        el('div', { class: 'code mt-2' }, createdToken,
          el('button', { class: 'btn btn--ghost btn--sm copy-btn', on: { click: () => copyToClipboard(createdToken) } },
            icon('copy', 14), 'Copy')),
      );
      primary.classList.add('hidden');
      refresh();
    } catch (e) { toast(e.message, 'error'); }
  }
  const d = drawer({ title: 'Create token', subtitle: 'One-time secret — you\'ll see it once.', body, footer });
}

/* ══════════════════════════════════════════════════════════════════
   ▓▓▓▓▓ SPEND (dev) ▓▓▓▓▓
   ══════════════════════════════════════════════════════════════════ */
function renderSpend() {
  const root = el('div', { class: 'stack stack--lg' });
  const usage = state.data.myUsage || [];
  const agg = aggregateUsage(usage);
  root.appendChild(el('div', { class: 'grid-3' },
    kpi({ label: 'Requests · 24h', value: fmt.num(agg.requests), iconName: 'activity' }),
    kpi({ label: 'Tokens · 24h',   value: fmt.num(agg.tokens),   iconName: 'hash' }),
    kpi({ label: 'Spend · 24h',    value: fmt.usd(agg.usd),      iconName: 'dollar' }),
  ));
  if (!usage.length) {
    root.appendChild(card({ flush: true, body: emptyState({
      iconName: 'bar', title: 'No usage in the last 24h',
      sub: 'Once your app starts calling the gateway, every request will appear here.',
    })}));
    return root;
  }
  const q = (state.filters.q || '').toLowerCase();
  const rows = usage.filter(r => !q || (r.model || '').toLowerCase().includes(q) || (r.provider || '').toLowerCase().includes(q));
  root.appendChild(card({
    title: 'Breakdown',
    sub: 'By provider × model',
    flush: true,
    body: el('div', { class: 'table-wrap' },
      el('table', { class: 'tbl tbl-collapse' },
        el('thead', {}, el('tr', {},
          el('th', {}, 'Provider'),
          el('th', {}, 'Model'),
          el('th', { class: 'right' }, 'Requests'),
          el('th', { class: 'right' }, 'Tokens'),
          el('th', { class: 'right' }, 'Spend'),
        )),
        el('tbody', {}, ...rows.map(r => el('tr', {},
          el('td', { data: { label: 'Provider' } },
            el('span', { class: 'flex items-center gap-2' },
              el('span', { class: 'provider-mark', data: { provider: r.provider } }, PROVIDER_GLYPH[r.provider] || '?'),
              el('span', {}, PROVIDER_LABEL[r.provider] || r.provider))),
          el('td', { data: { label: 'Model' }, class: 'mono fs-12' }, r.model || '—'),
          el('td', { data: { label: 'Requests' }, class: 'right num' }, fmt.int(r.requests)),
          el('td', { data: { label: 'Tokens' }, class: 'right num' }, fmt.num(r.tokens)),
          el('td', { data: { label: 'Spend' }, class: 'right num fw-500' }, fmt.usd(r.usd)),
        ))),
      ),
    ),
  }));
  return root;
}

/* ══════════════════════════════════════════════════════════════════
   TEST AS USER  (admin)
   ══════════════════════════════════════════════════════════════════ */
function openTestAsUser(initialUser) {
  let userId = initialUser?.id ? String(initialUser.id) : '', provider = 'anthropic', dryRun = true;
  const resultEl = el('div');
  const body = el('div', { class: 'field-group' },
    el('p', { class: 'text-muted' }, 'Simulate a request as a specific user to verify routing and limits.'),
    el('div', { class: 'field' },
      el('label', { class: 'field-label' }, 'User'),
      el('select', { on: { change: (e) => userId = e.target.value } },
        el('option', { value: '' }, 'Select…'),
        ...(state.data.users || []).map(u => el('option', { value: u.id, selected: String(u.id) === userId ? 'selected' : null }, u.email)),
      ),
    ),
    el('div', { class: 'field-row' },
      el('div', { class: 'field' },
        el('label', { class: 'field-label' }, 'Provider'),
        el('select', { on: { change: (e) => provider = e.target.value } },
          ...PROVIDERS.map(p => el('option', { value: p, selected: p === provider ? 'selected' : null }, PROVIDER_LABEL[p]))),
      ),
      el('div', { class: 'row-toggle' },
        el('div', { class: 'label' }, 'Dry run'),
        el('label', { class: 'switch' },
          el('input', { type: 'checkbox', checked: dryRun, on: { change: (e) => dryRun = e.target.checked } }),
          el('span', { class: 'switch__track' }), el('span', { class: 'switch__thumb' }),
        ),
      ),
    ),
    resultEl,
  );
  const footer = el('div', { class: 'flex gap-2', style: { width: '100%' } },
    el('div', { class: 'spacer' }),
    el('button', { class: 'btn btn--ghost', on: { click: () => d.close() } }, 'Close'),
    el('button', { class: 'btn btn--primary', on: { click: run } }, icon('zap', 14), 'Run'),
  );
  async function run() {
    if (!userId) return toast('Select a user', 'error');
    try {
      const r = await api('/admin/test-as-user', { method: 'POST', body: JSON.stringify({ userId: Number(userId), provider, dryRun }) });
      resultEl.replaceChildren(jsonView(r));
    } catch (e) { toast(e.message, 'error'); }
  }
  const d = drawer({ title: 'Test as user', subtitle: 'Dry-run a request through the gateway', body, footer });
}

/* ══════════════════════════════════════════════════════════════════
   GLOBAL EVENT WIRING
   ══════════════════════════════════════════════════════════════════ */
function wireGlobals() {
  $('#signInBtn')?.addEventListener('click', signIn);
  $('#signOutBtn')?.addEventListener('click', signOut);
  $('#refreshBtn')?.addEventListener('click', refresh);
  $('#navToggle')?.addEventListener('click', () => {
    const sb = $('#sidebar'), bd = $('#sidebarBackdrop');
    sb.classList.toggle('open');
    if (sb.classList.contains('open')) {
      bd.classList.remove('hidden');
      requestAnimationFrame(() => bd.classList.add('show'));
    } else {
      bd.classList.remove('show');
      setTimeout(() => bd.classList.add('hidden'), 200);
    }
  });
  $('#sidebarBackdrop')?.addEventListener('click', () => {
    $('#sidebar').classList.remove('open');
    $('#sidebarBackdrop').classList.remove('show');
    setTimeout(() => $('#sidebarBackdrop').classList.add('hidden'), 200);
  });

  // Settings menu toggle + outside-click close
  $('#settingsToggle')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = $('#settingsPanel').classList.contains('open');
    open ? closeSettings() : openSettings();
  });
  document.addEventListener('click', (e) => {
    const menu = $('#settingsMenu');
    if (menu && !menu.contains(e.target)) closeSettings();
  });

  // Filter input → live re-render of current view
  $('#globalSearch')?.addEventListener('input', (e) => {
    state.filters.q = e.target.value || '';
    if (state.view === 'usage' && state._usageRerender) state._usageRerender();
    else if (state.view === 'audit' && state._auditRerender) state._auditRerender();
    else render();
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select')) return;
    if (e.key === '/') { e.preventDefault(); $('#globalSearch')?.focus(); }
    else if (e.key === 'r' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); if (!$('#app').classList.contains('hidden')) refresh(); }
  });

  // Login form keyboard
  $('#devAdminKey')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      // Treat as direct admin sign-in: try fetching /admin/users with the key
      const k = $('#devAdminKey').value.trim();
      if (!k) return;
      $('#login').classList.add('hidden');
      $('#app').classList.remove('hidden');
      // Synthesize a minimal user; ensureSession isn't applicable here.
      state.user = { email: 'dev-admin', role: 'admin', isAdmin: true };
      const email = 'dev-admin';
      $('#userEmail').textContent = email;
      $('#userRole').textContent = 'admin';
      $('#userAvatar').textContent = 'D';
      $('#envLabel').textContent = location.hostname.includes('localhost') ? 'local dev' : 'production';
      renderNav();
      renderSettingsPanel();
      // Carry the key into the inline input for subsequent api() calls.
      const inline = $('#adminKeyInline'); if (inline) inline.value = k;
      router();
      refresh();
    }
  });
}

/* ══════════════════════════════════════════════════════════════════
   ▓▓▓▓▓ FUSION (dev + admin) ▓▓▓▓▓
   ══════════════════════════════════════════════════════════════════ */

// Built-in preset definitions (mirrors server-side presets.ts)
// Provider colors for fusion model badges
const FUSION_PROVIDER_COLORS = {
  anthropic: '#d97706',
  openai_codex: '#10b981',
  openai: '#10b981',
  gemini: '#3b82f6',
  openrouter: '#8b5cf6',
  groq: '#f97316',
  cerebras: '#06b6d4',
  kimi: '#ec4899',
  glm: '#14b8a6',
  xai: '#ef4444',
  runpod: '#6366f1',
};

/** Render a provider/model string as a badged element: [provider] model-name */
/** Summarize a FusionThinkingConfig (per-model keyed) as compact badges */
function fusionThinkingSummary(thinking) {
  if (!thinking || !Object.keys(thinking).length) return el('span', { class: 'fs-11 text-muted' }, 'default');
  const pills = [];
  for (const [modelKey, config] of Object.entries(thinking)) {
    const provider = modelKey.split('/')[0];
    const shortModel = modelKey.split('/').slice(1).join('/').split('-')[0] || modelKey;
    const color = FUSION_PROVIDER_COLORS[provider] || '#6b7280';
    let label = '';
    if (typeof config === 'string') {
      label = config; // xai: 'reasoning'
    } else if (config && typeof config === 'object') {
      const parts = [];
      if (config.thinking?.type) parts.push(config.thinking.type);
      if (config.effort) parts.push(config.effort);
      if (config.thinkingBudget) parts.push(config.thinkingBudget + 't');
      label = parts.join('+');
    }
    if (label) {
      pills.push(el('span', { style: { fontSize: '10px', color, background: color + '18', padding: '1px 5px', borderRadius: '3px', fontWeight: 600 } }, shortModel + ':' + label));
    }
  }
  return el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '3px' } }, ...pills);
}

function fusionModelBadge(providerModel) {
  const parts = (providerModel || '').split('/');
  const provider = parts[0] || '?';
  const model = parts.slice(1).join('/') || providerModel;
  const color = FUSION_PROVIDER_COLORS[provider] || 'var(--text-muted)';
  return el('span', { class: 'fusion-model-badge', style: { display: 'inline-flex', alignItems: 'center', gap: '4px' } },
    el('span', {
      class: 'fusion-provider-tag',
      style: {
        fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em',
        color, background: color + '18', padding: '1px 5px', borderRadius: '3px', lineHeight: '1.4',
      },
    }, provider.replace('openai_codex', 'openai').replace('openrouter', 'openrouter')),
    el('span', { style: { fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' } }, model),
  );
}

/** Render a list of provider/model strings as badged pills inline */
function fusionModelBadgeList(models) {
  if (!models || !models.length) return el('span', { class: 'text-muted fs-12' }, '\u2014');
  return el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px 8px', alignItems: 'center' } },
    ...models.map(m => fusionModelBadge(m)),
  );
}

const FUSION_BUILTIN_PRESETS = [
  {
    name: 'max',
    panel: ['anthropic/claude-opus-4-8', 'openai_codex/gpt-5.5', 'openrouter/google/gemini-3.1-pro-preview'],
    synthesizer: 'anthropic/claude-opus-4-8',
    panel_max_tokens: 4096,
    synthesizer_max_tokens: 8192,
    thinking: { 'anthropic/claude-opus-4-8': { thinking: { type: 'adaptive' }, effort: 'max' }, 'openai_codex/gpt-5.5': { effort: 'xhigh' } },
    builtin: true,
  },
  {
    name: 'quality',
    panel: ['anthropic/claude-opus-4-8', 'openai_codex/gpt-5.5', 'openrouter/google/gemini-3.1-pro-preview'],
    synthesizer: 'anthropic/claude-opus-4-8',
    panel_max_tokens: 4096,
    synthesizer_max_tokens: 8192,
    thinking: { 'anthropic/claude-opus-4-8': { thinking: { type: 'adaptive' }, effort: 'xhigh' }, 'openai_codex/gpt-5.5': { effort: 'high' } },
    builtin: true,
  },
  {
    name: 'budget',
    panel: ['anthropic/claude-sonnet-4-5-20250929', 'openai_codex/gpt-5.4', 'gemini/gemini-3.5-flash'],
    synthesizer: 'anthropic/claude-sonnet-4-5-20250929',
    panel_max_tokens: 4096,
    synthesizer_max_tokens: 8192,
    thinking: { 'anthropic/claude-sonnet-4-5-20250929': { effort: 'medium' }, 'openai_codex/gpt-5.4': { effort: 'medium' } },
    builtin: true,
  },
];

function renderFusion() {
  const root = el('div', { class: 'stack stack--lg' });

  // Section 1: Presets
  const presetsContainer = el('div', { id: 'fusionPresetsBody' });
  root.appendChild(card({
    title: 'Presets',
    sub: 'Built-in and custom multi-model presets',
    actions: el('button', { class: 'btn btn--primary btn--sm', on: { click: async () => { const m = await getFusionAvailableModels(); openFusionPresetForm(null, m); } } }, icon('plus', 14), 'Create preset'),
    flush: true,
    body: presetsContainer,
  }));

  // Section 2: Call History
  const callsContainer = el('div', { id: 'fusionCallsBody' });
  root.appendChild(card({
    title: 'Call history',
    sub: 'Recent fusion calls (last 50)',
    flush: true,
    body: callsContainer,
  }));

  // Load data
  loadFusionPresets(presetsContainer);
  loadFusionCalls(callsContainer);

  return root;
}

async function loadFusionPresets(container) {
  container.replaceChildren(el('div', { class: 'view-loading', style: { padding: '24px' } }, el('div', { class: 'spinner' }), el('span', {}, 'Loading presets…')));
  try {
    const res = await api('/api/me/fusion-presets');
    const custom = res.presets || [];
    renderFusionPresetsList(container, custom);
  } catch (e) {
    container.replaceChildren(el('div', { style: { padding: '18px' } }, el('span', { class: 'text-danger' }, 'Failed to load presets: ' + e.message)));
  }
}

function renderFusionPresetsList(container, customPresets) {
  const all = [...FUSION_BUILTIN_PRESETS.map(p => ({ ...p, builtin: true })), ...customPresets.map(p => ({ ...p, builtin: false }))];
  if (!all.length) {
    container.replaceChildren(emptyState({ iconName: 'zap', title: 'No presets', sub: 'Create a custom preset to get started.' }));
    return;
  }

  const table = el('table', { class: 'tbl tbl-collapse' },
    el('thead', {}, el('tr', {},
      el('th', {}, 'Name'),
      el('th', {}, 'Panel models'),
      el('th', {}, 'Synthesizer'),
      el('th', {}, 'Thinking'),
      el('th', {}, 'Created'),
      el('th', { class: 'right' }, ''),
    )),
    el('tbody', {}, ...all.map(p => {
      const panelModels = Array.isArray(p.panel) ? p.panel : [];
      const thinking = p.thinking || {};
      return el('tr', {},
        el('td', { data: { label: 'Name' } },
          el('div', { class: 'flex items-center gap-2' },
            el('span', { class: 'mono fs-13 fw-600' }, 'fusion/' + p.name),
            p.builtin ? el('span', { class: 'pill pill--ghost' }, 'built-in') : null,
          ),
        ),
        el('td', { data: { label: 'Panel' } }, fusionModelBadgeList(panelModels)),
        el('td', { data: { label: 'Synthesizer' } }, fusionModelBadge(p.synthesizer)),
        el('td', { data: { label: 'Thinking' } }, fusionThinkingSummary(thinking)),
        el('td', { data: { label: 'Created' }, class: 'fs-12 text-muted' }, p.builtin ? '—' : fmt.ago(p.created_at)),
        el('td', { data: { label: '' }, class: 'right' },
          p.builtin ? null : el('div', { class: 'flex gap-2 items-center justify-end' },
            el('button', { class: 'btn btn--ghost btn--sm', title: 'Edit', on: { click: async () => { const m = await getFusionAvailableModels(); openFusionPresetForm(p, m); } } }, icon('edit', 12)),
            el('button', { class: 'btn btn--danger btn--sm', title: 'Delete', on: { click: () => deleteFusionPreset(p.name) } }, icon('trash', 12)),
          ),
        ),
      );
    })),
  );
  container.replaceChildren(el('div', { class: 'table-wrap' }, table));
}

// ─── Model combobox (typeahead + dropdown) ────────────────────────────────
// Fetches available models once, caches in module scope.
let _fusionAvailableModels = null;
async function getFusionAvailableModels() {
  if (_fusionAvailableModels) return _fusionAvailableModels;
  try {
    const res = await api('/api/me/fusion-available-models');
    _fusionAvailableModels = (res.models || []).map(m => m.id);
  } catch {
    _fusionAvailableModels = [];
  }
  return _fusionAvailableModels;
}

/**
 * Build a combobox: text input with a filterable dropdown of known models.
 * Accepts free text too (power users can type any provider/model).
 * @param {string} value - initial value
 * @param {(val: string) => void} onChange - called on every change
 * @param {string[]} options - available model ids
 */
function modelCombobox(value, onChange, options) {
  let open = false;
  let filter = value || '';

  const wrap = el('div', { class: 'model-combobox', style: { position: 'relative', flex: '1' } });

  const input = el('input', {
    class: 'form-input',
    style: { width: '100%', height: '32px', fontSize: '12px', fontFamily: 'var(--font-mono)', paddingRight: '28px' },
    value: filter,
    placeholder: 'Type or select a model…',
    autocomplete: 'off',
    on: {
      input: (e) => {
        filter = e.target.value;
        onChange(filter);
        open = true;
        renderDropdown();
      },
      focus: () => { open = true; renderDropdown(); },
    },
  });

  const chevron = el('span', {
    style: { position: 'absolute', right: '8px', top: '8px', cursor: 'pointer', color: 'var(--text-muted)', lineHeight: '1' },
    on: { click: () => { open = !open; if (open) input.focus(); renderDropdown(); } },
  }, icon('chevron', 14));

  const dropdown = el('div', {
    class: 'model-combobox-dropdown',
    style: {
      position: 'absolute', top: '34px', left: 0, right: 0, zIndex: 100,
      maxHeight: '200px', overflowY: 'auto', display: 'none',
      background: 'var(--surface-2, #1e1e2e)', border: '1px solid var(--border, #333)',
      borderRadius: '6px', boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
    },
  });

  function renderDropdown() {
    if (!open || !options.length) { dropdown.style.display = 'none'; return; }
    const q = filter.toLowerCase();
    const filtered = q ? options.filter(m => m.toLowerCase().includes(q)) : options;
    if (!filtered.length) { dropdown.style.display = 'none'; return; }
    dropdown.style.display = 'block';
    dropdown.replaceChildren(
      ...filtered.slice(0, 30).map(m => {
        const parts = m.split('/');
        const provider = parts[0];
        const model = parts.slice(1).join('/');
        return el('div', {
          class: 'model-combobox-option',
          style: {
            padding: '6px 10px', cursor: 'pointer', fontSize: '12px',
            fontFamily: 'var(--font-mono)', display: 'flex', gap: '6px', alignItems: 'center',
          },
          on: {
            click: () => {
              filter = m;
              input.value = m;
              onChange(m);
              open = false;
              renderDropdown();
            },
            mouseenter: (e) => { e.target.style.background = 'var(--surface-3, #2a2a3e)'; },
            mouseleave: (e) => { e.target.style.background = 'transparent'; },
          },
        },
          el('span', { style: { color: 'var(--accent, #7c5cfc)', fontWeight: 600, minWidth: '80px' } }, provider),
          el('span', { style: { color: 'var(--text-muted, #888)' } }, model),
        );
      }),
    );
  }

  // Close dropdown on outside click
  setTimeout(() => {
    document.addEventListener('click', (e) => {
      if (!wrap.contains(e.target)) { open = false; renderDropdown(); }
    });
  }, 0);

  wrap.append(input, chevron, dropdown);
  return wrap;
}

function openFusionPresetForm(existing = null, availableModels = []) {
  const isEdit = !!existing;
  let name = existing?.name || '';
  let panel = existing?.panel ? [...existing.panel] : [''];
  let synthesizer = existing?.synthesizer || '';
  let panelMaxTokens = existing?.panel_max_tokens ?? 4096;
  let synthMaxTokens = existing?.synthesizer_max_tokens ?? 8192;
  let thinkingConfig = existing?.thinking ? JSON.parse(JSON.stringify(existing.thinking)) : {};

  const errEl = el('div', { class: 'field-error', style: { minHeight: '16px' } });

  // Panel models list
  const panelList = el('div', { class: 'stack', style: { gap: '6px' } });

  function rebuildPanelInputs() {
    panelList.replaceChildren(
      ...panel.map((m, i) =>
        el('div', { class: 'flex gap-2 items-center' },
          modelCombobox(m, (val) => { panel[i] = val; rebuildThinkingSection(); }, availableModels),
          panel.length > 1
            ? el('button', { class: 'iconbtn', title: 'Remove', on: { click: () => { panel.splice(i, 1); rebuildPanelInputs(); rebuildThinkingSection(); } } }, icon('minus', 14))
            : null,
        )
      ),
      panel.length < 8
        ? el('button', { class: 'btn btn--ghost btn--sm', on: { click: () => { panel.push(''); rebuildPanelInputs(); rebuildThinkingSection(); } } }, icon('plus', 12), 'Add model')
        : null,
    );
  }
  rebuildPanelInputs();

  const nameInput = el('input', {
    class: 'form-input',
    style: { height: '32px', fontSize: '12px', fontFamily: 'var(--font-mono)' },
    value: name,
    placeholder: 'my-research',
    disabled: isEdit,
    on: { input: (e) => { name = e.target.value; } },
  });

  const synthCombobox = modelCombobox(synthesizer, (val) => { synthesizer = val; rebuildThinkingSection(); }, availableModels);

  const panelMaxInput = el('input', {
    class: 'form-input',
    style: { height: '32px', fontSize: '12px', width: '100px' },
    type: 'number',
    value: panelMaxTokens,
    on: { input: (e) => { panelMaxTokens = parseInt(e.target.value) || 4096; } },
  });

  const synthMaxInput = el('input', {
    class: 'form-input',
    style: { height: '32px', fontSize: '12px', width: '100px' },
    type: 'number',
    value: synthMaxTokens,
    on: { input: (e) => { synthMaxTokens = parseInt(e.target.value) || 8192; } },
  });

  const thinkingSection = el('div', { class: 'stack', style: { gap: '8px' } });

  function rebuildThinkingSection() {
    const allModels = [...new Set([...panel.filter(Boolean), synthesizer].filter(Boolean))];
    const fields = [];

    for (const modelKey of allModels) {
      const provider = modelKey.split('/')[0];
      const shortModel = modelKey.split('/').slice(1).join('/');
      const color = FUSION_PROVIDER_COLORS[provider] || '#6b7280';
      const cur = thinkingConfig[modelKey] || {};
      const curObj = typeof cur === 'object' ? cur : {};
      const curStr = typeof cur === 'string' ? cur : '';

      if (provider === 'anthropic') {
        const typeVal = curObj.thinking?.type || 'default';
        const effortVal = curObj.effort || 'default';
        const typeSelect = el('select', {
          class: 'form-input', style: { height: '28px', fontSize: '11px', width: '115px' },
          on: { change: (e) => {
            if (e.target.value === 'default') { if (thinkingConfig[modelKey]) delete thinkingConfig[modelKey].thinking; if (thinkingConfig[modelKey] && !Object.keys(thinkingConfig[modelKey]).length) delete thinkingConfig[modelKey]; rebuildThinkingSection(); return; }
            thinkingConfig[modelKey] = thinkingConfig[modelKey] || {};
            thinkingConfig[modelKey].thinking = { type: e.target.value };
            rebuildThinkingSection();
          }},
        },
          el('option', { value: 'default', ...(typeVal==='default'?{selected:'selected'}:{}) }, 'Default'),
          el('option', { value: 'adaptive', ...(typeVal==='adaptive'?{selected:'selected'}:{}) }, 'Adaptive'),
          el('option', { value: 'enabled', ...(typeVal==='enabled'?{selected:'selected'}:{}) }, 'Enabled'),
          el('option', { value: 'disabled', ...(typeVal==='disabled'?{selected:'selected'}:{}) }, 'Disabled'),
        );
        const budgetInput = typeVal === 'enabled' ? el('input', {
          class: 'form-input', style: { height: '28px', fontSize: '11px', width: '80px' },
          type: 'number', value: curObj.thinking?.budget_tokens || 10000,
          on: { input: (e) => { thinkingConfig[modelKey] = thinkingConfig[modelKey] || {}; thinkingConfig[modelKey].thinking = { ...thinkingConfig[modelKey].thinking, type: 'enabled', budget_tokens: parseInt(e.target.value) || 10000 }; } },
        }) : null;
        const effortSelect = el('select', {
          class: 'form-input', style: { height: '28px', fontSize: '11px', width: '80px' },
          on: { change: (e) => {
            if (e.target.value === 'default') { if (thinkingConfig[modelKey]) delete thinkingConfig[modelKey].effort; if (thinkingConfig[modelKey] && !Object.keys(thinkingConfig[modelKey]).length) delete thinkingConfig[modelKey]; return; }
            thinkingConfig[modelKey] = thinkingConfig[modelKey] || {}; thinkingConfig[modelKey].effort = e.target.value;
          }},
        },
          ...['default','low','medium','high','xhigh','max'].map(v =>
            el('option', { value: v, ...(effortVal===v?{selected:'selected'}:{}) }, v === 'default' ? 'Default' : v)
          ),
        );
        fields.push(el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '5px', alignItems: 'center', padding: '4px 0' } },
          fusionModelBadge(modelKey),
          typeSelect, budgetInput,
          el('span', { class: 'fs-10 text-muted' }, 'effort:'), effortSelect,
        ));
      } else if (provider === 'openai_codex' || provider === 'openai') {
        const effortVal = curObj.effort || 'default';
        const effortSelect = el('select', {
          class: 'form-input', style: { height: '28px', fontSize: '11px', width: '100px' },
          on: { change: (e) => {
            if (e.target.value === 'default') { delete thinkingConfig[modelKey]; return; }
            thinkingConfig[modelKey] = { effort: e.target.value };
          }},
        },
          ...['default','none','minimal','low','medium','high','xhigh'].map(v =>
            el('option', { value: v, ...(effortVal===v||(!curObj.effort&&v==='default')?{selected:'selected'}:{}) }, v === 'default' ? 'Default' : v)
          ),
        );
        fields.push(el('div', { style: { display: 'flex', gap: '5px', alignItems: 'center', padding: '4px 0' } },
          fusionModelBadge(modelKey),
          el('span', { class: 'fs-10 text-muted' }, 'effort:'), effortSelect,
        ));
      } else if (provider === 'xai') {
        const xaiSelect = el('select', {
          class: 'form-input', style: { height: '28px', fontSize: '11px', width: '130px' },
          on: { change: (e) => { if (e.target.value === 'default') { delete thinkingConfig[modelKey]; return; } thinkingConfig[modelKey] = e.target.value; } },
        },
          el('option', { value: 'default', ...(!curStr?{selected:'selected'}:{}) }, 'Default'),
          el('option', { value: 'reasoning', ...(curStr==='reasoning'?{selected:'selected'}:{}) }, 'Reasoning'),
          el('option', { value: 'non-reasoning', ...(curStr==='non-reasoning'?{selected:'selected'}:{}) }, 'Non-reasoning'),
        );
        fields.push(el('div', { style: { display: 'flex', gap: '5px', alignItems: 'center', padding: '4px 0' } },
          fusionModelBadge(modelKey), xaiSelect,
        ));
      } else if (provider === 'gemini' || provider === 'openrouter') {
        const budgetInput = el('input', {
          class: 'form-input', style: { height: '28px', fontSize: '11px', width: '90px' },
          type: 'number', value: curObj.thinkingBudget || '', placeholder: 'tokens',
          on: { input: (e) => { const v = parseInt(e.target.value); if (v > 0) thinkingConfig[modelKey] = { thinkingBudget: v }; else delete thinkingConfig[modelKey]; } },
        });
        fields.push(el('div', { style: { display: 'flex', gap: '5px', alignItems: 'center', padding: '4px 0' } },
          fusionModelBadge(modelKey),
          el('span', { class: 'fs-10 text-muted' }, 'budget:'), budgetInput,
        ));
      }
      // groq, cerebras, kimi, runpod — no thinking support, skip
    }

    if (!fields.length) {
      thinkingSection.replaceChildren(el('p', { class: 'fs-11 text-muted' }, 'Add models above to see thinking options.'));
    } else {
      thinkingSection.replaceChildren(...fields);
    }
  }
  rebuildThinkingSection();

  const body = el('div', { class: 'field-group' },
    el('div', { class: 'field' },
      el('label', { class: 'field-label' }, 'Preset name'),
      nameInput,
      el('p', { class: 'field-hint' }, 'Lowercase letters, digits, hyphens. Used as fusion/<name>.'),
    ),
    el('div', { class: 'field' },
      el('label', { class: 'field-label' }, 'Panel models'),
      panelList,
      el('p', { class: 'field-hint' }, 'Models that reason independently in parallel (1–8).'),
    ),
    el('div', { class: 'field' },
      el('label', { class: 'field-label' }, 'Synthesizer'),
      synthCombobox,
      el('p', { class: 'field-hint' }, 'Model that compares panel responses and writes the final answer.'),
    ),
    el('div', { class: 'field' },
      el('label', { class: 'field-label' }, 'Thinking / Reasoning'),
      thinkingSection,
      el('p', { class: 'field-hint' }, 'Per-provider thinking config. "Default" = provider decides.'),
    ),
    el('div', { class: 'field-row' },
      el('div', { class: 'field' },
        el('label', { class: 'field-label' }, 'Panel max tokens'),
        panelMaxInput,
      ),
      el('div', { class: 'field' },
        el('label', { class: 'field-label' }, 'Synth max tokens'),
        synthMaxInput,
      ),
    ),
    errEl,
  );


  const saveBtn = el('button', { class: 'btn btn--primary', on: { click: submit } },
    icon('check', 14), isEdit ? 'Update' : 'Create',
  );

  const footer = el('div', { class: 'flex gap-2', style: { width: '100%' } },
    el('div', { class: 'spacer' }),
    el('button', { class: 'btn btn--ghost', on: { click: () => d.close() } }, 'Cancel'),
    saveBtn,
  );

  async function submit() {
    errEl.textContent = '';
    const cleanPanel = panel.map(s => s.trim()).filter(Boolean);
    if (!cleanPanel.length) { errEl.textContent = 'At least one panel model is required.'; return; }
    if (!synthesizer.trim()) { errEl.textContent = 'Synthesizer model is required.'; return; }
    if (!isEdit && !name.trim()) { errEl.textContent = 'Name is required.'; return; }

    const payload = {
      ...(isEdit ? {} : { name: name.trim() }),
      panel: cleanPanel,
      synthesizer: synthesizer.trim(),
      panel_max_tokens: panelMaxTokens,
      synthesizer_max_tokens: synthMaxTokens,
      ...(Object.keys(thinkingConfig).length > 0 ? { thinking: thinkingConfig } : {}),
    };

    saveBtn.disabled = true;
    saveBtn.classList.add('loading');
    try {
      if (isEdit) {
        await api(`/api/me/fusion-presets/${existing.name}`, { method: 'PUT', body: JSON.stringify(payload) });
        toast('Preset updated', 'ok');
      } else {
        await api('/api/me/fusion-presets', { method: 'POST', body: JSON.stringify(payload) });
        toast('Preset created', 'ok');
      }
      d.close();
      // Re-render the fusion view
      const container = document.getElementById('fusionPresetsBody');
      if (container) loadFusionPresets(container);
    } catch (e) {
      const msg = e.payload?.details
        ? (Array.isArray(e.payload.details) ? e.payload.details.map(d => d.message).join('; ') : String(e.payload.details))
        : e.message;
      errEl.textContent = msg;
    } finally {
      saveBtn.disabled = false;
      saveBtn.classList.remove('loading');
    }
  }

  const d = drawer({
    title: isEdit ? `Edit preset: ${existing.name}` : 'Create fusion preset',
    subtitle: isEdit ? 'Update panel models, synthesizer, and limits.' : 'Define a custom multi-model preset.',
    body,
    footer,
  });
}

async function deleteFusionPreset(name) {
  const ok = await confirmDialog({
    title: 'Delete this preset?',
    message: `Permanently delete fusion/${name}. Clients using this preset will get 400 errors. This cannot be undone.`,
    danger: true,
    confirmLabel: 'Delete',
  });
  if (!ok) return;
  try {
    await api(`/api/me/fusion-presets/${name}`, { method: 'DELETE' });
    toast('Preset deleted');
    const container = document.getElementById('fusionPresetsBody');
    if (container) loadFusionPresets(container);
  } catch (e) { toast(e.message, 'error'); }
}

async function loadFusionCalls(container) {
  container.replaceChildren(el('div', { class: 'view-loading', style: { padding: '24px' } }, el('div', { class: 'spinner' }), el('span', {}, 'Loading call history…')));
  try {
    const res = await api('/api/me/fusion-calls');
    const calls = res.calls || [];
    renderFusionCallsTable(container, calls);
  } catch (e) {
    container.replaceChildren(el('div', { style: { padding: '18px' } }, el('span', { class: 'text-danger' }, 'Failed to load call history: ' + e.message)));
  }
}

function renderFusionCallsTable(container, calls) {
  if (!calls.length) {
    container.replaceChildren(emptyState({
      iconName: 'zap',
      title: 'No fusion calls yet',
      sub: 'Make your first fusion call via the API and it will show up here.',
    }));
    return;
  }

  const tbody = el('tbody');
  for (const c of calls) {
    const panelModels = Array.isArray(c.panel_models) ? c.panel_models : [];
    const panelBadges = fusionModelBadgeList(panelModels);
    const synthBadge = fusionModelBadge(c.synthesizer_model);
    const latencyText = c.total_latency_ms != null ? (c.total_latency_ms / 1000).toFixed(1) + 's' : '—';
    const costText = c.estimated_cost_usd != null ? fmt.usd(c.estimated_cost_usd) : '—';
    const failedModels = Array.isArray(c.failed_models) ? c.failed_models : [];

    // Summary row
    const summaryRow = el('tr', { class: 'clickable', on: { click: () => toggleFusionCallDetail(summaryRow, detailRow) } },
      el('td', { data: { label: 'Time' }, class: 'fs-12 text-muted nowrap' }, fmt.ago(c.created_at)),
      el('td', { data: { label: 'Preset' } }, el('span', { class: 'mono fs-12' }, c.preset || '—')),
      el('td', { data: { label: 'Panel' } }, panelBadges),
      el('td', { data: { label: 'Result' } },
        el('div', { class: 'flex gap-2 items-center' },
          c.panel_succeeded > 0 ? el('span', { class: 'pill pill--success' }, `${c.panel_succeeded} ok`) : null,
          c.panel_failed > 0 ? el('span', { class: 'pill pill--danger' }, `${c.panel_failed} failed`) : null,
        ),
      ),
      el('td', { data: { label: 'Synthesizer' } }, synthBadge),
      el('td', { data: { label: 'Latency' }, class: 'fs-12 num' }, latencyText),
      el('td', { data: { label: 'Cost' }, class: 'fs-12 num' }, costText),
    );

    // Detail row (hidden by default)
    const detailContent = el('div', { style: { padding: '12px 18px', display: 'flex', flexDirection: 'column', gap: '10px' } });

    // Panel breakdown
    const failedModelNames = failedModels.map(f => typeof f === 'string' ? f : f.model);
    const panelItems = panelModels.map(m => {
      const failed = failedModelNames.includes(m);
      return el('div', { class: 'flex items-center gap-2', style: { padding: '2px 0' } },
        failed ? icon('x', 12, 'text-danger') : icon('check', 12, 'text-success'),
        fusionModelBadge(m),
        failed ? el('span', { class: 'pill pill--danger' }, 'failed') : el('span', { class: 'pill pill--success' }, 'ok'),
      );
    });
    detailContent.appendChild(el('div', {},
      el('div', { class: 'fs-12 fw-600', style: { marginBottom: '6px' } }, 'Panel breakdown'),
      ...panelItems,
    ));

    // Synthesizer status
    const synthStatus = c.synthesizer_skipped
      ? el('span', { class: 'pill pill--ghost' }, 'skipped')
      : c.synthesizer_succeeded
        ? el('span', { class: 'pill pill--success' }, 'ok')
        : el('span', { class: 'pill pill--danger' }, 'failed');
    detailContent.appendChild(el('div', {},
      el('div', { class: 'fs-12 fw-600', style: { marginBottom: '6px' } }, 'Synthesizer'),
      el('div', { class: 'flex items-center gap-2' },
        fusionModelBadge(c.synthesizer_model),
        synthStatus,
      ),
    ));

    // Latency breakdown
    if (c.panel_latency_ms != null || c.synthesizer_latency_ms != null) {
      detailContent.appendChild(el('div', {},
        el('div', { class: 'fs-12 fw-600', style: { marginBottom: '6px' } }, 'Latency'),
        el('div', { class: 'flex gap-4' },
          c.panel_latency_ms != null ? el('span', { class: 'fs-12 text-muted' }, `Panel: ${(c.panel_latency_ms / 1000).toFixed(1)}s`) : null,
          c.synthesizer_latency_ms != null ? el('span', { class: 'fs-12 text-muted' }, `Synthesizer: ${(c.synthesizer_latency_ms / 1000).toFixed(1)}s`) : null,
          c.total_latency_ms != null ? el('span', { class: 'fs-12 text-muted' }, `Total: ${(c.total_latency_ms / 1000).toFixed(1)}s`) : null,
        ),
      ));
    }

    const detailRow = el('tr', { class: 'expanded', style: { display: 'none' } },
      el('td', { colspan: 7, style: { padding: 0 } }, detailContent),
    );

    tbody.appendChild(summaryRow);
    tbody.appendChild(detailRow);
  }

  const table = el('table', { class: 'tbl tbl-collapse' },
    el('thead', {}, el('tr', {},
      el('th', {}, 'Time'),
      el('th', {}, 'Preset'),
      el('th', {}, 'Panel models'),
      el('th', {}, 'Result'),
      el('th', {}, 'Synthesizer'),
      el('th', { class: 'num' }, 'Latency'),
      el('th', { class: 'num' }, 'Cost'),
    )),
    tbody,
  );
  container.replaceChildren(el('div', { class: 'table-wrap' }, table));
}

function toggleFusionCallDetail(summaryRow, detailRow) {
  const isOpen = detailRow.style.display !== 'none';
  detailRow.style.display = isOpen ? 'none' : '';
  summaryRow.classList.toggle('expanded', !isOpen);
}

/* ════════════════════════════════════════════════════════════════
   MONITORING VIEW  (Phase 3 — /admin/metrics/*)
   ════════════════════════════════════════════════════════════════ */
function fmtCostSplit(c) {
  if (!c) return '—';
  const parts = [];
  if (c.metered) parts.push(`${fmt.usd(c.metered)} real`);
  if (c.notional) parts.push(`${fmt.usd(c.notional)} notional`);
  if (c.selfHosted) parts.push(`${fmt.usd(c.selfHosted)} self-hosted`);
  return parts.length ? parts.join(' · ') : '$0';
}
function fmtPct(x) { return x == null ? '—' : (x * 100).toFixed(1) + '%'; }

// Provider glyph badge for monitoring tables — reuses the shared provider-mark styling.
function provMark(provider) {
  return el('span', { class: 'provider-mark provider-mark--sm', data: { provider } }, PROVIDER_GLYPH[provider] || '?');
}
// A provider cell: glyph + name, aligned.
function provCell(provider) {
  return el('td', {}, el('span', { class: 'prov-cell' }, provMark(provider), el('span', {}, provider)));
}
// Colour a rate (0..1) green/amber/red against thresholds. Higher = better by default.
function rateClass(x, { good = 0.7, bad = 0.3, invert = false } = {}) {
  if (x == null) return '';
  const v = invert ? 1 - x : x;
  if (v >= good) return 'val--good';
  if (v <= bad) return 'val--bad';
  return 'val--mid';
}
// Small coloured metric pill for hit-rate / error-rate cells.
function ratePill(x, opts) {
  if (x == null) return el('span', { class: 'text-subtle' }, '—');
  return el('span', { class: 'metric-pill ' + rateClass(x, opts) }, fmtPct(x));
}
// A column header label with a hoverable "?" info badge explaining the metric.
function thInfo(label, help, { align = 'right' } = {}) {
  return el('th', { class: align === 'right' ? 'right' : '' },
    el('span', { class: 'th-info' },
      el('span', {}, label),
      el('span', { class: 'info-badge', tabindex: '0', 'aria-label': help },
        '?', el('span', { class: 'info-pop' }, help)),
    ),
  );
}

function renderMonitoring() {
  const root = el('div', { class: 'stack stack--lg' });
  let range = state._monRange || '24h';
  // Custom range dates (YYYY-MM-DD, UTC). Persisted so a reload keeps them.
  let customFrom = state._monFrom || '';
  let customTo = state._monTo || '';
  // Build the range query string shared by every metrics call. For custom we
  // pass from/to; the backend treats `to` as an INCLUSIVE calendar day.
  const rangeParam = () => range === 'custom'
    ? `range=custom&from=${encodeURIComponent(customFrom)}&to=${encodeURIComponent(customTo)}`
    : `range=${range}`;
  // Guard: custom is only valid with both dates and from <= to.
  const customValid = () => !!customFrom && !!customTo && customFrom <= customTo;

  const kpiHost = el('div', { class: 'grid-4' });
  const chartsHost = el('div', { class: 'grid-3' });
  const providersHost = el('div', {});
  const cacheHost = el('div', {});
  const poolsHost = el('div', { class: 'stack stack--lg' });
  const topHost = el('div', {});
  const burnHost = el('div', { class: 'grid-2' });

  // ── Firebase-style range picker ────────────────────────────────────────
  // A trigger button (preset name + concrete dates) opens a popover with a
  // preset list on the left and a multi-month range calendar on the right.
  // Rolling presets (24h/2d/7d/30d) hit the backend range params directly;
  // every calendar/date preset resolves to a UTC from/to and uses range=custom
  // (backend treats `to` as an INCLUSIVE day — off-by-one safe).
  const D = () => new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const addDays = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };
  const startOfMonth = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const endOfMonth = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const fmtDisp = (s) => { if (!s) return '—'; const [y,m,dd] = s.split('-'); return `${+dd} ${MONTHS[+m-1]} ${y}`; };

  // Preset definitions. `roll` = backend rolling range (no dates). Others return
  // {from,to} as YYYY-MM-DD in UTC and are sent as range=custom.
  const PRESETS = [
    { id: '24h', label: 'Last 24 hours', roll: '24h' },
    { id: '2d',  label: 'Last 2 days',   roll: '2d' },
    { id: '7d',  label: 'Last 7 days',   roll: '7d' },
    { id: '30d', label: 'Last 30 days',  roll: '30d' },
    { id: 'today',     label: 'Today',        dates: () => ({ from: iso(D()), to: iso(D()) }) },
    { id: 'yesterday', label: 'Yesterday',    dates: () => { const y = addDays(D(), -1); return { from: iso(y), to: iso(y) }; } },
    { id: 'last7cal',  label: 'Last 7 days (calendar)', dates: () => ({ from: iso(addDays(D(), -6)), to: iso(D()) }) },
    { id: 'last28',    label: 'Last 28 days', dates: () => ({ from: iso(addDays(D(), -27)), to: iso(D()) }) },
    { id: 'thismonth', label: 'This month',   dates: () => ({ from: iso(startOfMonth(D())), to: iso(D()) }) },
    { id: 'lastmonth', label: 'Last month',   dates: () => { const p = new Date(Date.UTC(D().getUTCFullYear(), D().getUTCMonth() - 1, 1)); return { from: iso(startOfMonth(p)), to: iso(endOfMonth(p)) }; } },
    { id: 'last90',    label: 'Last 90 days', dates: () => ({ from: iso(addDays(D(), -89)), to: iso(D()) }) },
    { id: 'thisyear',  label: 'This year',    dates: () => ({ from: `${D().getUTCFullYear()}-01-01`, to: iso(D()) }) },
    { id: 'lastyear',  label: 'Last calendar year', dates: () => { const y = D().getUTCFullYear() - 1; return { from: `${y}-01-01`, to: `${y}-12-31` }; } },
  ];
  // Which preset id is currently active (for highlight + summary label).
  let activePreset = state._monPreset || '24h';

  const summaryLabel = el('span', { class: 'mrp-summary' });
  const chevron = icon('chevronD', 14);
  const trigger = el('button', { class: 'mrp-trigger', on: { click: (e) => { e.stopPropagation(); togglePopover(); } } },
    icon('history', 14), summaryLabel, chevron);

  function presetById(id) { return PRESETS.find((p) => p.id === id); }
  function updateSummary() {
    const p = presetById(activePreset);
    let dateStr = '';
    if (range === 'custom' && customFrom && customTo) {
      dateStr = customFrom === customTo ? fmtDisp(customFrom) : `${fmtDisp(customFrom)} – ${fmtDisp(customTo)}`;
    }
    summaryLabel.replaceChildren(
      el('span', { class: 'mrp-summary__name' }, p ? p.label : 'Custom'),
      dateStr ? el('span', { class: 'mrp-summary__dates' }, dateStr) : null,
    );
  }

  // Apply a preset: set range/dates, refresh UI + data.
  function applyPreset(p) {
    activePreset = p.id; state._monPreset = p.id;
    if (p.roll) { range = p.roll; state._monRange = p.roll; draftFrom = ''; draftTo = ''; }
    else {
      const { from, to } = p.dates();
      range = 'custom'; state._monRange = 'custom';
      customFrom = from; customTo = to; state._monFrom = from; state._monTo = to;
      draftFrom = from; draftTo = to;
      // Jump the calendar to show the selected end month.
      calAnchor = startOfMonth(new Date(to + 'T00:00:00Z'));
    }
    updateSummary();
    closePopover();
    void load();
  }

  // Popover (built lazily on first open, then reused).
  let popover = null; let popoverOpen = false;
  // Calendar view anchor month (right of the two shown months).
  let calAnchor = startOfMonth(customTo ? new Date(customTo + 'T00:00:00Z') : D());
  // DRAFT selection: the calendar edits these; nothing commits to the actual
  // range (customFrom/customTo + reload) until Apply is pressed. Presets still
  // apply immediately (that's expected picker UX).
  let draftFrom = customFrom; let draftTo = customTo;

  function togglePopover() { popoverOpen ? closePopover() : openPopover(); }
  function openPopover() {
    if (!popover) {
      popover = el('div', { class: 'mrp-pop' });
      // Swallow clicks inside the popover so the document-level outside handler
      // (which fires AFTER a re-render may have detached the target) can't
      // mistake an interior click for an outside click and close us.
      popover.addEventListener('mousedown', (e) => e.stopPropagation());
      popover.addEventListener('click', (e) => e.stopPropagation());
      trigger.parentElement.appendChild(popover);
    }
    // Seed draft from the committed range each open.
    draftFrom = customFrom; draftTo = customTo;
    popoverOpen = true; popover.classList.add('open'); renderPopover();
    setTimeout(() => document.addEventListener('mousedown', outsideClose), 0);
  }
  function closePopover() { popoverOpen = false; if (popover) popover.classList.remove('open'); document.removeEventListener('mousedown', outsideClose); }
  function outsideClose(e) { if (popover && !popover.contains(e.target) && !trigger.contains(e.target)) closePopover(); }

  // Calendar day click edits the DRAFT only (no reload, no close).
  function onDayClick(dstr) {
    if (!draftFrom || (draftFrom && draftTo)) {
      // Fresh selection: this becomes the new start, end cleared.
      draftFrom = dstr; draftTo = '';
    } else {
      // Second click completes the range (swap if earlier).
      if (dstr < draftFrom) { draftTo = draftFrom; draftFrom = dstr; }
      else draftTo = dstr;
    }
    activePreset = 'custom';
    renderPopover();
  }

  // Commit the draft range and reload. Only enabled when both dates are set.
  function applyDraft() {
    if (!draftFrom || !draftTo) return;
    customFrom = draftFrom; customTo = draftTo;
    activePreset = 'custom'; state._monPreset = 'custom';
    range = 'custom'; state._monRange = 'custom';
    state._monFrom = customFrom; state._monTo = customTo;
    updateSummary();
    closePopover();
    void load();
  }

  function monthGrid(monthDate) {
    const y = monthDate.getUTCFullYear(), m = monthDate.getUTCMonth();
    const first = new Date(Date.UTC(y, m, 1));
    const daysIn = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    // Monday-first offset (getUTCDay: 0=Sun..6=Sat -> 0=Mon..6=Sun).
    const lead = (first.getUTCDay() + 6) % 7;
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push(el('span', { class: 'mrp-cell mrp-cell--empty' }));
    const todayS = iso(D());
    for (let day = 1; day <= daysIn; day++) {
      const dstr = `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const isStart = dstr === draftFrom;
      const isEnd = dstr === draftTo;
      const inRange = draftFrom && draftTo && dstr > draftFrom && dstr < draftTo;
      const future = dstr > todayS;
      const cls = ['mrp-cell'];
      if (isStart) cls.push('mrp-cell--start');
      if (isEnd) cls.push('mrp-cell--end');
      if (isStart && (!draftTo || isEnd)) cls.push('mrp-cell--single');
      if (inRange) cls.push('mrp-cell--inrange');
      if (dstr === todayS && !isStart && !isEnd) cls.push('mrp-cell--today');
      if (future) cls.push('mrp-cell--disabled');
      cells.push(el('span', { class: cls.join(' '), on: future ? {} : { click: () => onDayClick(dstr) } }, String(day)));
    }
    return el('div', { class: 'mrp-month' },
      el('div', { class: 'mrp-month__label' }, `${MONTHS[m]} ${y}`),
      el('div', { class: 'mrp-weekdays' }, ...['M','T','W','T','F','S','S'].map((d) => el('span', {}, d))),
      el('div', { class: 'mrp-grid' }, ...cells),
    );
  }

  function renderPopover() {
    if (!popover) return;
    // Left: preset list.
    const list = el('div', { class: 'mrp-presets' },
      ...PRESETS.map((p) => el('button', {
        class: 'mrp-preset' + (p.id === activePreset ? ' active' : ''),
        on: { click: () => applyPreset(p) },
      }, p.label)),
      el('button', { class: 'mrp-preset' + (activePreset === 'custom' ? ' active' : ''),
        on: { click: () => { activePreset = 'custom'; state._monPreset = 'custom'; renderPopover(); } } }, 'Custom'),
    );
    // Right: date fields + two-month calendar + footer.
    const prevMonth = new Date(Date.UTC(calAnchor.getUTCFullYear(), calAnchor.getUTCMonth() - 1, 1));
    const nav = el('div', { class: 'mrp-cal__nav' },
      el('button', { class: 'mrp-navbtn', type: 'button', on: { click: () => { calAnchor = new Date(Date.UTC(calAnchor.getUTCFullYear(), calAnchor.getUTCMonth() - 1, 1)); renderPopover(); } } }, icon('chevronL', 14)),
      el('span', { class: 'mrp-cal__fields' },
        el('span', { class: 'mrp-field' + (draftFrom && !draftTo ? ' active' : '') }, el('label', {}, 'Start'), el('span', {}, fmtDisp(draftFrom))),
        el('span', { class: 'text-subtle' }, '–'),
        el('span', { class: 'mrp-field' + (draftFrom && draftTo ? ' active' : '') }, el('label', {}, 'End'), el('span', {}, fmtDisp(draftTo))),
      ),
      el('button', { class: 'mrp-navbtn', type: 'button', on: { click: () => { const n = new Date(Date.UTC(calAnchor.getUTCFullYear(), calAnchor.getUTCMonth() + 1, 1)); if (startOfMonth(n) <= startOfMonth(D())) { calAnchor = n; renderPopover(); } } } }, icon('chevronR', 14)),
    );
    const canApply = !!(draftFrom && draftTo);
    const footer = el('div', { class: 'mrp-foot' },
      el('span', { class: 'mrp-foot__hint text-subtle fs-12' },
        canApply ? `${fmtDisp(draftFrom)} – ${fmtDisp(draftTo)}` : (draftFrom ? 'Pick an end date' : 'Pick a start date')),
      el('span', { class: 'mrp-foot__actions' },
        el('button', { class: 'btn btn--ghost btn--sm', type: 'button', on: { click: () => closePopover() } }, 'Cancel'),
        el('button', { class: 'btn btn--sm' + (canApply ? '' : ' btn--disabled'), type: 'button', on: { click: () => { if (canApply) applyDraft(); } } }, 'Apply'),
      ),
    );
    const cal = el('div', { class: 'mrp-cal' }, nav, el('div', { class: 'mrp-months' }, monthGrid(prevMonth), monthGrid(calAnchor)), footer);
    popover.replaceChildren(list, cal);
  }

  const rangeBar = el('div', { class: 'mon-toolbar' },
    el('div', { class: 'mon-toolbar__title' },
      el('h2', {}, 'Monitoring'),
      el('span', { class: 'text-subtle fs-12' }, 'Gateway traffic, cost & health'),
    ),
    el('div', { class: 'mrp' }, trigger),
  );
  updateSummary();

  function card(title, body, sub) {
    const isTable = body && body.querySelector && (body.classList?.contains('table-wrap') || body.querySelector('.table-wrap'));
    return el('div', { class: 'card' },
      el('div', { class: 'card__head' }, el('h3', {}, title), sub ? el('span', { class: 'text-subtle fs-12 card__head-sub' }, sub) : null),
      el('div', { class: isTable ? 'card__body card__body--flush' : 'card__body' }, body),
    );
  }
  function sectionTitle(text) {
    return el('div', { class: 'mon-section' }, el('span', {}, text));
  }

  function barChart(series, { fmtVal = (v) => fmt.num(v), height = 130 } = {}) {
    // series: [{bucket, value}] — value may be number|null|costSplit.
    // Built via el() (not innerHTML) so no data string is ever parsed as HTML.
    const vals = series.map((s) => typeof s.value === 'object' && s.value ? (s.value.metered + s.value.notional + s.value.selfHosted + (s.value.freeTier || 0)) : (s.value ?? 0));
    if (!series.length) return el('div', { class: 'mon-chart mon-chart--empty' }, el('span', { class: 'text-subtle fs-12' }, 'No data in range'));
    const max = Math.max(...vals, 1e-9);
    const plotH = height;

    // Left Y-axis: three ticks (max / mid / 0) aligned to gridlines.
    const axis = el('div', { class: 'mon-yaxis' },
      el('span', {}, fmtVal(max)),
      el('span', {}, fmtVal(max / 2)),
      el('span', {}, fmtVal(0)),
    );
    // Horizontal gridlines behind the bars (at 100% / 50% / 0%).
    const grid = el('div', { class: 'mon-grid' }, el('span', {}), el('span', {}), el('span', {}));

    // X-axis label formatting from bucket key.
    // Hourly buckets look like 'YYYY-MM-DDTHH' -> 'HH:00'; daily 'YYYY-MM-DD' -> 'MMM D'.
    const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const fmtBucket = (b) => {
      const s = String(b || '');
      const hourly = s.includes('T');
      if (hourly) { const hh = s.slice(11, 13); return (hh || '00') + ':00'; }
      const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (m) return `${MON[+m[2] - 1]} ${+m[3]}`;
      return s;
    };
    // Thin X labels so they don't overlap (aim for <= ~8 visible).
    const xStride = Math.max(1, Math.ceil(series.length / 8));

    const bars = series.map((s, i) => {
      const v = vals[i];
      const h = Math.max(2, Math.round((v / max) * plotH));
      const label = typeof s.value === 'object' && s.value ? fmtCostSplit(s.value) : fmtVal(v);
      const isLast = i === series.length - 1;
      const bar = el('div', { class: 'mon-bar' + (isLast ? ' mon-bar--last' : '') });
      bar.style.height = h + 'px';
      // Hover-only value tooltip (bucket + value), shown via CSS on slot:hover.
      const tip = el('span', { class: 'mon-bar-tip' }, `${fmtBucket(s.bucket)} · ${label}`);
      return el('div', { class: 'mon-bar-slot', title: `${s.bucket}` }, tip, bar);
    });
    const wrap = el('div', { class: 'mon-bars' }, ...bars);
    wrap.style.height = plotH + 'px';
    // Bottom X-axis: one label slot per bar, but only every Nth is shown.
    const xaxis = el('div', { class: 'mon-xaxis' },
      ...series.map((s, i) => {
        const show = i === 0 || i === series.length - 1 || i % xStride === 0;
        return el('span', { class: 'mon-xtick' }, show ? fmtBucket(s.bucket) : '');
      }),
    );
    const plot = el('div', { class: 'mon-plot' }, grid, wrap);
    plot.style.height = plotH + 'px';
    return el('div', { class: 'mon-chart' },
      el('div', { class: 'mon-chart-grid' }, axis, plot),
      el('div', { class: 'mon-chart-grid' }, el('span', {}), xaxis),
    );
  }

  async function load() {
    // Don't fire an incomplete custom range (avoids a spurious 400 while the
    // user is still picking the second date).
    if (range === 'custom' && !customValid()) {
      root.replaceChildren(rangeBar, el('div', { class: 'card' },
        el('div', { class: 'card__body' }, el('p', { class: 'text-subtle' }, 'Pick a start and end date (start ≤ end) to load a custom range.'))));
      return;
    }
    const rp = rangeParam();
    try {
      const [overview, costSeries, hitSeries, latSeries, cache, reliability, utilization, top, burn, budget] = await Promise.all([
        api(`/admin/metrics/overview?${rp}`),
        api(`/admin/metrics/timeseries?metric=cost_usd&${rp}`),
        api(`/admin/metrics/timeseries?metric=cache_hit_rate&${rp}`),
        api(`/admin/metrics/timeseries?metric=latency_p95&${rp}`),
        api(`/admin/metrics/cache?${rp}`),
        api(`/admin/metrics/reliability?${rp}`),
        api(`/admin/metrics/utilization?${rp}`),
        api(`/admin/metrics/top?dimension=${state._monTopDim || 'user'}&by=${state._monTopBy || 'cost'}&${rp}`),
        api('/admin/metrics/burn'),
        api('/admin/metrics/budget'),
      ]);
      paint(overview, { costSeries, hitSeries, latSeries }, cache, reliability, utilization, top, burn, budget);
    } catch (e) {
      if (e.status === 403) {
        // Plain dev users can hash-navigate here; show a clean no-access state
        // instead of a wall of 403 errors.
        root.replaceChildren(el('div', { class: 'card' },
          el('div', { class: 'card__head' }, el('h3', {}, 'No monitoring access')),
          el('p', { class: 'text-subtle' }, 'Your account is not on the monitoring allowlist. Ask an admin to add your email to MONITOR_ACCESS_EMAILS.'),
        ));
        return;
      }
      root.replaceChildren(rangeBar, el('div', { class: 'alert alert--danger' }, `Failed to load metrics: ${e.message}`));
    }
  }

  function paint(overview, series, cache, reliability, utilization, top, burn, budget) {
    const t = overview.totals;
    kpiHost.replaceChildren(
      kpi({ label: 'Requests', value: fmt.num(t.requests), iconName: 'activity', sub: `${fmtPct(t.errorRate)} errors · ${fmt.num(t.retries)} retries`, tone: t.errorRate >= 0.1 ? 'bad' : t.errorRate >= 0.03 ? 'mid' : 'good' }),
      kpi({ label: 'Tokens', value: fmt.num(t.inputTokens + t.outputTokens), iconName: 'hash', sub: `${fmt.num(t.reasoningTokens)} reasoning · ${fmt.num(t.cacheReadTokens)} cache reads` }),
      kpi({ label: 'Metered spend', value: fmt.usd(t.cost.metered), iconName: 'dollar', sub: `${fmt.usd(t.cost.notional)} notional absorbed by subs` }),
      kpi({ label: '% tokens cached', value: fmtPct(t.cacheHitRate), iconName: 'zap', sub: `${fmt.usd(t.cacheSavedUsd)} saved · token-weighted`, tone: t.cacheHitRate >= 0.7 ? 'good' : t.cacheHitRate <= 0.3 ? 'bad' : 'mid' }),
      kpi({ label: 'Req hit rate', value: fmtPct(t.cacheHitRatePerRequest), iconName: 'zap', sub: `${fmt.num(t.cacheHitRequests)}/${fmt.num(t.cacheableRequests)} cacheable reqs hit` }),
      kpi({ label: 'Avg latency', value: t.avgLatencyMs != null ? fmt.num(t.avgLatencyMs) + ' ms' : '—', iconName: 'clock', sub: rangeLabelMon(range) }),
      kpi({ label: 'Compression', value: fmt.num(t.compressionSavedTokens), iconName: 'bar', sub: 'tokens saved' }),
    );

    chartsHost.replaceChildren(
      card('Cost over time', barChart(series.costSeries.series, { fmtVal: fmt.usd }), 'metered + notional'),
      card('Cache hit rate', barChart(series.hitSeries.series, { fmtVal: fmtPct })),
      card('Latency p95', barChart(series.latSeries.series, { fmtVal: (v) => fmt.num(v) + ' ms' }), 'milliseconds'),
    );
    providersHost.replaceChildren(card('Providers', providerTable(overview.providers), `${overview.providers.length} active`));

    cacheHost.replaceChildren(card('Cache efficiency by model', cacheTable(cache.rows)));
    poolsHost.replaceChildren(card('Pool health', poolTable(reliability), `${reliability.inFlightTotal} in flight`), card('Account utilization', utilTable(utilization.accounts)));
    topHost.replaceChildren(card('Top consumers', topTable(top)));
    burnHost.replaceChildren(
      card(`Metered burn · ${burn.month}`, burnBody(burn), 'Month to date — not affected by range filter'),
      card('Daily budget alert', budgetBody(budget), 'Per-day cap — not affected by range filter'),
    );

    root.replaceChildren(
      rangeBar,
      sectionTitle('Overview'),
      kpiHost,
      sectionTitle('Trends'),
      chartsHost,
      providersHost,
      sectionTitle('Cache'),
      cacheHost,
      sectionTitle('Reliability'),
      poolsHost,
      sectionTitle('Consumers'),
      topHost,
      sectionTitle('Budget'),
      burnHost,
    );
  }

  function rangeLabelMon(r) {
    if (r === 'custom') return customValid() ? `${customFrom} → ${customTo}` : 'Custom range';
    return ({ '24h': 'Last 24h', '2d': 'Last 2 days', '7d': 'Last 7 days', '30d': 'Last 30 days' }[r] || r);
  }

  function providerTable(providers) {
    return el('div', { class: 'table-wrap' }, el('table', { class: 'tbl tbl-collapse' },
      el('thead', {}, el('tr', {},
        el('th', {}, 'Provider'), el('th', { class: 'right' }, 'Requests'), el('th', { class: 'right' }, 'Errors'),
        thInfo('% tok cached', 'Token-weighted: cache_read / (cache_read + input). The share of input tokens served from cache — maps directly to cost & latency savings.'),
        thInfo('Req hit', 'Per-request: of requests large enough to be cacheable (≥1024 tokens), the share that got at least one cache read. Shows how often caching engages.'),
        el('th', { class: 'right' }, 'Cost'), el('th', { class: 'right' }, 'Avg ms'),
      )),
      el('tbody', {}, providers.map((p) => el('tr', {},
        provCell(p.provider),
        el('td', { class: 'right' }, fmt.num(p.requests)),
        el('td', { class: 'right' }, el('span', { class: rateClass(p.errorRate, { good: 0.03, bad: 0.1, invert: true }) === 'val--bad' ? 'text-danger' : '' }, `${fmtPct(p.errorRate)}${p.errors429 ? ` (${p.errors429}×429)` : ''}`)),
        el('td', { class: 'right' }, ratePill(p.cacheHitRate)),
        el('td', { class: 'right' }, p.cacheableRequests ? ratePill(p.cacheHitRatePerRequest) : el('span', { class: 'text-subtle' }, '—')),
        el('td', { class: 'right' }, fmtCostSplit(p.cost)),
        el('td', { class: 'right' }, p.avgLatencyMs != null ? fmt.num(p.avgLatencyMs) : '—'),
      ))),
    ));
  }

  function cacheTable(rows) {
    if (!rows.length) return el('p', { class: 'text-subtle' }, 'No cache activity in this range.');
    return el('div', { class: 'table-wrap' }, el('table', { class: 'tbl tbl-collapse' },
      el('thead', {}, el('tr', {},
        el('th', {}, 'Provider'), el('th', {}, 'Model'),
        thInfo('% tok cached', 'Token-weighted: cache_read / (cache_read + input). The share of input tokens served from cache — maps directly to cost & latency savings.'),
        thInfo('Req hit', 'Per-request: of requests large enough to be cacheable (≥1024 tokens), the share that got at least one cache read. Shows how often caching engages.'),
        el('th', { class: 'right' }, 'Trend'), el('th', { class: 'right' }, 'Reads'), el('th', { class: 'right' }, 'Writes'), el('th', { class: 'right' }, '$ saved'),
      )),
      el('tbody', {}, rows.map((r) => {
        const up = r.prevHitRate != null && r.hitRate != null && r.hitRate >= r.prevHitRate;
        return el('tr', {},
          provCell(r.provider), el('td', { class: 'mono fs-12' }, r.model || '—'),
          el('td', { class: 'right' }, ratePill(r.hitRate)),
          el('td', { class: 'right' }, r.cacheableRequests ? ratePill(r.hitRatePerRequest) : el('span', { class: 'text-subtle' }, '—')),
          el('td', { class: 'right' }, r.prevHitRate == null
            ? el('span', { class: 'text-subtle' }, '—')
            : el('span', { class: up ? 'trend trend--up' : 'trend trend--down' }, (up ? '↑ ' : '↓ ') + fmtPct(r.prevHitRate))),
          el('td', { class: 'right' }, fmt.num(r.cacheReadTokens)), el('td', { class: 'right' }, fmt.num(r.cacheWriteTokens)),
          el('td', { class: 'right' }, r.savedUsd > 0 ? el('span', { class: 'text-success' }, fmt.usd(r.savedUsd)) : fmt.usd(r.savedUsd)),
        );
      })),
    ));
  }

  function poolTable(reliability) {
    const rows = reliability.pools;
    if (!rows.length) return el('p', { class: 'text-subtle' }, 'No provider accounts.');
    return el('div', { class: 'table-wrap' }, el('table', { class: 'tbl tbl-collapse' },
      el('thead', {}, el('tr', {},
        el('th', {}, 'Provider'), el('th', { class: 'right' }, 'Active'), el('th', { class: 'right' }, 'Cooldown'),
        el('th', { class: 'right' }, 'Dead'), el('th', { class: 'right' }, 'Disabled'), el('th', { class: 'right' }, '429s'), el('th', { class: 'right' }, 'Retries'),
      )),
      el('tbody', {}, rows.map((p) => {
        const rel = reliability.providers.find((x) => x.provider === p.provider) || {};
        const danger = p.active <= 1 && (rel.requests || 0) > 0;
        return el('tr', { class: danger ? 'row--danger' : '' },
          provCell(p.provider),
          el('td', { class: 'right' }, el('span', { class: 'metric-pill ' + (danger ? 'val--bad' : 'val--good') }, String(p.active))),
          el('td', { class: 'right' + (p.cooldown ? ' text-warn' : ' text-subtle') }, String(p.cooldown)),
          el('td', { class: 'right' + (p.dead ? ' text-danger' : ' text-subtle') }, String(p.dead)),
          el('td', { class: 'right text-subtle' }, String(p.disabled)), el('td', { class: 'right' }, fmt.num(rel.errors429 || 0)),
          el('td', { class: 'right' }, fmt.num(rel.retries || 0)),
        );
      })),
    ));
  }

  function utilTable(accounts) {
    if (!accounts.length) return el('p', { class: 'text-subtle' }, 'No flat-fee usage in this range.');
    return el('div', { class: 'table-wrap' }, el('table', { class: 'tbl tbl-collapse' },
      el('thead', {}, el('tr', {},
        el('th', {}, 'Provider'), el('th', {}, 'Account'), el('th', { class: 'right' }, 'Requests'),
        el('th', { class: 'right' }, 'Tokens'), el('th', { class: 'right' }, '429 share'), el('th', { class: 'right' }, 'Notional $'),
      )),
      el('tbody', {}, accounts.slice(0, 15).map((a) => el('tr', {},
        provCell(a.provider), el('td', { class: 'mono fs-12' }, a.account),
        el('td', { class: 'right' }, fmt.num(a.requests)), el('td', { class: 'right' }, fmt.num(a.tokens)),
        el('td', { class: 'right' }, a.rateLimitedShare > 0.1
          ? el('span', { class: 'metric-pill val--bad' }, fmtPct(a.rateLimitedShare))
          : el('span', { class: 'text-subtle' }, fmtPct(a.rateLimitedShare))),
        el('td', { class: 'right' }, fmt.usd(a.notionalUsd)),
      ))),
    ));
  }

  function topTable(top) {
    const dimSel = el('select', { class: 'mon-select', on: { change: (e) => { state._monTopDim = e.target.value; void load(); } } },
      ...['user', 'model', 'provider'].map((d) => el('option', { value: d, selected: (state._monTopDim || 'user') === d ? '' : null }, 'By ' + d)));
    const bySel = el('select', { class: 'mon-select', on: { change: (e) => { state._monTopBy = e.target.value; void load(); } } },
      ...['cost', 'tokens', 'requests', 'errors'].map((b) => el('option', { value: b, selected: (state._monTopBy || 'cost') === b ? '' : null }, 'Rank by ' + b)));
    const dim = top.dimension;
    const nameCell = (r) => {
      if (dim === 'provider') return provCell(r.label || r.key);
      if (dim === 'model') {
        const parts = String(r.key).split('/');
        return el('td', {}, el('span', { class: 'prov-cell' }, provMark(parts[0]), el('span', { class: 'mono fs-12' }, parts.slice(1).join('/') || r.key)));
      }
      return el('td', { class: 'mono fs-12' }, r.label || r.key);
    };
    const table = el('div', { class: 'table-wrap' }, el('table', { class: 'tbl tbl-collapse' },
      el('thead', {}, el('tr', {},
        el('th', {}, dim), el('th', { class: 'right' }, 'Requests'), el('th', { class: 'right' }, 'Errors'),
        el('th', { class: 'right' }, 'Tokens'),
        thInfo('% tok cached', 'Token-weighted: cache_read / (cache_read + input). The share of input tokens served from cache — maps directly to cost & latency savings.'),
        thInfo('Req hit', 'Per-request: of requests large enough to be cacheable (≥1024 tokens), the share that got at least one cache read. Shows how often caching engages.'),
        el('th', { class: 'right' }, 'Cost'),
      )),
      el('tbody', {}, top.rows.map((r) => el('tr', {},
        nameCell(r),
        el('td', { class: 'right' }, fmt.num(r.requests)), el('td', { class: 'right' }, fmt.num(r.errors)),
        el('td', { class: 'right' }, fmt.num(r.tokens)),
        el('td', { class: 'right' }, r.cacheHitRate != null ? ratePill(r.cacheHitRate) : el('span', { class: 'text-subtle' }, '—')),
        el('td', { class: 'right' }, r.cacheableRequests ? ratePill(r.cacheHitRatePerRequest) : el('span', { class: 'text-subtle' }, '—')),
        el('td', { class: 'right' }, fmtCostSplit(r.cost)),
      ))),
    ));
    return el('div', {}, el('div', { class: 'mon-tablebar' }, dimSel, bySel), table);
  }

  function burnBody(burn) {
    return el('div', {},
      el('div', { class: 'flex gap-4 mb-2' },
        el('div', {}, el('div', { class: 'text-subtle fs-12' }, 'Month to date'), el('div', { class: 'fs-20' }, fmt.usd(burn.meteredUsd))),
        el('div', {}, el('div', { class: 'text-subtle fs-12' }, 'Projected'), el('div', { class: 'fs-20' }, burn.projectedUsd != null ? fmt.usd(burn.projectedUsd) : '—')),
        el('div', {}, el('div', { class: 'text-subtle fs-12' }, 'Month elapsed'), el('div', { class: 'fs-20' }, fmtPct(burn.fractionElapsed))),
      ),
      burn.providers.length
        ? el('div', { class: 'table-wrap' }, el('table', { class: 'tbl' },
            el('tbody', {}, burn.providers.map((p) => el('tr', {}, el('td', {}, p.provider), el('td', { class: 'right' }, fmt.usd(p.usd)))))))
        : el('p', { class: 'text-subtle' }, 'No metered spend this month.'),
    );
  }

  function budgetBody(budget) {
    const active = budget.active;
    const rows = [
      el('div', { class: 'flex gap-4 mb-2' },
        el('div', {}, el('div', { class: 'text-subtle fs-12' }, 'Active budget'), el('div', { class: 'fs-20' }, active ? fmt.usd(active) + '/day' : 'Not set')),
        budget.suggestedUsd ? el('div', {}, el('div', { class: 'text-subtle fs-12' }, 'Suggested (p95 × 1.5)'), el('div', { class: 'fs-20' }, fmt.usd(budget.suggestedUsd) + '/day')) : null,
      ),
    ];
    if (!active) {
      rows.push(el('p', { class: 'text-subtle fs-12' },
        budget.suggestedUsd
          ? 'Budget alerts are disabled. Confirm the suggestion to enable 80%/100% daily alerts.'
          : 'Budget alerts are disabled. A suggestion appears after 7 days of metered baselines.'));
    }
    if (isAdminUser() && budget.suggestedUsd && !budget.confirmedUsd) {
      rows.push(el('button', {
        class: 'btn',
        on: { click: async () => {
          try {
            await api('/admin/metrics/budget', { method: 'PUT', body: JSON.stringify({ dailyBudgetUsd: budget.suggestedUsd }) });
            toast(`Daily budget set to ${fmt.usd(budget.suggestedUsd)}`);
            void load();
          } catch (e) { toast(e.message, 'error'); }
        } },
      }, `Confirm ${fmt.usd(budget.suggestedUsd)}/day`));
    }
    return el('div', {}, ...rows);
  }

  root.append(rangeBar, el('div', { class: 'view-loading' }, el('div', { class: 'spinner' }), el('span', {}, 'Loading metrics…')));
  void load();
  return root;
}

/* ──────────────── Init ──────────────── */
document.addEventListener('DOMContentLoaded', () => {
  wireGlobals();
  bootPromise = boot();
  setInterval(() => {
    if (state.loaded && isAdminUser() && state.view === 'health' && !state.loading) refresh();
  }, 10000);
});

})();
