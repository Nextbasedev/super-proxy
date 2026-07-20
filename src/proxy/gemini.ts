import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { requireProxyToken } from '../auth/token-auth.js';
import { recordUsage } from './usage.js';
import { checkLooseLimit, enforceAfterUsage, isModelAllowedForUser, logRequestResponse, shouldLogBody } from './policy.js';
import { estimateCost } from './cost.js';
import { isAbortTimeoutError, timeoutMessage, timeoutSeconds, transientNetworkMessage } from './openai-compat-errors.js';
import {
  acquireGeminiSlot,
  DEFAULT_GEMINI_CHAT_MODEL,
  DEFAULT_GEMINI_EMBEDDING_MODEL,
  DEFAULT_GEMINI_TTS_MODEL,
  geminiModelFamily,
  GEMINI_DAILY_CAPS,
  KNOWN_GEMINI_CHAT_MODELS,
  KNOWN_GEMINI_EMBEDDING_MODELS,
  KNOWN_GEMINI_MODELS,
  KNOWN_GEMINI_TTS_MODELS,
  KNOWN_GEMINI_VIDEO_MODELS,
  markGeminiCooldown,
  markGeminiFamilyExhausted,
  recordGeminiAttempt,
  recordGeminiSuccess,
  releaseGeminiSlot,
  secondsUntilNextPacificMidnight,
  selectGeminiAccount,
  selectGeminiUploadAccount,
  getGeminiAccountById,
  type GeminiModelFamily,
} from '../providers/gemini-pool.js';

// Models that support Google's thinkingConfig in generateContent.
// Lite and 2.0 variants do not support thinking.
const GEMINI_THINKING_CAPABLE_MODELS = new Set([
  'gemini-3.5-flash',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-3.1-pro-preview',
  'gemini-3-flash-preview',
]);

/**
 * Map an OpenAI-style reasoning_effort (or X-Thinking-Level header) to Google's
 * thinkingConfig.thinkingLevel. Returns undefined if thinking should not be set.
 *
 * Accepted input values (case-insensitive):
 *   none/off        → no thinkingConfig (thinking disabled)
 *   low/minimal     → LOW
 *   medium/adaptive → MEDIUM
 *   high/xhigh      → HIGH
 */
export function resolveGeminiThinkingLevel(
  reasoningEffort: string | undefined,
  headerValue: string | undefined,
): 'LOW' | 'MEDIUM' | 'HIGH' | undefined {
  const raw = (reasoningEffort || headerValue || '').trim().toLowerCase();
  if (!raw) return undefined;
  switch (raw) {
    case 'none': case 'off': return undefined;
    case 'low': case 'minimal': return 'LOW';
    case 'medium': case 'adaptive': return 'MEDIUM';
    case 'high': case 'xhigh': return 'HIGH';
    default: return undefined;
  }
}

const REQUEST_TIMEOUT_MS = 120_000;
const GEMINI_TTS_BODY_LIMIT_BYTES = 2 * 1024 * 1024;
// Chat route accepts inline base64 video/image/audio for multimodal (video understanding).
// Base64 adds ~33% overhead; Gemini's own inline_data limit is ~20 MB of raw media
// (~27 MB base64), so 30 MB covers a max-size inline video plus surrounding JSON.
// Stays under the server-wide 50 MB cap; larger media should use an http(s)/File URL.
const GEMINI_CHAT_BODY_LIMIT_BYTES = 30 * 1024 * 1024;
// File API upload route accepts large media (Gemini allows up to 2 GB/file on the
// free tier). We stream the body straight through, but still cap to keep a single
// request from exhausting memory; 200 MB comfortably covers long videos while
// staying sane for a shared pool. Bigger originals should be chunked/compressed.
const GEMINI_FILE_UPLOAD_LIMIT_BYTES = 200 * 1024 * 1024;
const GEMINI_MAX_TTS_CHARS = 15_000;
// Query param we append to a returned File API file_uri to remember which pool
// account uploaded it. Files are private to the uploading project, so the
// follow-up generateContent MUST run on the same key. Stripped before forwarding.
const GEMINI_ACCT_HINT_PARAM = 'nbmg_acct';

function openAiError(message: string, type = 'server_error', code?: string) {
  return { error: { message, type, code: code || null } };
}

function modelNotAllowedForUserError(message: string) {
  return { type: 'error', error: { type: 'invalid_request_error', code: 'model_not_allowed_for_user', message } };
}

function estimateInputTokens(body: any): number {
  // Estimate from TEXT content only. Multimodal requests carry large inline
  // base64 media (video/image/audio) that must NOT be counted as text tokens —
  // stringifying the whole body would yield millions of bogus tokens for a video.
  // The authoritative token count always comes from upstream usageMetadata; this
  // is only a fallback (error paths / missing upstream usage), so keep it text-only.
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  if (!messages.length) {
    const fallback = typeof body?.input === 'string' ? body.input
      : typeof body?.text === 'string' ? body.text : '';
    return Math.max(1, Math.ceil(fallback.length / 4));
  }
  let chars = 0;
  for (const msg of messages) {
    const c = msg?.content;
    if (typeof c === 'string') { chars += c.length; continue; }
    if (Array.isArray(c)) {
      for (const part of c) {
        if (typeof part === 'string') chars += part.length;
        else if (typeof part?.text === 'string') chars += part.text.length;
        else if (typeof part?.content === 'string') chars += part.content.length;
        // media parts (image_url/video_url/inline_data/input_audio) contribute 0 text chars
      }
    }
  }
  return Math.max(1, Math.ceil(chars / 4));
}

function estimateTextTokens(text: string): number {
  return Math.max(1, Math.ceil((text || '').length / 4));
}

