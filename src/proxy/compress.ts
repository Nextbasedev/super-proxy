/**
 * Headroom context compression middleware for Super Proxy.
 *
 * Intercepts chat/completions and /v1/messages requests, compresses tool outputs
 * and conversation history via the Headroom sidecar, and replaces the messages
 * in the request body with the compressed version.
 *
 * Fallback-safe: if Headroom is unreachable, times out, or returns an error,
 * the original request proceeds unchanged.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config.js';
import { getProxyToken } from '../auth/token-auth.js';
import { sha256 } from '../utils/crypto.js';
import { getDb } from '../db/index.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type CompressionStatus = 'compressed' | 'skipped' | 'timeout' | 'error' | 'negative' | 'disabled';

export interface CompressionResult {
  status: CompressionStatus;
  tokensBefore: number;
  tokensSaved: number;
  compressionMs: number;
}

// Attached to the request object for downstream usage recording
declare module 'fastify' {
  interface FastifyRequest {
    compressionResult?: CompressionResult;
  }
}

// ─── Anthropic ↔ OpenAI Format Converters ────────────────────────────────────

interface OpenAIMessage {
  role: string;
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

/**
 * Convert Anthropic message format (tool_use/tool_result content blocks)
 * to OpenAI format (tool_calls/tool roles) for compression.
 */
export function anthropicToOpenAI(system: any, messages: any[]): OpenAIMessage[] {
  const oai: OpenAIMessage[] = [];

  // System
  if (system) {
    let sysText: string;
    if (typeof system === 'string') {
      sysText = system;
    } else if (Array.isArray(system)) {
      sysText = system
        .filter((b: any) => b?.type === 'text')
        .map((b: any) => b.text || '')
        .join(' ');
    } else {
      sysText = String(system);
    }
    if (sysText) oai.push({ role: 'system', content: sysText });
  }

  for (const msg of messages) {
    const role = msg?.role || 'user';
    const content = msg?.content;

    if (role === 'assistant' && Array.isArray(content)) {
      const toolCalls: OpenAIMessage['tool_calls'] = [];
      const textParts: string[] = [];

      for (const block of content) {
        if (block?.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {}),
            },
          });
        } else if (block?.type === 'text') {
          textParts.push(block.text || '');
        }
      }

      if (toolCalls.length > 0) {
        oai.push({
          role: 'assistant',
          content: textParts.length > 0 ? textParts.join(' ') : null,
          tool_calls: toolCalls,
        });
      } else {
        oai.push({ role: 'assistant', content: textParts.join(' ') });
      }
    } else if (role === 'user' && Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'tool_result') {
          let toolContent: string;
          if (typeof block.content === 'string') {
            toolContent = block.content;
          } else if (Array.isArray(block.content)) {
            toolContent = block.content
              .filter((b: any) => b?.type === 'text')
              .map((b: any) => b.text || '')
              .join(' ');
          } else {
            toolContent = String(block.content ?? '');
          }
          oai.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: toolContent,
          });
        } else if (block?.type === 'text') {
          oai.push({ role: 'user', content: block.text || '' });
        }
        // Skip image/other block types — they pass through uncompressed
      }
    } else {
      oai.push({
        role,
        content: typeof content === 'string' ? content : (content != null ? String(content) : ''),
      });
    }
  }

  return oai;
}

/**
 * Map compressed OpenAI tool messages back into the original Anthropic message
 * structure. Only replaces tool_result content; all other structure is preserved.
 */
export function openAIToAnthropic(compressedOAI: OpenAIMessage[], origMessages: any[]): any[] {
  // Build map: tool_call_id → compressed content
  const compressedToolMap = new Map<string, string>();
  for (const m of compressedOAI) {
    if (m.role === 'tool' && m.tool_call_id) {
      compressedToolMap.set(m.tool_call_id, m.content || '');
    }
  }

  if (compressedToolMap.size === 0) return origMessages;

  return origMessages.map((msg: any) => {
    if (msg?.role !== 'user' || !Array.isArray(msg?.content)) return msg;

    const newBlocks = msg.content.map((block: any) => {
      if (block?.type === 'tool_result' && compressedToolMap.has(block.tool_use_id)) {
        return {
          ...block,
          content: compressedToolMap.get(block.tool_use_id)!,
        };
      }
      return block;
    });

    return { ...msg, content: newBlocks };
  });
}

// ─── Global Settings (DB + env) ──────────────────────────────────────────────

