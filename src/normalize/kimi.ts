/**
 * Phase 3: Kimi (OpenAI-compatible SSE) → NormalizedEvent adapter.
 *
 * Wired into the live proxy behind `config.normalizeKimi` (NORMALIZE_KIMI, default off).
 * When enabled, `src/proxy/kimi.ts` consumes this adapter for usage + terminal
 * classification while still passthrough-writing upstream SSE to the client.
 *
 * Structural guarantees vs the hand-rolled absorbSseUsage + sawCompletion path:
 * - OpenAI-style `[DONE]`, Anthropic-style `message_stop`, and Responses API
 *   completion events become `{ type: 'stop', final: true }`.
 * - Incomplete / aborted streams emit `{ type: 'error', code: 'kimi_stream_incomplete' }`
 *   and never invent a final `stop`.
 * - Usage fields match what `recordUsage` / `estimateCost` need for Kimi billing,
 *   especially `cacheReadTokens` from OpenAI-compat
 *   `input_tokens_details.cached_tokens` / `prompt_tokens_details.cached_tokens`
 *   (billable input = input - cacheRead; cacheRead priced cheaper).
 * - Progressive usage snapshots are merged with `mergeUsage` (last-wins supersede).
 */
import {
  emptyNormalizedUsage,
  mergeUsage,
  type NormalizedEvent,
  type NormalizedStreamAdapter,
  type NormalizedUsage,
} from './events.js';

export interface ParseKimiStreamOptions {
  /** Fallback input tokens when the stream never reports usage. */
  fallbackInputTokens?: number;
  /**
   * Request start time (ms epoch). Used to populate `usage.ttftMs` on the
   * first contentful event. Defaults to Date.now() at parse start.
   */
  startedAtMs?: number;
  /**
   * When true (default), emit a final `error` if the stream ends without
   * a genuine completion (`[DONE]` / `message_stop` / response.completed).
   */
  errorOnIncomplete?: boolean;
}

export type KimiStreamSource =
  | string
  | AsyncIterable<string | Uint8Array>
  | ReadableStream<Uint8Array>
  | Iterable<string | Uint8Array>;

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return !!value && typeof (value as ReadableStream<Uint8Array>).getReader === 'function';
}

async function* chunksFromSource(source: KimiStreamSource): AsyncGenerator<string> {
  if (typeof source === 'string') {
    if (source) yield source;
    return;
  }
  if (isReadableStream(source)) {
    const reader = source.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) yield decoder.decode(value, { stream: true });
      }
      const tail = decoder.decode();
      if (tail) yield tail;
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* already released */
      }
    }
    return;
  }
  // AsyncIterable or Iterable of string | Uint8Array
  const decoder = new TextDecoder();
  for await (const chunk of source as AsyncIterable<string | Uint8Array>) {
    if (typeof chunk === 'string') {
      if (chunk) yield chunk;
    } else if (chunk && (chunk as Uint8Array).byteLength) {
      yield decoder.decode(chunk as Uint8Array, { stream: true });
    }
  }
  const tail = decoder.decode();
  if (tail) yield tail;
}

/**
 * Extract cache-read tokens from Kimi / OpenAI-compat usage shapes.
 * Live proxy historically only checked `cache_read_input_tokens` and
 * `input_tokens_details.cached_tokens`; we also accept
 * `prompt_tokens_details.cached_tokens` (OpenAI Chat Completions shape)
 * so billing does not drop cache hits when Kimi emits that form.
 */
function cachedTokensFromUsage(u: any): number | undefined {
  if (!u || typeof u !== 'object') return undefined;
  if (u.cache_read_input_tokens != null) return u.cache_read_input_tokens;
  if (u.input_tokens_details?.cached_tokens != null) return u.input_tokens_details.cached_tokens;
  if (u.prompt_tokens_details?.cached_tokens != null) return u.prompt_tokens_details.cached_tokens;
  // Kimi/Moonshot chat completions place cache reads at the TOP LEVEL of
  // `usage` (usage.cached_tokens). Without this the adapter silently dropped
  // cache hits, undercounting cacheRead billing once caching engaged.
  if (u.cached_tokens != null) return u.cached_tokens;
  return undefined;
}

