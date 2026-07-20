// Monitoring alert delivery (Phase 4 of docs/MONITORING-SYSTEM.md §6.2).
//
// Severity tiers:
//   warn     → embed-only post to the monitor webhook (silent, no ping)
//   critical → embed + <@id> content line with allowed_mentions (pings the
//              operator roster from MONITOR_PING_DISCORD_IDS), rate-limited
//              per rule+scope by DB-backed cooldowns (restart-safe).
//
// Fallback: if DISCORD_MONITOR_WEBHOOK is unset, deliver via the legacy
// alert() channel (DISCORD_WEBHOOK_URL) as warn-only text so nothing is lost.
// Every fire also writes an `alerts` table row (existing contract).
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { alert } from '../utils/alerts.js';

export type MonitorSeverity = 'warn' | 'critical';

export interface MonitorAlert {
  rule: string;
  scope: string; // e.g. provider name; '' for global
  severity: MonitorSeverity;
  title: string;
  message: string;
  metadata?: Record<string, unknown>;
  cooldownMs: number;
}

/** Returns true when (rule, scope) is still cooling down. */
export function isCoolingDown(rule: string, scope: string, cooldownMs: number, now = Date.now()): boolean {
  const row = getDb().prepare('SELECT last_fired_at FROM alert_cooldowns WHERE rule = ? AND scope = ?').get(rule, scope) as any;
  if (!row) return false;
  const last = Date.parse(row.last_fired_at);
  return Number.isFinite(last) && now - last < cooldownMs;
}

export function markFired(rule: string, scope: string, now = Date.now()): void {
  getDb().prepare(`
    INSERT INTO alert_cooldowns (rule, scope, last_fired_at) VALUES (?, ?, ?)
    ON CONFLICT(rule, scope) DO UPDATE SET last_fired_at = excluded.last_fired_at
  `).run(rule, scope, new Date(now).toISOString());
}

const SEVERITY_COLOR: Record<MonitorSeverity, number> = { warn: 0xf59e0b, critical: 0xef4444 };

/**
 * Deliver one alert (cooldown must already be checked by the caller — the
 * rules engine owns fire/no-fire; this owns transport). Never throws.
 */
export async function sendMonitorAlert(a: MonitorAlert): Promise<void> {
  if (!config.monitorWebhookUrl) {
    // Legacy channel fallback, warn-level text (no pings — mixed channel).
    // alert() writes the alerts-table row itself — do NOT also write ours
    // (would duplicate the console feed entry).
    await alert(a.severity === 'critical' ? 'error' : 'warn', `monitor_${a.rule}`, `${a.title}: ${a.message}`, a.metadata || {});
    return;
  }

  // Persist to the alerts table for the console feed.
  try {
    getDb().prepare('INSERT INTO alerts (level,type,message,metadata_json) VALUES (?,?,?,?)')
      .run(a.severity === 'critical' ? 'error' : 'warn', `monitor_${a.rule}`, a.message, JSON.stringify(a.metadata || {}));
  } catch { /* table write is best-effort; delivery continues */ }

  const pings = a.severity === 'critical' ? config.monitorPingDiscordIds : [];
  const body: Record<string, unknown> = {
    embeds: [{
      title: `${a.severity === 'critical' ? '🚨' : '⚠️'} ${a.title}`,
      description: a.message.slice(0, 3500),
      color: SEVERITY_COLOR[a.severity],
      fields: Object.entries(a.metadata || {}).slice(0, 10).map(([name, value]) => ({
        name: name.slice(0, 100),
        value: String(value).slice(0, 500),
        inline: true,
      })),
      timestamp: new Date().toISOString(),
    }],
  };
  if (pings.length) {
    body.content = pings.map((id) => `<@${id}>`).join(' ');
    body.allowed_mentions = { users: pings };
  }
  try {
    await fetch(config.monitorWebhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
  } catch { /* best-effort */ }
}

/**
 * fire() = cooldown check + delivery + cooldown mark, in one call.
 * Returns true when the alert was actually sent.
 */
export async function fireMonitorAlert(a: MonitorAlert, now = Date.now()): Promise<boolean> {
  if (isCoolingDown(a.rule, a.scope, a.cooldownMs, now)) return false;
  markFired(a.rule, a.scope, now);
  await sendMonitorAlert(a);
  return true;
}
