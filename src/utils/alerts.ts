import { config } from '../config.js';
import { getDb } from '../db/index.js';

export async function alert(level: 'info'|'warn'|'error', type: string, message: string, metadata: Record<string, unknown> = {}) {
  getDb().prepare('INSERT INTO alerts (level,type,message,metadata_json) VALUES (?,?,?,?)').run(level, type, message, JSON.stringify(metadata));
  if (!config.discordWebhookUrl) return;
  try {
    await fetch(config.discordWebhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: `**${level.toUpperCase()} ${type}**\n${message}\n\`\`\`json\n${JSON.stringify(metadata, null, 2).slice(0, 1500)}\n\`\`\`` }), signal: AbortSignal.timeout(5000) });
  } catch { /* best-effort */ }
}