/**
 * Map a provider-native usage object onto NormalizedUsage using last-wins
 * supersede against `prev` (via mergeUsage). Mirrors live `absorbSseUsage`
 * field keys so billing parity holds, plus prompt_tokens_details.cached_tokens.
 */
export function usageFromProviderObject(
  u: any,
  prev: NormalizedUsage,
  fallbackInput: number,
): NormalizedUsage {
  if (!u || typeof u !== 'object') return prev;
  const cacheRead = cachedTokensFromUsage(u);
  return mergeUsage(prev, {
    inputTokens: u.input_tokens ?? u.prompt_tokens ?? prev.inputTokens ?? fallbackInput,
    outputTokens: u.output_tokens ?? u.completion_tokens ?? prev.outputTokens ?? 0,
    cacheCreationTokens: u.cache_creation_input_tokens ?? prev.cacheCreationTokens ?? 0,
    cacheReadTokens: cacheRead ?? prev.cacheReadTokens ?? 0,
    reasoningTokens:
      u.output_tokens_details?.reasoning_tokens
      ?? u.completion_tokens_details?.reasoning_tokens
      ?? u.reasoning_tokens
      ?? prev.reasoningTokens
      ?? 0,
  });
}

function usageFromParsed(
  parsed: any,
  prev: NormalizedUsage,
  fallbackInput: number,
): NormalizedUsage | null {
  const u =
    parsed?.usage
    || parsed?.response?.usage
    || parsed?.message?.usage
    || (parsed?.type === 'message_start' ? parsed?.message?.usage : null);
  if (!u) return null;
  return usageFromProviderObject(u, prev, fallbackInput);
}

/**
 * Pure SSE usage absorber matching the live proxy's `absorbSseUsage` semantics.
 * Exported so billing-parity tests can feed the same fixture through the old
 * extraction path without importing private proxy helpers.
 *
 * NOTE: legacy path only reads `input_tokens_details.cached_tokens` (not
 * `prompt_tokens_details`). Parity tests that assert identical counts with
 * legacy must use the legacy-recognized cache key; adapter-only fixtures may
 * exercise `prompt_tokens_details.cached_tokens`.
 */
export function absorbKimiSseUsageLegacy(
  chunk: string,
  state: {
    pending: string;
    usage: {
      inputTokens: number;
      outputTokens: number;
      cacheCreationTokens: number;
      cacheReadTokens: number;
      reasoningTokens: number;
    };
  },
  fallbackInput: number,
  force = false,
): void {
  state.pending += chunk;
  let sepIdx: number;
  while ((sepIdx = state.pending.indexOf('\n\n')) !== -1) {
    const event = state.pending.slice(0, sepIdx);
    state.pending = state.pending.slice(sepIdx + 2);
    const payload = event
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('\n');
    if (!payload || payload === '[DONE]') continue;
    try {
      const parsed = JSON.parse(payload);
      const u =
        parsed?.usage
        || parsed?.response?.usage
        || parsed?.message?.usage
        || (parsed?.type === 'message_start' ? parsed?.message?.usage : null);
      if (u) {
        state.usage = {
          inputTokens: u.input_tokens ?? u.prompt_tokens ?? state.usage.inputTokens ?? fallbackInput,
          outputTokens: u.output_tokens ?? u.completion_tokens ?? state.usage.outputTokens ?? 0,
          cacheCreationTokens: u.cache_creation_input_tokens ?? state.usage.cacheCreationTokens ?? 0,
          // Byte-match live proxy/kimi.ts absorbSseUsage, including the added
          // Kimi top-level `cached_tokens` and prompt_tokens_details fallbacks.
          cacheReadTokens:
            u.cache_read_input_tokens
            ?? u.input_tokens_details?.cached_tokens
            ?? u.prompt_tokens_details?.cached_tokens
            ?? u.cached_tokens
            ?? state.usage.cacheReadTokens
            ?? 0,
          reasoningTokens:
            u.output_tokens_details?.reasoning_tokens
            ?? u.completion_tokens_details?.reasoning_tokens
            ?? state.usage.reasoningTokens
            ?? 0,
        };
      }
    } catch {
      /* ignore malformed SSE frames, same as live path */
    }
  }
  if (force && state.pending.trim()) {
    const rest = state.pending;
    state.pending = '';
    absorbKimiSseUsageLegacy(rest + '\n\n', state, fallbackInput, false);
  }
}

