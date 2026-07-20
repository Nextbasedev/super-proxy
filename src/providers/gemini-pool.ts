import { getDb } from '../db/index.js';
import type { ProviderAccount } from './governor.js';
import { MODEL_CATALOG } from './model-catalog.js';

export const DEFAULT_GEMINI_EMBEDDING_MODEL = 'gemini-embedding-001';
export const DEFAULT_GEMINI_TTS_MODEL = 'gemini-2.5-flash-preview-tts';
export const DEFAULT_GEMINI_CHAT_MODEL = 'gemini-3.1-flash-lite';
export const DEFAULT_GEMINI_MAX_IN_FLIGHT = 2;

const GEMINI_CATALOG = MODEL_CATALOG.filter((entry) => entry.provider === 'gemini');
export const KNOWN_GEMINI_EMBEDDING_MODELS = new Set(GEMINI_CATALOG.filter((entry) => entry.capabilities.includes('embeddings')).map((entry) => entry.id));
export const KNOWN_GEMINI_TTS_MODELS = new Set(GEMINI_CATALOG.filter((entry) => entry.capabilities.includes('text-to-speech')).map((entry) => entry.id));
export const KNOWN_GEMINI_CHAT_MODELS = new Set(GEMINI_CATALOG.filter((entry) => entry.capabilities.includes('chat') && !entry.input_modalities.includes('video')).map((entry) => entry.id));
// Video-understanding-capable chat models. Multimodal (video/image/audio input).
// Free-tier daily request cap is much lower (~20 RPD/key) than the flash-lite chat
// models, so these live in their own pool family ('chat-video') to keep their tight
// daily budget from starving the high-volume flash-lite chat traffic.
export const KNOWN_GEMINI_VIDEO_MODELS = new Set(GEMINI_CATALOG.filter((entry) => entry.capabilities.includes('chat') && entry.input_modalities.includes('video')).map((entry) => entry.id));
// Gemini Live (realtime) bidirectional models. These run over a WebSocket
// (BidiGenerateContent), are audio-first (require AUDIO response modality), and
// are served by the Live relay, not the request/response chat path. Verified live
// against prod keys 2026-06-24 (all three reach setupComplete + return audio).
export const KNOWN_GEMINI_LIVE_MODELS = new Set(GEMINI_CATALOG.filter((entry) => entry.capabilities.includes('realtime')).map((entry) => entry.id));
export const KNOWN_GEMINI_MODELS = new Set([
  ...KNOWN_GEMINI_EMBEDDING_MODELS,
  ...KNOWN_GEMINI_TTS_MODELS,
  ...KNOWN_GEMINI_CHAT_MODELS,
  ...KNOWN_GEMINI_VIDEO_MODELS,
  ...KNOWN_GEMINI_LIVE_MODELS,
]);

export type GeminiModelFamily = 'embeddings' | 'tts' | 'chat' | 'chat-video' | 'live';
export const GEMINI_DAILY_CAPS: Record<GeminiModelFamily, number> = {
  embeddings: 1000,
  tts: 10,
  chat: 500,
  'chat-video': 20,
  // Live free-tier sessions are tightly capped per key; keep conservative so the
  // realtime relay can't burn a key's daily Live budget and starve other Live
  // sessions. Adjust once Google publishes the exact free-tier Live RPD.
  live: 10,
};

const GEMINI_PROACTIVE_SKIP_RATIO = 0.95;
const geminiInFlight = new Map<number, number>();

export function getGeminiInFlight(accountId: number): number {
  return geminiInFlight.get(accountId) || 0;
}

export function getGeminiInFlightSnapshot(): Record<number, number> {
  const out: Record<number, number> = {};
  for (const [id, n] of geminiInFlight.entries()) out[id] = n;
  return out;
}

export function acquireGeminiSlot(account: ProviderAccount): boolean {
  const max = account.max_in_flight || DEFAULT_GEMINI_MAX_IN_FLIGHT;
  const cur = geminiInFlight.get(account.id) || 0;
  if (cur >= max) return false;
  geminiInFlight.set(account.id, cur + 1);
  return true;
}