function retryAfterMs(value: string | null): number {
  if (!value) return secondsUntilNextPacificMidnight() * 1000;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : secondsUntilNextPacificMidnight() * 1000;
}

// Default short cooldown for transient per-minute (RPM/TPM) 429s.
export const GEMINI_PER_MINUTE_COOLDOWN_MS = 60_000;

/**
 * Classify a Gemini 429 (RESOURCE_EXHAUSTED) body to decide whether it is a
 * hard daily (RPD) exhaustion or a transient per-minute (RPM/TPM) throttle.
 *
 * Gemini surfaces the violated quota via QuotaFailure.violations[].quotaId /
 * quotaMetric and an optional RetryInfo.retryDelay. Per-day quota ids contain
 * "PerDay"; per-minute ids contain "PerMinute". When the body is ambiguous
 * (truncated / no QuotaFailure), default to PER_MINUTE so a single transient
 * throttle never nukes a healthy key until Pacific midnight.
 */
export function classifyGeminiRateLimit(rawError?: string | null): {
  kind: 'per_day' | 'per_minute';
  retryDelayMs: number | null;
} {
  const raw = rawError || '';
  let retryDelayMs: number | null = null;
  let isPerDay = false;
  let isPerMinute = false;
  try {
    const parsed = JSON.parse(raw);
    const details = parsed?.error?.details;
    if (Array.isArray(details)) {
      for (const det of details) {
        const type = String(det?.['@type'] || '');
        if (type.endsWith('QuotaFailure') && Array.isArray(det.violations)) {
          for (const v of det.violations) {
            const id = String(v?.quotaId || '') + ' ' + String(v?.quotaMetric || '');
            if (/PerDay/i.test(id)) isPerDay = true;
            if (/PerMinute/i.test(id)) isPerMinute = true;
          }
        }
        if (type.endsWith('RetryInfo') && det.retryDelay) {
          const m = String(det.retryDelay).match(/([0-9.]+)s/);
          if (m) retryDelayMs = Math.max(0, Math.round(parseFloat(m[1]) * 1000));
        }
      }
    }
  } catch {
    // Fall back to substring matching on a truncated/non-JSON body.
    if (/PerDay/i.test(raw)) isPerDay = true;
    if (/PerMinute/i.test(raw)) isPerMinute = true;
  }
  // Only treat as daily when PerDay is explicitly present AND PerMinute is not.
  const kind: 'per_day' | 'per_minute' = isPerDay && !isPerMinute ? 'per_day' : 'per_minute';
  return { kind, retryDelayMs };
}

function geminiUrl(model: string, method: 'embedContent' | 'batchEmbedContents' | 'generateContent', key: string): string {
  return `${config.geminiUpstreamUrl}/models/${encodeURIComponent(model)}:${method}?key=${encodeURIComponent(key)}`;
}

// The File API upload endpoint lives at <root>/upload/v1beta/files, where the
// resumable protocol is selected via X-Goog-Upload-* headers. config.geminiUpstreamUrl
// is the <root>/v1beta path; derive the upload base from the same root.
function geminiUploadBaseUrl(): string {
  // e.g. https://generativelanguage.googleapis.com/v1beta -> .../upload/v1beta/files
  return config.geminiUpstreamUrl.replace(/\/v1beta\/?$/, '/upload/v1beta/files');
}
function geminiFilesBaseUrl(): string {
  return `${config.geminiUpstreamUrl}/files`;
}

// Append our account-hint param to a returned file_uri so the chat route can pin
// the follow-up generateContent to the same uploading key.
function taggedFileUri(uri: string, accountId: number): string {
  if (!uri) return uri;
  const sep = uri.includes('?') ? '&' : '?';
  return `${uri}${sep}${GEMINI_ACCT_HINT_PARAM}=${accountId}`;
}

// Given any file_uri possibly carrying our account hint, return the clean upstream
// uri (hint stripped) and the pinned account id (or null). Only googleapis File API
// uris are eligible for pinning; everything else (public http URLs) passes through.
function parseFileUriHint(uri: string): { cleanUri: string; accountId: number | null } {
  if (typeof uri !== 'string' || !uri) return { cleanUri: uri, accountId: null };
  const idx = uri.indexOf(`${GEMINI_ACCT_HINT_PARAM}=`);
  if (idx === -1) return { cleanUri: uri, accountId: null };
  // strip the &nbmg_acct=N (or ?nbmg_acct=N) fragment
  const before = uri.slice(0, idx).replace(/[?&]$/, '');
  const after = uri.slice(idx).replace(new RegExp(`^${GEMINI_ACCT_HINT_PARAM}=\\d+&?`), '');
  let cleanUri = after ? `${before}${before.includes('?') ? '&' : '?'}${after}` : before;
  cleanUri = cleanUri.replace(/[?&]$/, '');
  const m = uri.slice(idx).match(new RegExp(`${GEMINI_ACCT_HINT_PARAM}=(\\d+)`));
  const accountId = m ? Number(m[1]) : null;
  return { cleanUri, accountId };
}

// Scan a translated Gemini contents[] for a pinned account id carried by any
// file_data.file_uri, stripping the hint in place so upstream gets a clean uri.
// Returns the first pinned account id found (all parts in one request must share
// the same key, since a request can only authenticate as one project).
function extractAndStripFileUriPin(contents: any[]): number | null {
  let pinned: number | null = null;
  for (const c of contents || []) {
    for (const p of c?.parts || []) {
      const fd = p?.file_data || p?.fileData;
      const uri = fd?.file_uri || fd?.fileUri;
      if (typeof uri === 'string' && uri.includes(`${GEMINI_ACCT_HINT_PARAM}=`)) {
        const { cleanUri, accountId } = parseFileUriHint(uri);
        if (fd.file_uri) fd.file_uri = cleanUri; else fd.fileUri = cleanUri;
        if (pinned == null) pinned = accountId;
      }
    }
  }
  return pinned;
}