/**
 * Terminal classification for a finished Kimi stream, matching the live
 * openai-compat surface rule: [DONE] / message_stop / response.completed = clean
 * stop; otherwise incomplete.
 */
export type KimiTerminalClass =
  | { kind: 'stop'; reason?: string }
  | { kind: 'incomplete'; code: 'kimi_stream_incomplete' };

export function classifyKimiTerminal(events: NormalizedEvent[]): KimiTerminalClass {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === 'stop' && ev.final) {
      return { kind: 'stop', reason: ev.reason };
    }
    if (ev.type === 'error' && ev.code === 'kimi_stream_incomplete') {
      return { kind: 'incomplete', code: 'kimi_stream_incomplete' };
    }
  }
  // No terminal event at all → incomplete
  return { kind: 'incomplete', code: 'kimi_stream_incomplete' };
}

export function lastUsageFromEvents(
  events: NormalizedEvent[],
  fallback: NormalizedUsage,
): NormalizedUsage {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === 'usage') return ev.usage;
  }
  return fallback;
}

/**
 * Parse Kimi OpenAI-compatible SSE body into normalized events.
 *
 * Accepts a full SSE string, chunk iterable, or ReadableStream so tests and
 * the live proxy can feed fixtures / upstream bodies without Fastify.
 *
 * Also handles Anthropic-style frames on `/messages` (Kimi dual endpoint).
 */