/** Read a setting from app_settings table. Returns null if not found. */
function getAppSetting(key: string): string | null {
  try {
    const row = getDb().prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as any;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

/** Write a setting to app_settings table. */
export function setAppSetting(key: string, value: string): void {
  getDb().prepare(
    'INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP'
  ).run(key, value);
}

/**
 * Check if headroom is globally enabled.
 * Env var takes precedence over DB setting.
 */
export function isHeadroomGloballyEnabled(): boolean {
  // Env var is authoritative if set
  if (process.env.HEADROOM_ENABLED === 'true') return true;
  if (process.env.HEADROOM_ENABLED === 'false') return false;
  // Fall back to DB setting
  return getAppSetting('headroom.enabled') === 'true';
}

/**
 * Get the set of providers to skip compression for.
 * Env var takes precedence over DB setting.
 */
export function getSkipProviders(): Set<string> {
  const envVal = process.env.HEADROOM_SKIP_PROVIDERS;
  const raw = envVal || getAppSetting('headroom.skipProviders') || '';
  return new Set(raw.split(',').map(s => s.trim()).filter(Boolean));
}

/** Get all headroom settings for the dashboard. */
export function getHeadroomSettings(): { enabled: boolean; skipProviders: string[]; url: string; timeoutMs: number; minTokens: number } {
  return {
    enabled: isHeadroomGloballyEnabled(),
    skipProviders: [...getSkipProviders()],
    url: config.headroomUrl,
    timeoutMs: config.headroomTimeoutMs,
    minTokens: config.headroomMinTokens,
  };
}

// ─── Per-User Compression Cache ───────────────────────────────────────────────────

// TTL cache: token → compression_enabled (boolean). Avoids hitting DB on every request.
const compressionEnabledCache = new Map<string, boolean>();
const CACHE_TTL_MS = 60 * 1000; // 1 minute (short enough to pick up admin changes quickly)
const cacheTimestamps = new Map<string, number>();

/** Invalidate the compression cache for all users. Called when admin updates user settings. */
export function invalidateCompressionCache(): void {
  compressionEnabledCache.clear();
  cacheTimestamps.clear();
}

function lookupCompressionEnabled(token: string): boolean {
  try {
    const row = getDb().prepare(
      'SELECT u.compression_enabled FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?'
    ).get(sha256(token)) as any;
    const enabled = row ? row.compression_enabled !== 0 : true; // default true if column missing
    compressionEnabledCache.set(token, enabled);
    cacheTimestamps.set(token, Date.now());
    // Evict stale entries periodically
    if (compressionEnabledCache.size > 500) {
      const now = Date.now();
      for (const [k, ts] of cacheTimestamps) {
        if (now - ts > CACHE_TTL_MS) {
          compressionEnabledCache.delete(k);
          cacheTimestamps.delete(k);
        }
      }
    }
    return enabled;
  } catch {
    return true; // fail-open: if lookup fails, allow compression
  }
}

// ─── Responses API (xAI) ↔ OpenAI Format Converters ─────────────────────────

/**
 * Convert OpenAI Responses API input items (message, function_call, function_call_output)
 * to OpenAI chat messages for compression.
 */
export function responsesInputToOpenAI(inputItems: any[]): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [];

  for (const item of inputItems) {
    const t = item?.type || '';

    if (t === 'message') {
      messages.push({ role: item.role || 'user', content: item.content || '' });
    } else if (t === 'function_call') {
      const tc = {
        id: item.call_id || '',
        type: 'function' as const,
        function: {
          name: item.name || '',
          arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
        },
      };
      // Group with previous assistant message if it has tool_calls
      const prev = messages.length > 0 ? messages[messages.length - 1] : null;
      if (prev && prev.role === 'assistant' && prev.tool_calls) {
        prev.tool_calls.push(tc);
      } else {
        messages.push({ role: 'assistant', content: null, tool_calls: [tc] });
      }
    } else if (t === 'function_call_output') {
      let output = item.output ?? '';
      // output can be string or array of content parts
      if (Array.isArray(output)) {
        output = output
          .filter((p: any) => p?.type === 'input_text' || p?.type === 'text')
          .map((p: any) => p.text || '')
          .join(' ');
      }
      messages.push({ role: 'tool', tool_call_id: item.call_id || '', content: String(output) });
    }
    // Skip other item types (reasoning, etc.) — they pass through uncompressed
  }

  return messages;
}

/**
 * Map compressed OpenAI tool messages back into Responses API input items.
 * Only replaces function_call_output content; all other items pass through.
 */
export function openAIToResponsesInput(compressedOAI: OpenAIMessage[], origItems: any[]): any[] {
  // Build map: call_id → compressed output
  const compressedMap = new Map<string, string>();
  for (const m of compressedOAI) {
    if (m.role === 'tool' && m.tool_call_id) {
      compressedMap.set(m.tool_call_id, m.content || '');
    }
  }

  if (compressedMap.size === 0) return origItems;

  return origItems.map((item: any) => {
    if (item?.type === 'function_call_output' && compressedMap.has(item.call_id)) {
      return { ...item, output: compressedMap.get(item.call_id)! };
    }
    return item;
  });
}

// ─── Compression Call ────────────────────────────────────────────────────────

interface HeadroomCompressResponse {
  messages: OpenAIMessage[];
  tokens_before: number;
  tokens_after: number;
  tokens_saved: number;
}

/**
 * Call Headroom /v1/compress to compress messages.
 * Returns null on any failure (timeout, network, parse error).
 */
async function callHeadroomCompress(
  messages: OpenAIMessage[],
  model: string,
): Promise<HeadroomCompressResponse | null> {
  const url = `${config.headroomUrl}/v1/compress`;
  const body = JSON.stringify({ messages, model });

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(config.headroomTimeoutMs),
    });

    if (!resp.ok) {
      return null;
    }

    return (await resp.json()) as HeadroomCompressResponse;
  } catch {
    return null;
  }
}