export function releaseGeminiSlot(account: ProviderAccount): void {
  const cur = geminiInFlight.get(account.id) || 0;
  geminiInFlight.set(account.id, Math.max(0, cur - 1));
}

export function geminiPacificDay(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function secondsUntilNextPacificMidnight(now = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hourCycle: 'h23',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(now);
  const num = (type: string) => Number(parts.find((p) => p.type === type)?.value || 0);
  const elapsed = num('hour') * 3600 + num('minute') * 60 + num('second');
  return Math.max(1, 24 * 3600 - elapsed);
}

export function geminiModelFamily(model: string): GeminiModelFamily | null {
  if (KNOWN_GEMINI_EMBEDDING_MODELS.has(model)) return 'embeddings';
  if (KNOWN_GEMINI_TTS_MODELS.has(model)) return 'tts';
  if (KNOWN_GEMINI_LIVE_MODELS.has(model)) return 'live';
  if (KNOWN_GEMINI_VIDEO_MODELS.has(model)) return 'chat-video';
  if (KNOWN_GEMINI_CHAT_MODELS.has(model)) return 'chat';
  return null;
}

function capForFamily(family: GeminiModelFamily): number {
  return GEMINI_DAILY_CAPS[family];
}

export function getGeminiUsageCount(accountId: number, family: GeminiModelFamily, dayPacific = geminiPacificDay()): number {
  const row = getDb().prepare('SELECT count FROM gemini_key_usage WHERE account_id=? AND model_family=? AND day_pacific=?')
    .get(accountId, family, dayPacific) as { count?: number } | undefined;
  return Number(row?.count || 0);
}

// FREE TIER — these 4 Google Cloud projects must NEVER have billing enabled, or the free tier vanishes and all calls become billable.
export function selectGeminiAccount(family: GeminiModelFamily, excludeIds: number[] = []): ProviderAccount | null {
  const now = Date.now();
  const day = geminiPacificDay();
  const cap = capForFamily(family);
  const proactiveLimit = Math.floor(cap * GEMINI_PROACTIVE_SKIP_RATIO);
  const exclude = new Set(excludeIds);
  const rows = getDb().prepare(`
    SELECT pa.id,pa.provider,pa.label,pa.secret,pa.refresh_secret,pa.account_id,pa.expires_at,pa.max_in_flight,pa.status,pa.cooldown_until,pa.last_used_at,
           COALESCE(gku.count,0) AS today_count
    FROM provider_accounts pa
    LEFT JOIN gemini_key_usage gku ON gku.account_id = pa.id AND gku.model_family = ? AND gku.day_pacific = ?
    WHERE pa.provider = 'gemini' AND pa.enabled = 1
    ORDER BY today_count ASC, pa.last_used_at ASC, pa.id ASC
  `).all(family, day) as (ProviderAccount & { today_count: number; last_used_at?: number })[];
  const eligible = rows.filter((a: any) => {
    if (exclude.has(a.id)) return false;
    if (!a.secret) return false;
    if (['dead','disabled','invalid','refresh_failed'].includes(a.status)) return false;
    if ((a.cooldown_until || 0) > now) return false;
    if (Number(a.today_count || 0) >= proactiveLimit) return false;
    const max = a.max_in_flight || DEFAULT_GEMINI_MAX_IN_FLIGHT;
    if ((geminiInFlight.get(a.id) || 0) >= max) return false;
    return true;
  });
  return eligible[0] || null;
}

// Pin to a specific Gemini account by id, if it's enabled and usable. Used by the
// File API: a file uploaded under key X must be referenced for generateContent
// under the SAME key X (uploaded files are private to the uploading project), so
// the chat route pins to the account that did the upload via the file_uri hint.
export function getGeminiAccountById(id: number): ProviderAccount | null {
  const row = getDb().prepare(`
    SELECT pa.id,pa.provider,pa.label,pa.secret,pa.refresh_secret,pa.account_id,pa.expires_at,pa.max_in_flight,pa.status,pa.cooldown_until,pa.last_used_at
    FROM provider_accounts pa
    WHERE pa.id = ? AND pa.provider = 'gemini' AND pa.enabled = 1
  `).get(id) as ProviderAccount | undefined;
  if (!row || !row.secret) return null;
  if (['dead','disabled','invalid','refresh_failed'].includes(row.status as string)) return null;
  return row;
}

// Pick a healthy Gemini account for a File API UPLOAD. Uploads have no per-day
// request cap (only the 20 GB/project storage limit, well outside our usage), so
// this ignores the family daily-cap counters and just load-balances by least-
// recently-used among enabled, non-cooling, slot-available keys.
export function selectGeminiUploadAccount(excludeIds: number[] = []): ProviderAccount | null {
  const now = Date.now();
  const exclude = new Set(excludeIds);
  const rows = getDb().prepare(`
    SELECT pa.id,pa.provider,pa.label,pa.secret,pa.refresh_secret,pa.account_id,pa.expires_at,pa.max_in_flight,pa.status,pa.cooldown_until,pa.last_used_at
    FROM provider_accounts pa
    WHERE pa.provider = 'gemini' AND pa.enabled = 1
    ORDER BY pa.last_used_at ASC, pa.id ASC
  `).all() as (ProviderAccount & { last_used_at?: number })[];
  const eligible = rows.filter((a: any) => {
    if (exclude.has(a.id)) return false;
    if (!a.secret) return false;
    if (['dead','disabled','invalid','refresh_failed'].includes(a.status)) return false;
    if ((a.cooldown_until || 0) > now) return false;
    const max = a.max_in_flight || DEFAULT_GEMINI_MAX_IN_FLIGHT;
    if ((geminiInFlight.get(a.id) || 0) >= max) return false;
    return true;
  });
  return eligible[0] || null;
}

export function recordGeminiAttempt(accountId: number, family: GeminiModelFamily, dayPacific = geminiPacificDay()): void {
  getDb().prepare(`
    INSERT INTO gemini_key_usage (account_id, model_family, day_pacific, count)
    VALUES (?,?,?,1)
    ON CONFLICT(account_id, model_family, day_pacific) DO UPDATE SET count = count + 1, updated_at = CURRENT_TIMESTAMP
  `).run(accountId, family, dayPacific);
}

export function markGeminiFamilyExhausted(accountId: number, family: GeminiModelFamily, dayPacific = geminiPacificDay()): void {
  const cap = capForFamily(family);
  getDb().prepare(`
    INSERT INTO gemini_key_usage (account_id, model_family, day_pacific, count)
    VALUES (?,?,?,?)
    ON CONFLICT(account_id, model_family, day_pacific) DO UPDATE SET count = ?, updated_at = CURRENT_TIMESTAMP
  `).run(accountId, family, dayPacific, cap, cap);
}

export function markGeminiCooldown(account_id: number, ms: number, reason: string): void {
  const until = Date.now() + Math.max(0, ms);
  getDb().prepare(`
    UPDATE provider_accounts
    SET status='cooldown', cooldown_until=?, consecutive_failures=consecutive_failures+1, notes=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(until, reason, account_id);
  getDb().prepare('INSERT INTO provider_health_events (provider_account_id,status,reason,detail) VALUES (?,?,?,?)')
    .run(account_id, 'rate_limited', reason, String(ms));
}

export function recordGeminiSuccess(account_id: number): void {
  getDb().prepare(`
    UPDATE provider_accounts
    SET last_used_at=?, status=CASE WHEN status='cooldown' THEN 'active' ELSE status END,
        cooldown_until=CASE WHEN status='cooldown' THEN 0 ELSE cooldown_until END,
        consecutive_failures=0,
        updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(Date.now(), account_id);
}