export async function* parseKimiStream(
  providerSSE: KimiStreamSource,
  options: ParseKimiStreamOptions = {},
): AsyncGenerator<NormalizedEvent> {
  const fallbackInput = options.fallbackInputTokens ?? 0;
  const startedAtMs = options.startedAtMs ?? Date.now();
  const errorOnIncomplete = options.errorOnIncomplete !== false;

  let pending = '';
  let usage = emptyNormalizedUsage({ inputTokens: fallbackInput });
  let lastEmittedUsageJson = '';
  let sawStop = false;
  let stopReason: string | undefined;
  let firstContentAt: number | undefined;

  const withTtft = (u: NormalizedUsage): NormalizedUsage => {
    if (u.ttftMs != null || firstContentAt == null) return u;
    return { ...u, ttftMs: Math.max(0, firstContentAt - startedAtMs) };
  };

  function* emitUsageIfChanged(): Generator<NormalizedEvent> {
    const snapshot = withTtft(usage);
    const json = JSON.stringify(snapshot);
    if (json === lastEmittedUsageJson) return;
    lastEmittedUsageJson = json;
    yield { type: 'usage', usage: snapshot };
  }

  function* handlePayload(payload: string): Generator<NormalizedEvent> {
    if (sawStop) return;

    if (payload === '[DONE]') {
      // OpenAI-style termination (primary for Kimi chat/completions).
      yield* emitUsageIfChanged();
      yield { type: 'stop', reason: stopReason || 'done', final: true };
      sawStop = true;
      return;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(payload);
    } catch {
      yield {
        type: 'error',
        message: `Invalid Kimi SSE JSON: ${payload.slice(0, 200)}`,
        code: 'kimi_sse_parse_error',
        fatal: false,
      };
      return;
    }

    const nextUsage = usageFromParsed(parsed, usage, fallbackInput);
    if (nextUsage) usage = nextUsage;

    const t = parsed?.type;

    // Responses API style completion events (also treated as completion by
    // surfaceOpenAiCompatStreamChunk for openai-compat providers).
    if (t === 'response.completed' || t === 'response.done' || t === 'done') {
      yield* emitUsageIfChanged();
      yield { type: 'stop', reason: stopReason || t, final: true };
      sawStop = true;
      return;
    }

    if (t === 'message_start') {
      if (nextUsage) yield* emitUsageIfChanged();
      return;
    }

    if (t === 'content_block_start') {
      const block = parsed?.content_block;
      const index = typeof parsed?.index === 'number' ? parsed.index : undefined;
      if (block?.type === 'tool_use' || block?.type === 'tool_use_block') {
        if (firstContentAt == null) firstContentAt = Date.now();
        yield {
          type: 'tool_call',
          id: typeof block.id === 'string' ? block.id : undefined,
          name: typeof block.name === 'string' ? block.name : undefined,
          arguments:
            typeof block.input === 'string'
              ? block.input
              : block.input != null
                ? JSON.stringify(block.input)
                : '',
          index,
        };
      }
      return;
    }

    if (t === 'content_block_delta') {
      const delta = parsed?.delta || {};
      const index = typeof parsed?.index === 'number' ? parsed.index : undefined;
      const deltaType = delta?.type;

      if (
        (deltaType === 'text_delta' || typeof delta.text === 'string')
        && typeof delta.text === 'string'
        && delta.text.length > 0
        && deltaType !== 'thinking_delta'
        && deltaType !== 'input_json_delta'
      ) {
        if (firstContentAt == null) firstContentAt = Date.now();
        yield { type: 'text', text: delta.text, index };
        return;
      }

      if (deltaType === 'thinking_delta' || typeof delta.thinking === 'string') {
        const thinking = typeof delta.thinking === 'string' ? delta.thinking : '';
        if (thinking.length > 0) {
          if (firstContentAt == null) firstContentAt = Date.now();
          yield { type: 'thinking', text: thinking, index };
        }
        return;
      }

      if (deltaType === 'input_json_delta' || typeof delta.partial_json === 'string') {
        const fragment = typeof delta.partial_json === 'string' ? delta.partial_json : '';
        if (fragment.length > 0) {
          if (firstContentAt == null) firstContentAt = Date.now();
          yield { type: 'tool_call', arguments: fragment, index };
        }
        return;
      }
      return;
    }

    if (t === 'message_delta') {
      if (typeof parsed?.delta?.stop_reason === 'string') {
        stopReason = parsed.delta.stop_reason;
      }
      if (nextUsage) yield* emitUsageIfChanged();
      return;
    }

    // Anthropic-compat /messages path (Kimi dual endpoint).
    if (t === 'message_stop') {
      yield* emitUsageIfChanged();
      yield { type: 'stop', reason: stopReason || 'message_stop', final: true };
      sawStop = true;
      return;
    }

    // OpenAI Chat Completions streaming chunks: choices[].delta / finish_reason.
    const choices = Array.isArray(parsed?.choices) ? parsed.choices : [];
    if (choices.length > 0) {
      for (const choice of choices) {
        const index = typeof choice?.index === 'number' ? choice.index : undefined;
        const delta = choice?.delta || {};

        const content = delta?.content;
        if (typeof content === 'string' && content.length > 0) {
          if (firstContentAt == null) firstContentAt = Date.now();
          yield { type: 'text', text: content, index };
        } else if (Array.isArray(content)) {
          for (const part of content) {
            if (part && typeof part === 'object' && typeof part.text === 'string' && part.text) {
              if (firstContentAt == null) firstContentAt = Date.now();
              yield { type: 'text', text: part.text, index };
            }
          }
        }

        // Reasoning / thinking fragments (model-dependent).
        const reasoning =
          typeof delta?.reasoning_content === 'string'
            ? delta.reasoning_content
            : typeof delta?.reasoning === 'string'
              ? delta.reasoning
              : '';
        if (reasoning.length > 0) {
          if (firstContentAt == null) firstContentAt = Date.now();
          yield { type: 'thinking', text: reasoning, index };
        }

        const toolCalls = Array.isArray(delta?.tool_calls) ? delta.tool_calls : [];
        for (const tc of toolCalls) {
          if (firstContentAt == null) firstContentAt = Date.now();
          const fn = tc?.function || {};
          yield {
            type: 'tool_call',
            id: typeof tc?.id === 'string' ? tc.id : undefined,
            name: typeof fn?.name === 'string' ? fn.name : undefined,
            arguments: typeof fn?.arguments === 'string' ? fn.arguments : '',
            index: typeof tc?.index === 'number' ? tc.index : index,
          };
        }

        if (typeof choice?.finish_reason === 'string' && choice.finish_reason) {
          stopReason = choice.finish_reason;
        }
      }
      // Usage may arrive on the same final chunk as finish_reason.
      if (nextUsage) yield* emitUsageIfChanged();
      // Note: OpenAI streams typically still end with [DONE] after the final
      // choice chunk. We do NOT treat finish_reason alone as terminal stop —
      // that matches surfaceOpenAiCompatStreamChunk (only [DONE]/message_stop/
      // response.completed set sawCompletion). Incomplete streams missing [DONE]
      // remain incomplete.
      return;
    }

    // error event from stream
    if (t === 'error' || parsed?.error) {
      const err = parsed?.error || parsed;
      yield {
        type: 'error',
        message: String(err?.message || err?.type || 'Kimi stream error'),
        code: String(err?.type || err?.code || 'kimi_error'),
        fatal: true,
      };
      sawStop = true; // treat as terminal so we don't double-emit incomplete
      return;
    }

    // Unknown event types ignored (forward-compat), but usage already applied.
    if (nextUsage) yield* emitUsageIfChanged();
  }

  for await (const chunk of chunksFromSource(providerSSE)) {
    pending += chunk;
    let sepIdx: number;
    while ((sepIdx = pending.indexOf('\n\n')) !== -1) {
      const rawEvent = pending.slice(0, sepIdx);
      pending = pending.slice(sepIdx + 2);
      const payload = rawEvent
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
        .trim();
      if (!payload) continue;
      yield* handlePayload(payload);
    }
  }

  // Flush a trailing event that lacked the final blank line.
  if (pending.trim()) {
    const payload = pending
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim();
    if (payload) yield* handlePayload(payload);
  }

  if (!sawStop) {
    // Partial / aborted / empty stream: emit last known usage then optional error.
    // Crucially we do NOT emit `stop` — incomplete is not completion.
    yield* emitUsageIfChanged();
    if (errorOnIncomplete) {
      yield {
        type: 'error',
        message: 'Kimi stream ended without completion',
        code: 'kimi_stream_incomplete',
        fatal: true,
      };
    }
  }
}

/** NormalizedStreamAdapter wrapper (options closed over via factory). */
export function createKimiStreamAdapter(
  options: ParseKimiStreamOptions = {},
): NormalizedStreamAdapter<KimiStreamSource> {
  return (source) => parseKimiStream(source, options);
}

/** Default adapter instance (no fallback tokens; tests/proxy pass options). */
export const kimiStreamAdapter: NormalizedStreamAdapter<KimiStreamSource> = (source) =>
  parseKimiStream(source);

/** Collect an entire normalized stream into an array (test helper). */
export async function collectKimiEvents(
  providerSSE: KimiStreamSource,
  options?: ParseKimiStreamOptions,
): Promise<NormalizedEvent[]> {
  const out: NormalizedEvent[] = [];
  for await (const ev of parseKimiStream(providerSSE, options)) out.push(ev);
  return out;
}