function cleanHeaders(reqHeaders: Record<string, any>, accept = 'application/json'): Headers {
  const headers = new Headers();
  for (const [k, v] of Object.entries(reqHeaders)) {
    if (v == null) continue;
    const lk = k.toLowerCase();
    if (['authorization', 'x-api-key', 'host', 'content-length'].includes(lk)) continue;
    headers.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  headers.set('content-type', 'application/json');
  headers.set('accept', accept);
  return headers;
}

function contentToText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (typeof part?.text === 'string') return part.text;
      if (typeof part?.content === 'string') return part.content;
      return '';
    }).filter(Boolean).join('\n');
  }
  if (content == null) return '';
  return String(content);
}

// Parse a data URI (`data:<mime>;base64,<data>`) into a Gemini inline_data part.
// Returns null if the string is not a base64 data URI.
function dataUriToInlineData(uri: string): { inline_data: { mime_type: string; data: string } } | null {
  if (typeof uri !== 'string') return null;
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(uri.trim());
  if (!m) return null;
  return { inline_data: { mime_type: m[1], data: m[2] } };
}

// Translate a single OpenAI-style content value into an array of Gemini parts.
// Supports: plain string, text parts, image_url/video_url/audio_url (data URI ->
// inline_data, http(s) URL -> file_data), input_audio { data, format }, and
// passthrough of native Gemini parts ({ inline_data } / { file_data }).
function contentToGeminiParts(content: any): any[] {
  if (content == null) return [];
  if (typeof content === 'string') return content ? [{ text: content }] : [];
  if (!Array.isArray(content)) return [{ text: String(content) }];
  const parts: any[] = [];
  for (const part of content) {
    if (part == null) continue;
    if (typeof part === 'string') { if (part) parts.push({ text: part }); continue; }
    // Native Gemini parts: pass through unchanged.
    if (part.inline_data || part.inlineData) { parts.push(part.inline_data ? { inline_data: part.inline_data } : { inline_data: part.inlineData }); continue; }
    if (part.file_data || part.fileData) { parts.push(part.file_data ? { file_data: part.file_data } : { file_data: part.fileData }); continue; }
    const type = part.type;
    if (type === 'text' || typeof part.text === 'string') { if (part.text) parts.push({ text: part.text }); continue; }
    // OpenAI-style media parts.
    const urlObj = part.image_url || part.video_url || part.audio_url;
    const url = typeof urlObj === 'string' ? urlObj : urlObj?.url;
    if (url) {
      const inline = dataUriToInlineData(url);
      if (inline) { parts.push(inline); continue; }
      if (/^https?:\/\//i.test(url)) {
        // For http(s) media (incl. public YouTube URLs and Gemini File API uris),
        // use file_data so Gemini resolves it. Only pass a CONCRETE mime_type if the
        // caller supplied one — never a wildcard like 'video/*' (Gemini rejects it
        // with INVALID_ARGUMENT). File API uris already carry their registered type.
        const concreteMime = typeof part.mime_type === 'string' && part.mime_type && !part.mime_type.includes('*')
          ? part.mime_type : undefined;
        parts.push({ file_data: { file_uri: url, ...(concreteMime ? { mime_type: concreteMime } : {}) } });
        continue;
      }
    }
    // input_audio: { input_audio: { data: <b64>, format: 'wav'|'mp3'|... } }
    if (part.input_audio?.data) {
      const fmt = String(part.input_audio.format || 'wav').toLowerCase();
      parts.push({ inline_data: { mime_type: `audio/${fmt}`, data: part.input_audio.data } });
      continue;
    }
    if (typeof part.content === 'string' && part.content) parts.push({ text: part.content });
  }
  return parts;
}

function openAiMessagesToGemini(messages: any[]): { contents: any[]; systemInstruction?: any } {
  const systemParts: any[] = [];
  const contents: any[] = [];
  for (const msg of messages || []) {
    const role = String(msg?.role || 'user');
    const parts = contentToGeminiParts(msg?.content);
    if (!parts.length) continue;
    if (role === 'system' || role === 'developer') {
      // System instruction is text-only in Gemini; keep just the text parts.
      for (const p of parts) if (typeof p.text === 'string') systemParts.push(p);
      continue;
    }
    contents.push({ role: role === 'assistant' ? 'model' : 'user', parts });
  }
  return {
    contents,
    systemInstruction: systemParts.length ? { parts: systemParts } : undefined,
  };
}

function parseGeminiUsage(parsed: any, fallbackInput: number) {
  const u = parsed?.usageMetadata || {};
  // Gemini's promptTokenCount INCLUDES cached tokens; split them so the
  // input_tokens column means "uncached input" like every other provider.
  const prompt = u.promptTokenCount ?? fallbackInput;
  const cached = u.cachedContentTokenCount ?? 0;
  return {
    inputTokens: Math.max(0, prompt - cached),
    outputTokens: u.candidatesTokenCount ?? 0,
    cacheCreationTokens: 0,
    cacheReadTokens: cached,
    reasoningTokens: u.thoughtsTokenCount ?? undefined,
  };
}

function wantsGeminiGoogleSearch(body: any): boolean {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  return tools.some((t: any) => t?.google_search || t?.googleSearch || t?.type === 'google_search' || t?.type === 'web_search');
}

function groundingSources(candidate: any): Array<{ title: string; url: string }> {
  const gm = candidate?.groundingMetadata || candidate?.grounding_metadata || {};
  const chunks = gm.groundingChunks || gm.grounding_chunks || [];
  const seen = new Set<string>();
  const out: Array<{ title: string; url: string }> = [];
  for (const c of chunks) {
    const web = c?.web || {};
    const url = web.uri || web.url;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ title: web.title || url, url });
  }
  return out;
}