// ─── Route Helpers ───────────────────────────────────────────────────────────

/** Extract provider name from a request URL. */
function providerFromUrl(url: string): string {
  // /v1/messages → anthropic
  if (/^\/v1\/messages/.test(url)) return 'anthropic';
  // /v1/<provider>/... → provider
  const match = url.match(/^\/v1\/([a-z][a-z0-9_-]*)\//i);
  return match ? match[1].toLowerCase() : 'unknown';
}

/** Check if this URL is a compressible route. */
function isCompressibleRoute(url: string): boolean {
  return /\/chat\/completions/.test(url) || /\/messages/.test(url) || /\/xai\/responses/.test(url);
}

/** Check if this URL is an Anthropic-format route. */
function isAnthropicRoute(url: string): boolean {
  // /v1/messages or /v1/*/messages but NOT /v1/xai/responses
  return /\/messages/.test(url) && !/\/xai\//.test(url);
}

/** Check if this URL is a Responses API route (xAI). */
function isResponsesRoute(url: string): boolean {
  return /\/xai\/responses/.test(url);
}

/** Rough token estimate from string length (4 chars ≈ 1 token). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─── Middleware ──────────────────────────────────────────────────────────────

/**
 * Compression preHandler hook. Attach to Fastify routes that should be compressed.
 *
 * Modifies `req.body.messages` in place with compressed versions.
 * Attaches `req.compressionResult` for downstream usage recording.
 */
export async function compressionMiddleware(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  if ((req.routeOptions.config as { disableCompression?: boolean } | undefined)?.disableCompression) return;

  // Global kill switch (checks env var first, then DB)
  if (!isHeadroomGloballyEnabled()) return;

  const url = req.url.split('?')[0]; // strip query params

  // Only compress chat/completions and messages routes
  if (!isCompressibleRoute(url)) return;

  // Per-provider skip (checks env var first, then DB)
  const provider = providerFromUrl(url);
  if (getSkipProviders().has(provider)) {
    return;
  }

  // Per-user override — lightweight cached lookup with TTL
  const token = getProxyToken(req);
  if (token) {
    const cachedTs = cacheTimestamps.get(token);
    const cached = cachedTs && (Date.now() - cachedTs < CACHE_TTL_MS) ? compressionEnabledCache.get(token) : undefined;
    const enabled = cached ?? lookupCompressionEnabled(token);
    if (enabled === false) {
      req.compressionResult = { status: 'disabled', tokensBefore: 0, tokensSaved: 0, compressionMs: 0 };
      return;
    }
  }

  // Prevent double-compression on fusion panel sub-requests
  if (req.headers['x-headroom-compressed'] === 'true') return;

  const body = req.body as any;
  const isAnthropic = isAnthropicRoute(url);
  const isResponses = isResponsesRoute(url);
  const model = typeof body.model === 'string' ? body.model : 'unknown';

  // Determine the compressible payload
  const payload = isResponses ? body?.input : body?.messages;
  if (!payload || !Array.isArray(payload) || payload.length === 0) return;

  // Pre-flight: rough size check — skip tiny payloads
  const rawSize = JSON.stringify(payload).length;
  if (estimateTokens(rawSize.toString()) < 100 && rawSize < config.headroomMinTokens * 4) {
    req.compressionResult = { status: 'skipped', tokensBefore: 0, tokensSaved: 0, compressionMs: 0 };
    return;
  }

  const t0 = Date.now();

  try {
    // Convert to OpenAI format based on API type
    let oaiMessages: OpenAIMessage[];
    if (isResponses) {
      oaiMessages = responsesInputToOpenAI(payload);
    } else if (isAnthropic) {
      oaiMessages = anthropicToOpenAI(body.system, payload);
    } else {
      oaiMessages = payload;
    }

    // Call Headroom
    const result = await callHeadroomCompress(oaiMessages, model);
    const compressionMs = Date.now() - t0;

    if (!result) {
      const status: CompressionStatus = compressionMs >= config.headroomTimeoutMs - 100 ? 'timeout' : 'error';
      req.compressionResult = { status, tokensBefore: 0, tokensSaved: 0, compressionMs };
      req.log?.warn?.({ provider, model, status, compressionMs }, 'headroom compression failed; passing through');
      return;
    }

    if (result.tokens_saved <= 0) {
      req.compressionResult = {
        status: 'skipped',
        tokensBefore: result.tokens_before,
        tokensSaved: 0,
        compressionMs,
      };
      return;
    }

    // Size guard: verify compressed is actually smaller
    const compressedSize = JSON.stringify(result.messages).length;
    const originalOAISize = JSON.stringify(oaiMessages).length;
    if (compressedSize >= originalOAISize) {
      req.compressionResult = {
        status: 'negative',
        tokensBefore: result.tokens_before,
        tokensSaved: result.tokens_saved,
        compressionMs,
      };
      req.log?.info?.({ provider, model, originalOAISize, compressedSize }, 'compression produced larger output; discarding');
      return;
    }

    // Apply compression back to the original format
    if (isResponses) {
      body.input = openAIToResponsesInput(result.messages, payload);
    } else if (isAnthropic) {
      body.messages = openAIToAnthropic(result.messages, payload);
    } else {
      body.messages = result.messages;
    }

    req.compressionResult = {
      status: 'compressed',
      tokensBefore: result.tokens_before,
      tokensSaved: result.tokens_saved,
      compressionMs,
    };

    req.log?.info?.(
      { provider, model, tokensBefore: result.tokens_before, tokensSaved: result.tokens_saved, compressionMs },
      'compressed request',
    );
  } catch (err: any) {
    const compressionMs = Date.now() - t0;
    const status: CompressionStatus = compressionMs >= config.headroomTimeoutMs - 100 ? 'timeout' : 'error';
    req.compressionResult = { status, tokensBefore: 0, tokensSaved: 0, compressionMs };
    req.log?.warn?.({ provider, model, err: err?.message, status, compressionMs }, 'headroom compression exception; passing through');
  }
}

// ─── Usage Helper ────────────────────────────────────────────────────────────

/**
 * Extract compression fields from a request for use in recordUsage().
 * Call this in provider proxies: { ...compressionFields(req) }
 */
export function compressionFields(req: FastifyRequest): {
  tokensBeforeCompression?: number;
  tokensSavedCompression?: number;
  compressionMs?: number;
  compressionStatus?: string;
} {
  const r = req.compressionResult;
  if (!r) return {};
  return {
    tokensBeforeCompression: r.tokensBefore || undefined,
    tokensSavedCompression: r.tokensSaved || undefined,
    compressionMs: r.compressionMs || undefined,
    compressionStatus: r.status,
  };
}

// ─── Registration ───────────────────────────────────────────────────────────

/**
 * Register the compression middleware on all compressible routes.
 * Call this AFTER all provider proxies are registered so we can attach hooks.
 */
export function registerCompressionMiddleware(app: FastifyInstance): void {
  if (!config.headroomEnabled) {
    app.log.info('headroom compression disabled (HEADROOM_ENABLED != true)');
    return;
  }

  app.log.info(
    { url: config.headroomUrl, timeoutMs: config.headroomTimeoutMs, skipProviders: [...config.headroomSkipProviders] },
    'headroom compression enabled',
  );

  // Add as a global onRequest hook — the middleware internally checks route compatibility
  app.addHook('preHandler', compressionMiddleware);
}
