/**
 * Phase 2: GLM (Anthropic-compatible SSE) → NormalizedEvent adapter.
 *
 * Wired into the live proxy behind `config.normalizeGlm` (NORMALIZE_GLM, default off).
 * When enabled, `src/proxy/glm.ts` consumes this adapter for usage + terminal
 * classification while still passthrough-writing upstream SSE to the client.
 *
 * Structural guarantees vs the hand-rolled absorbSseUsage + sawCompletion path:
 * - `message_stop` (and OpenAI-style `[DONE]`) always become `{ type: 'stop', final: true }`.
 * - Incomplete / aborted streams emit `{ type: 'error', code: 'glm_stream_incomplete' }`
 *   and never invent a final `stop` (PR #120 class).
 * - Usage fields match what `recordUsage` / `estimateCost` need for GLM billing.
 * - Progressive usage snapshots are merged with `mergeUsage` (last-wins supersede).
 */
import {
  emptyNormalizedUsage,
  mergeUsage,
  type NormalizedEvent,
  type NormalizedStreamAdapter,
  type NormalizedUsage,
} from './events.js';

export interface ParseGlmStreamOptions {
  /** Fallback input tokens when the stream never reports usage. */
  fallbackInputTokens?: number;
  /**
   * Request start time (ms epoch). Used to populate `usage.ttftMs` on the
   * first contentful event. Defaults to Date.now() at parse start.
   */
  startedAtMs?: number;
  /**
   * When true (default), emit a final `error` if the stream ends without
   * `message_stop` / `[DONE]`. Partial streams surface incomplete, not
   * fake completion.
   */
  errorOnIncomplete?: boolean;
}

export type GlmStreamSource =
  | string
  | AsyncIterable<string | Uint8Array>
  | ReadableStream<Uint8Array>
  | Iterable<string | Uint8Array>;

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return !!value && typeof (value as ReadableStream<Uint8Array>).getReader === 'function';
}

async function* chunksFromSource(source: GlmStreamSource): AsyncGenerator<string> {
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
 * Map a provider-native usage object onto NormalizedUsage using last-wins
 * supersede against `prev` (via mergeUsage). Mirrors live `absorbSseUsage`
 * field keys so billing parity holds.
 */
export function usageFromProviderObject(
  u: any,
  prev: NormalizedUsage,
  fallbackInput: number,
): NormalizedUsage {
  if (!u || typeof u !== 'object') return prev;
  return mergeUsage(prev, {
    inputTokens: u.input_tokens ?? u.prompt_tokens ?? prev.inputTokens ?? fallbackInput,
    outputTokens: u.output_tokens ?? u.completion_tokens ?? prev.outputTokens ?? 0,
    cacheCreationTokens: u.cache_creation_input_tokens ?? prev.cacheCreationTokens ?? 0,
    cacheReadTokens:
      u.cache_read_input_tokens ?? u.input_tokens_details?.cached_tokens ?? prev.cacheReadTokens ?? 0,
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
 */
export function absorbGlmSseUsageLegacy(
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
          cacheReadTokens:
            u.cache_read_input_tokens
            ?? u.input_tokens_details?.cached_tokens
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
    absorbGlmSseUsageLegacy(rest + '\n\n', state, fallbackInput, false);
  }
}

/**
 * Terminal classification for a finished GLM stream, matching the live
 * PR #120 rule: message_stop / [DONE] = clean stop; otherwise incomplete.
 */
export type GlmTerminalClass =
  | { kind: 'stop'; reason?: string }
  | { kind: 'incomplete'; code: 'glm_stream_incomplete' };

export function classifyGlmTerminal(events: NormalizedEvent[]): GlmTerminalClass {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === 'stop' && ev.final) {
      return { kind: 'stop', reason: ev.reason };
    }
    if (ev.type === 'error' && ev.code === 'glm_stream_incomplete') {
      return { kind: 'incomplete', code: 'glm_stream_incomplete' };
    }
  }
  // No terminal event at all → incomplete
  return { kind: 'incomplete', code: 'glm_stream_incomplete' };
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
 * Parse GLM Anthropic-style SSE body into normalized events.
 *
 * Accepts a full SSE string, chunk iterable, or ReadableStream so tests and
 * the live proxy can feed fixtures / upstream bodies without Fastify.
 */
export async function* parseGlmStream(
  providerSSE: GlmStreamSource,
  options: ParseGlmStreamOptions = {},
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
      // OpenAI-style dual-compat termination
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
        message: `Invalid GLM SSE JSON: ${payload.slice(0, 200)}`,
        code: 'glm_sse_parse_error',
        fatal: false,
      };
      return;
    }

    const nextUsage = usageFromParsed(parsed, usage, fallbackInput);
    if (nextUsage) usage = nextUsage;

    const t = parsed?.type;

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

      // Text: Anthropic text_delta or bare delta.text (seen in GLM fixtures).
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

    // THE PR #120 fix: message_stop is a genuine clean completion → stop.
    // Never treat it as stream-interrupted. Incomplete streams are handled
    // only when the iterator ends without message_stop / [DONE].
    if (t === 'message_stop') {
      yield* emitUsageIfChanged();
      yield { type: 'stop', reason: stopReason || 'message_stop', final: true };
      sawStop = true;
      return;
    }

    // error event from Anthropic-compatible streams
    if (t === 'error' || parsed?.error) {
      const err = parsed?.error || parsed;
      yield {
        type: 'error',
        message: String(err?.message || err?.type || 'GLM stream error'),
        code: String(err?.type || err?.code || 'glm_error'),
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
        message: 'GLM stream ended without message_stop',
        code: 'glm_stream_incomplete',
        fatal: true,
      };
    }
  }
}

/** NormalizedStreamAdapter wrapper (options closed over via factory). */
export function createGlmStreamAdapter(
  options: ParseGlmStreamOptions = {},
): NormalizedStreamAdapter<GlmStreamSource> {
  return (source) => parseGlmStream(source, options);
}

/** Default adapter instance (no fallback tokens; tests/proxy pass options). */
export const glmStreamAdapter: NormalizedStreamAdapter<GlmStreamSource> = (source) =>
  parseGlmStream(source);

/** Collect an entire normalized stream into an array (test helper). */
export async function collectGlmEvents(
  providerSSE: GlmStreamSource,
  options?: ParseGlmStreamOptions,
): Promise<NormalizedEvent[]> {
  const out: NormalizedEvent[] = [];
  for await (const ev of parseGlmStream(providerSSE, options)) out.push(ev);
  return out;
}