function geminiChatToOpenAi(parsed: any, model: string) {
  const candidate = parsed?.candidates?.[0] || {};
  const baseText = (candidate?.content?.parts || []).map((p: any) => typeof p?.text === 'string' ? p.text : '').join('');
  const sources = groundingSources(candidate);
  const sourceText = sources.length ? `\n\nSources:\n${sources.map((s, i) => `${i + 1}. ${s.title} — ${s.url}`).join('\n')}` : '';
  const text = baseText + sourceText;
  const usageMetadata = parsed?.usageMetadata || {};
  return {
    id: `chatcmpl-gemini-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: text,
        ...(sources.length ? { annotations: sources.map((s) => ({ type: 'url_citation', url: s.url, title: s.title })) } : {}),
      },
      finish_reason: String(candidate?.finishReason || 'stop').toLowerCase(),
    }],
    usage: {
      prompt_tokens: usageMetadata.promptTokenCount || 0,
      completion_tokens: usageMetadata.candidatesTokenCount || 0,
      total_tokens: usageMetadata.totalTokenCount || ((usageMetadata.promptTokenCount || 0) + (usageMetadata.candidatesTokenCount || 0)),
      ...(usageMetadata.toolUsePromptTokenCount ? { tool_use_prompt_tokens: usageMetadata.toolUsePromptTokenCount } : {}),
    },
    ...(sources.length ? { grounding_metadata: candidate.groundingMetadata || candidate.grounding_metadata } : {}),
  };
}

function pcmToWav(pcm: Buffer, sampleRate = 24000, channels = 1, bitsPerSample = 16): Buffer {
  const blockAlign = channels * bitsPerSample / 8;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function extractGeminiInlineAudio(parsed: any): Buffer | null {
  const parts = parsed?.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    const data = part?.inlineData?.data || part?.inline_data?.data;
    if (typeof data === 'string' && data) return Buffer.from(data, 'base64');
  }
  return null;
}

function validateModelForFamily(model: string, family: GeminiModelFamily): boolean {
  if (!KNOWN_GEMINI_MODELS.has(model)) return false;
  if (family === 'embeddings') return KNOWN_GEMINI_EMBEDDING_MODELS.has(model);
  if (family === 'tts') return KNOWN_GEMINI_TTS_MODELS.has(model);
  if (family === 'chat-video') return KNOWN_GEMINI_VIDEO_MODELS.has(model);
  // 'chat' route accepts both the text-only flash-lite models and the
  // multimodal video-capable models (which are tracked under chat-video for caps).
  return KNOWN_GEMINI_CHAT_MODELS.has(model) || KNOWN_GEMINI_VIDEO_MODELS.has(model);
}

async function withGeminiAccount(req: any, reply: any, input: {
  family: GeminiModelFamily;
  model: string;
  endpoint: string;
  inputTokens: number;
  // When set, the request is pinned to this single account (used for File API
  // referenced-file inference, where the file is private to the uploading key).
  // No failover across keys is possible — the file only exists on this one.
  pinnedAccountId?: number | null;
  fn: (account: any, attempt: number) => Promise<{ statusCode: number; usage?: any; response: () => void | Promise<void>; rawError?: string }>;
}) {
  const auth = await requireProxyToken(req, reply);
  if (!auth) return;
  const started = Date.now();
  const allowed = isModelAllowedForUser(auth.user, 'gemini', input.model);
  if (!allowed.ok) {
    reply.code(400).send(modelNotAllowedForUserError(allowed.message));
    return;
  }
  const limit = checkLooseLimit(auth.user, 'gemini', auth.token, input.model);
  if (!limit.ok) {
    reply.code(429).send(openAiError(limit.message, 'insufficient_quota', 'user_limit_exceeded'));
    return;
  }

  // Pinned mode: a referenced uploaded file lives only on one key, so we cannot
  // fail over. Validate the pin up front and run a single attempt against it.
  if (input.pinnedAccountId != null) {
    const pinned = getGeminiAccountById(input.pinnedAccountId);
    if (!pinned) {
      reply.code(400).send(openAiError('Referenced file belongs to a Gemini key that is no longer available; re-upload the file.', 'invalid_request_error', 'file_account_unavailable'));
      return;
    }
  }

  const tried: number[] = [];
  let lastError = 'No Gemini account available';
  let retryAfter = secondsUntilNextPacificMidnight();
  const maxAttempts = input.pinnedAccountId != null ? 1 : 10;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const account = input.pinnedAccountId != null
      ? (tried.includes(input.pinnedAccountId) ? null : getGeminiAccountById(input.pinnedAccountId))
      : selectGeminiAccount(input.family, tried);
    if (!account) break;
    tried.push(account.id);
    if (!acquireGeminiSlot(account)) {
      lastError = 'Gemini account at concurrency cap';
      continue;
    }
    let released = false;
    const release = () => { if (!released) { released = true; releaseGeminiSlot(account); } };
    recordGeminiAttempt(account.id, input.family);
    try {
      const result = await input.fn(account, attempt + 1);
      release();
      if (result.statusCode === 429) {
        const cls = classifyGeminiRateLimit(result.rawError);
        if (cls.kind === 'per_day') {
          // Hard daily (RPD) exhaustion: skip this key until Pacific midnight.
          const ms = secondsUntilNextPacificMidnight() * 1000;
          markGeminiFamilyExhausted(account.id, input.family);
          markGeminiCooldown(account.id, ms, `daily ${input.family} quota exhausted`);
          retryAfter = secondsUntilNextPacificMidnight();
          lastError = result.rawError?.slice(0, 500) || `${input.family} daily quota exhausted`;
        } else {
          // Transient per-minute (RPM/TPM) throttle: short cooldown, keep the
          // key in rotation. Do NOT mark the family exhausted for the day.
          const ms = cls.retryDelayMs ?? GEMINI_PER_MINUTE_COOLDOWN_MS;
          markGeminiCooldown(account.id, ms, `per-minute ${input.family} rate limit (${Math.round(ms / 1000)}s)`);
          retryAfter = Math.max(1, Math.ceil(ms / 1000));
          lastError = result.rawError?.slice(0, 500) || `${input.family} per-minute rate limit`;
        }
        recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'gemini', endpoint: input.endpoint, model: input.model, stream: false, statusCode: 429, inputTokens: input.inputTokens, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, tokenLabel: auth.token.label, providerAccountLabel: account.label });
        continue;
      }
      if (result.statusCode >= 400) {
        lastError = result.rawError?.slice(0, 500) || String(result.statusCode);
        recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'gemini', endpoint: input.endpoint, model: input.model, stream: false, statusCode: result.statusCode, inputTokens: input.inputTokens, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, tokenLabel: auth.token.label, providerAccountLabel: account.label });
        await result.response();
        return;
      }

      recordGeminiSuccess(account.id);
      const usage = result.usage || { inputTokens: input.inputTokens, outputTokens: 0 };
      const usageEventId = recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'gemini', endpoint: input.endpoint, model: input.model, stream: false, statusCode: result.statusCode, ...usage, estimatedCostUsd: estimateCost(input.model, usage, 'gemini'), latencyMs: Date.now() - started, tokenLabel: auth.token.label, providerAccountLabel: account.label });
      enforceAfterUsage(auth.user, 'gemini', auth.token, input.model);
      if (shouldLogBody(auth.user)) logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: { endpoint: input.endpoint, model: input.model, account: account.label }, responseText: JSON.stringify({ statusCode: result.statusCode }) });
      await result.response();
      return;
    } catch (err: any) {
      release();
      const timedOut = isAbortTimeoutError(err);
      lastError = timedOut ? timeoutMessage(timeoutSeconds(REQUEST_TIMEOUT_MS)) : transientNetworkMessage('gemini');
      const statusCode = timedOut ? 504 : 502;
      if (!timedOut) markGeminiCooldown(account.id, 60_000, `network error: ${err?.message || err}`);
      recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'gemini', endpoint: input.endpoint, model: input.model, stream: false, statusCode, inputTokens: input.inputTokens, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, tokenLabel: auth.token.label, providerAccountLabel: account.label });
      if (timedOut) {
        reply.code(504).send(openAiError(lastError, 'timeout', 'gateway_timeout'));
        return;
      }
    }
  }

  reply.header('retry-after', String(retryAfter));
  reply.header('x-gateway-provider', 'gemini');
  const capacityMsg = retryAfter >= 3600
    ? `Gemini ${input.family} capacity unavailable until next Pacific midnight: ${lastError}`
    : `Gemini ${input.family} capacity temporarily unavailable, retry in ${retryAfter}s: ${lastError}`;
  reply.code(429).send(openAiError(capacityMsg, 'rate_limit_exceeded', 'rate_limit_exceeded'));
}

async function forwardGeminiEmbeddings(req: any, reply: any) {
  const body = { ...((req.body as any) || {}) };
  const model = typeof body.model === 'string' && body.model ? body.model : DEFAULT_GEMINI_EMBEDDING_MODEL;
  if (!validateModelForFamily(model, 'embeddings')) {
    reply.code(400).send(openAiError(`Unknown Gemini embeddings model: ${model}`, 'invalid_request_error', 'model_not_allowed'));
    return;
  }
  const input = Array.isArray(body.input) ? body.input : [body.input];
  if (!input.length || input.some((x: any) => typeof x !== 'string')) {
    reply.code(400).send(openAiError('input must be a string or string[]', 'invalid_request_error', 'invalid_request'));
    return;
  }
  const inputTokens = input.reduce((sum: number, text: string) => sum + estimateTextTokens(text), 0);
  await withGeminiAccount(req, reply, { family: 'embeddings', model, endpoint: '/v1/gemini/embeddings', inputTokens, fn: async (account, attempt) => {
    const isBatch = input.length > 1;
    const upstreamBody = isBatch
      ? { requests: input.map((text: string) => ({ model: `models/${model}`, content: { parts: [{ text }] } })) }
      : { content: { parts: [{ text: input[0] }] } };
    const upstream = await fetch(geminiUrl(model, isBatch ? 'batchEmbedContents' : 'embedContent', account.secret), {
      method: 'POST', headers: cleanHeaders(req.headers), body: JSON.stringify(upstreamBody), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    reply.header('x-gateway-provider', 'gemini');
    reply.header('x-gateway-account', account.label);
    reply.header('x-gateway-attempt', String(attempt));
    const text = await upstream.text().catch(() => '');
    if (upstream.status >= 400) return { statusCode: upstream.status, rawError: text || upstream.statusText, response: () => reply.code(upstream.status).type('application/json').send(text || openAiError(text || upstream.statusText)) };
    const parsed = JSON.parse(text || '{}');
    const embeddings = isBatch ? (parsed.embeddings || []).map((e: any) => e.values || []) : [parsed.embedding?.values || []];
    const out = { object: 'list', data: embeddings.map((embedding: number[], index: number) => ({ object: 'embedding', index, embedding })), model, usage: { prompt_tokens: inputTokens, total_tokens: inputTokens } };
    return { statusCode: upstream.status, usage: { inputTokens, outputTokens: 0 }, response: () => reply.code(200).type('application/json').send(out) };
  }});
}

async function forwardGeminiChat(req: any, reply: any) {
  const body = { ...((req.body as any) || {}) };
  const model = typeof body.model === 'string' && body.model ? body.model : DEFAULT_GEMINI_CHAT_MODEL;
  // Video-capable models share the chat route but use a separate pool family
  // ('chat-video') so their tight ~20 RPD free-tier cap is tracked independently.
  const chatFamily: GeminiModelFamily = KNOWN_GEMINI_VIDEO_MODELS.has(model) ? 'chat-video' : 'chat';
  if (!validateModelForFamily(model, chatFamily)) {
    reply.code(400).send(openAiError(`Unknown Gemini chat model: ${model}`, 'invalid_request_error', 'model_not_allowed'));
    return;
  }
  if (body.stream) {
    reply.code(400).send(openAiError('Gemini streaming is not supported yet; send stream=false', 'invalid_request_error', 'stream_not_supported'));
    return;
  }
  if (!Array.isArray(body.messages)) {
    reply.code(400).send(openAiError('messages must be an array', 'invalid_request_error', 'invalid_request'));
    return;
  }
  const translated = openAiMessagesToGemini(body.messages);
  if (!translated.contents.length) {
    reply.code(400).send(openAiError('messages must include at least one user/assistant content item', 'invalid_request_error', 'invalid_request'));
    return;
  }
  // If any referenced file_uri carries our account hint, pin this request to the
  // uploading key (the file is private to that project) and strip the hint so the
  // clean uri goes upstream.
  const pinnedAccountId = extractAndStripFileUriPin(translated.contents);
  const upstreamBody: any = { contents: translated.contents };
  if (translated.systemInstruction) upstreamBody.systemInstruction = translated.systemInstruction;
  if (wantsGeminiGoogleSearch(body)) upstreamBody.tools = [{ google_search: {} }];
  const generationConfig: any = {};
  if (typeof body.temperature === 'number') generationConfig.temperature = body.temperature;
  if (typeof body.max_tokens === 'number') generationConfig.maxOutputTokens = body.max_tokens;
  // Thinking support: map OpenAI-style reasoning_effort or X-Thinking-Level header
  // to Google's thinkingConfig for thinking-capable models.
  if (GEMINI_THINKING_CAPABLE_MODELS.has(model)) {
    const reasoningEffort = typeof body.reasoning_effort === 'string' ? body.reasoning_effort : undefined;
    const headerThinking = typeof req.headers['x-thinking-level'] === 'string' ? req.headers['x-thinking-level'] : undefined;
    const thinkingLevel = resolveGeminiThinkingLevel(reasoningEffort, headerThinking);
    if (thinkingLevel) {
      generationConfig.thinkingConfig = { thinkingLevel };
    }
  }
  if (Object.keys(generationConfig).length) upstreamBody.generationConfig = generationConfig;
  const inputTokens = estimateInputTokens(body);
  await withGeminiAccount(req, reply, { family: chatFamily, model, endpoint: '/v1/gemini/chat/completions', inputTokens, pinnedAccountId, fn: async (account, attempt) => {
    const upstream = await fetch(geminiUrl(model, 'generateContent', account.secret), {
      method: 'POST', headers: cleanHeaders(req.headers), body: JSON.stringify(upstreamBody), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    reply.header('x-gateway-provider', 'gemini');
    reply.header('x-gateway-account', account.label);
    reply.header('x-gateway-attempt', String(attempt));
    const text = await upstream.text().catch(() => '');
    if (upstream.status >= 400) return { statusCode: upstream.status, rawError: text || upstream.statusText, response: () => reply.code(upstream.status).type('application/json').send(text || openAiError(text || upstream.statusText)) };
    const parsed = JSON.parse(text || '{}');
    const out = geminiChatToOpenAi(parsed, model);
    return { statusCode: upstream.status, usage: parseGeminiUsage(parsed, inputTokens), response: () => reply.code(200).type('application/json').send(out) };
  }});
}

async function forwardGeminiTts(req: any, reply: any) {
  const body = { ...((req.body as any) || {}) };
  const model = typeof body.model === 'string' && body.model ? body.model : DEFAULT_GEMINI_TTS_MODEL;
  if (!validateModelForFamily(model, 'tts')) {
    reply.code(400).send(openAiError(`Unknown Gemini TTS model: ${model}`, 'invalid_request_error', 'model_not_allowed'));
    return;
  }
  const text = typeof body.input === 'string' ? body.input : typeof body.text === 'string' ? body.text : '';
  if (!text.trim()) {
    reply.code(400).send(openAiError('input or text must be a non-empty string', 'invalid_request_error', 'invalid_request'));
    return;
  }
  if (text.length > GEMINI_MAX_TTS_CHARS) {
    reply.code(400).send(openAiError('text exceeds 15000 character limit', 'invalid_request_error', 'invalid_request'));
    return;
  }
  const voice = typeof body.voice === 'string' && body.voice ? body.voice : 'Kore';
  const inputTokens = estimateTextTokens(text);
  const upstreamBody = {
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
      },
    },
  };
  await withGeminiAccount(req, reply, { family: 'tts', model, endpoint: '/v1/gemini/tts', inputTokens, fn: async (account, attempt) => {
    const upstream = await fetch(geminiUrl(model, 'generateContent', account.secret), {
      method: 'POST', headers: cleanHeaders(req.headers, 'application/json'), body: JSON.stringify(upstreamBody), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    reply.header('x-gateway-provider', 'gemini');
    reply.header('x-gateway-account', account.label);
    reply.header('x-gateway-attempt', String(attempt));
    const textBody = await upstream.text().catch(() => '');
    if (upstream.status >= 400) return { statusCode: upstream.status, rawError: textBody || upstream.statusText, response: () => reply.code(upstream.status).type('application/json').send(textBody || openAiError(textBody || upstream.statusText)) };
    const parsed = JSON.parse(textBody || '{}');
    const pcm = extractGeminiInlineAudio(parsed);
    if (!pcm) return { statusCode: 502, rawError: 'Gemini TTS response missing inline audio', response: () => reply.code(502).send(openAiError('Gemini TTS response missing inline audio', 'server_error', 'bad_gateway')) };
    const wav = pcmToWav(pcm);
    return { statusCode: upstream.status, usage: parseGeminiUsage(parsed, inputTokens), response: () => reply.code(200).type('audio/wav').send(wav) };
  }});
}

// POST /v1/gemini/files — upload a media file (e.g. a large video) to Gemini's File
// API through a pooled key. Body = raw file bytes; Content-Type = the media type
// (video/mp4 etc). Optional ?display_name=. Returns the uploaded file's metadata
// with a tagged file_uri (carries the uploading account id) the client passes
// straight into the chat route as a file_data.file_uri part.
async function forwardGeminiFileUpload(req: any, reply: any) {
  const auth = await requireProxyToken(req, reply);
  if (!auth) return;
  const contentType = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim();
  if (contentType === 'application/json') {
    reply.code(400).send(openAiError('Send the raw file bytes as the body with a media Content-Type (e.g. video/mp4), not JSON.', 'invalid_request_error', 'invalid_content_type'));
    return;
  }
  // Body was buffered by the content-type parser (parseAs: 'buffer'). Cap enforced
  // by the route bodyLimit (Fastify returns 413 before we get here if exceeded).
  const buf: Buffer | undefined = Buffer.isBuffer(req.body) ? req.body : undefined;
  if (!buf) {
    reply.code(400).send(openAiError(`Unsupported upload Content-Type '${contentType}'. Send raw bytes as video/*, image/*, audio/*, application/pdf, or application/octet-stream.`, 'invalid_request_error', 'invalid_content_type'));
    return;
  }
  if (!buf.length) {
    reply.code(400).send(openAiError('Empty upload body', 'invalid_request_error', 'invalid_request'));
    return;
  }
  const displayName = typeof (req.query as any)?.display_name === 'string' ? (req.query as any).display_name : 'upload';
  const started = Date.now();

  // Pick an upload account (no per-day request cap on uploads). Try a couple of
  // keys on transient failure, but the chosen key is what the file is bound to.
  const tried: number[] = [];
  let lastError = 'No Gemini account available for upload';
  for (let attempt = 0; attempt < 3; attempt++) {
    const account = selectGeminiUploadAccount(tried);
    if (!account) break;
    tried.push(account.id);
    if (!acquireGeminiSlot(account)) { lastError = 'Gemini account at concurrency cap'; continue; }
    let released = false;
    const release = () => { if (!released) { released = true; releaseGeminiSlot(account); } };
    try {
      const uploadBase = geminiUploadBaseUrl();
      // 1) start resumable session
      const startRes = await fetch(`${uploadBase}?key=${encodeURIComponent(account.secret)}`, {
        method: 'POST',
        headers: {
          'X-Goog-Upload-Protocol': 'resumable',
          'X-Goog-Upload-Command': 'start',
          'X-Goog-Upload-Header-Content-Length': String(buf.length),
          'X-Goog-Upload-Header-Content-Type': contentType,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ file: { display_name: displayName } }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const uploadUrl = startRes.headers.get('x-goog-upload-url');
      if (startRes.status >= 400 || !uploadUrl) {
        const errTxt = await startRes.text().catch(() => '');
        if (startRes.status === 429) { markGeminiCooldown(account.id, GEMINI_PER_MINUTE_COOLDOWN_MS, 'upload rate limit'); lastError = errTxt || 'upload rate limit'; release(); continue; }
        release();
        reply.code(startRes.status >= 400 ? startRes.status : 502).send(openAiError(errTxt || 'Failed to start Gemini upload', 'server_error', 'upload_start_failed'));
        return;
      }
      // 2) upload bytes + finalize
      const upRes = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          'Content-Length': String(buf.length),
          'X-Goog-Upload-Offset': '0',
          'X-Goog-Upload-Command': 'upload, finalize',
        },
        body: new Uint8Array(buf),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const upTxt = await upRes.text().catch(() => '');
      release();
      recordGeminiSuccess(account.id);
      if (upRes.status >= 400) {
        reply.code(upRes.status).send(openAiError(upTxt || 'Gemini upload failed', 'server_error', 'upload_failed'));
        return;
      }
      const parsed = JSON.parse(upTxt || '{}');
      const file = parsed.file || parsed;
      const rawUri = file.uri || '';
      const taggedUri = rawUri ? taggedFileUri(rawUri, account.id) : rawUri;
      recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'gemini', endpoint: '/v1/gemini/files', model: 'file-upload', stream: false, statusCode: upRes.status, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, latencyMs: Date.now() - started, tokenLabel: auth.token.label, providerAccountLabel: account.label });
      reply.header('x-gateway-provider', 'gemini');
      reply.header('x-gateway-account', account.label);
      reply.code(200).type('application/json').send({
        name: file.name,
        uri: taggedUri,
        file_uri: taggedUri,
        mime_type: file.mimeType || file.mime_type || contentType,
        size_bytes: Number(file.sizeBytes || file.size_bytes || buf.length),
        state: file.state,
        expiration_time: file.expirationTime || file.expiration_time,
      });
      return;
    } catch (err: any) {
      release();
      const timedOut = isAbortTimeoutError(err);
      if (!timedOut) markGeminiCooldown(account.id, 60_000, `upload network error: ${err?.message || err}`);
      lastError = timedOut ? 'Upload timed out' : `Upload network error: ${err?.message || err}`;
    }
  }
  reply.code(502).send(openAiError(`Gemini file upload failed: ${lastError}`, 'server_error', 'upload_failed'));
}

// GET /v1/gemini/files/:id  — check processing state (ACTIVE/PROCESSING/FAILED).
// The :id may carry the nbmg_acct hint so we query under the owning key.
async function forwardGeminiFileGet(req: any, reply: any) {
  const auth = await requireProxyToken(req, reply);
  if (!auth) return;
  const rawId = String((req.params as any)?.id || '');
  const { cleanUri, accountId } = parseFileUriHint(rawId);
  const name = cleanUri.startsWith('files/') ? cleanUri : `files/${cleanUri}`;
  const account = accountId != null ? getGeminiAccountById(accountId) : selectGeminiUploadAccount();
  if (!account) { reply.code(400).send(openAiError('No Gemini key available to query this file (it may have expired).', 'invalid_request_error', 'file_account_unavailable')); return; }
  try {
    const res = await fetch(`${geminiFilesBaseUrl().replace(/\/files$/, '')}/${name}?key=${encodeURIComponent(account.secret)}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const txt = await res.text().catch(() => '');
    reply.header('x-gateway-account', account.label);
    if (res.status >= 400) { reply.code(res.status).type('application/json').send(txt || openAiError('File status query failed')); return; }
    const file = JSON.parse(txt || '{}');
    const taggedUri = file.uri ? taggedFileUri(file.uri, account.id) : file.uri;
    reply.code(200).type('application/json').send({ name: file.name, uri: taggedUri, file_uri: taggedUri, state: file.state, mime_type: file.mimeType, size_bytes: Number(file.sizeBytes || 0), expiration_time: file.expirationTime });
  } catch (err: any) {
    reply.code(502).send(openAiError(`File status query failed: ${err?.message || err}`, 'server_error', 'bad_gateway'));
  }
}

// DELETE /v1/gemini/files/:id  — delete an uploaded file early (before 48h auto-expiry).
async function forwardGeminiFileDelete(req: any, reply: any) {
  const auth = await requireProxyToken(req, reply);
  if (!auth) return;
  const rawId = String((req.params as any)?.id || '');
  const { cleanUri, accountId } = parseFileUriHint(rawId);
  const name = cleanUri.startsWith('files/') ? cleanUri : `files/${cleanUri}`;
  const account = accountId != null ? getGeminiAccountById(accountId) : null;
  if (!account) { reply.code(400).send(openAiError('Deleting a file requires its tagged id (with the owning key hint).', 'invalid_request_error', 'file_account_unavailable')); return; }
  try {
    const res = await fetch(`${geminiFilesBaseUrl().replace(/\/files$/, '')}/${name}?key=${encodeURIComponent(account.secret)}`, { method: 'DELETE', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    reply.header('x-gateway-account', account.label);
    reply.code(res.status >= 400 ? res.status : 200).type('application/json').send(res.status >= 400 ? openAiError('Delete failed') : { deleted: true, name });
  } catch (err: any) {
    reply.code(502).send(openAiError(`File delete failed: ${err?.message || err}`, 'server_error', 'bad_gateway'));
  }
}

// Register a buffer content-type parser, tolerating the case where another proxy
// (e.g. deepgram, which buffers audio/* and application/octet-stream app-wide)
// already registered the same type. hasContentTypeParser() is unreliable here
// because registration ORDER matters (gemini is registered before deepgram in
// server.ts) and it doesn't match deepgram's regex parser — so we catch the
// FST_ERR_CTP_ALREADY_PRESENT instead. Either way the type ends up buffered
// (req.body = Buffer), which is exactly what the upload handler needs.
function addBufferParserSafe(app: FastifyInstance, contentType: string) {
  try {
    app.addContentTypeParser(contentType, { parseAs: 'buffer', bodyLimit: GEMINI_FILE_UPLOAD_LIMIT_BYTES }, (_req, body, done) => done(null, body));
  } catch (err: any) {
    if (err?.code !== 'FST_ERR_CTP_ALREADY_PRESENT') throw err;
    // Already registered by another proxy — fine, it buffers the body the same way.
  }
}

export function registerGeminiProxy(app: FastifyInstance) {
  // Buffer binary media for the File API upload route so req.body is a Buffer.
  // IMPORTANT: do NOT list application/octet-stream or audio/* here — the deepgram
  // proxy registers those app-wide (and is registered AFTER gemini in server.ts),
  // so claiming them here makes deepgram's own registration throw
  // FST_ERR_CTP_ALREADY_PRESENT and crash boot. Octet-stream/audio uploads still
  // work: deepgram's parsers buffer them into req.body the same way.
  // addBufferParserSafe tolerates collisions for the remaining (video/image/pdf)
  // types in case another proxy ever claims one of them too.
  for (const ct of ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska', 'video/x-msvideo', 'video/mpeg', 'image/png', 'image/jpeg', 'image/webp', 'image/heic', 'application/pdf']) {
    addBufferParserSafe(app, ct);
  }
  app.post('/v1/gemini/embeddings', (req, reply) => forwardGeminiEmbeddings(req, reply));
  app.post('/v1/gemini/chat/completions', { bodyLimit: GEMINI_CHAT_BODY_LIMIT_BYTES }, (req, reply) => forwardGeminiChat(req, reply));
  app.post('/v1/gemini/tts', { bodyLimit: GEMINI_TTS_BODY_LIMIT_BYTES }, (req, reply) => forwardGeminiTts(req, reply));
  // File API passthrough for large media (videos up to ~2 GB on free tier).
  app.post('/v1/gemini/files', { bodyLimit: GEMINI_FILE_UPLOAD_LIMIT_BYTES }, (req, reply) => forwardGeminiFileUpload(req, reply));
  app.get('/v1/gemini/files/:id', (req, reply) => forwardGeminiFileGet(req, reply));
  app.delete('/v1/gemini/files/:id', (req, reply) => forwardGeminiFileDelete(req, reply));
}
