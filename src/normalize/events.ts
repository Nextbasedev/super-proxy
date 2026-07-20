/**
 * Finalized internal normalized stream event contract (Phase 1 / Direction B).
 *
 * Every future provider adapter emits this small event vocabulary so
 * completion, usage, and content parsing stop being reimplemented (and
 * re-bugged) per proxy. This module is types + pure helpers only — no
 * provider wiring and no imports from `src/proxy/*`.
 *
 * ## Billing-field coverage vs `recordUsage` / `estimateCost`
 *
 * | NormalizedUsage field   | usage.ts (`recordUsage`) | cost.ts (`estimateCost` / rates) | Notes |
 * |-------------------------|--------------------------|----------------------------------|-------|
 * | `inputTokens`           | `inputTokens`            | `usage.inputTokens`              | Billed (provider-dependent) |
 * | `outputTokens`          | `outputTokens`           | `usage.outputTokens`             | Billed (provider-dependent) |
 * | `cacheCreationTokens`   | `cacheCreationTokens`    | `usage.cacheCreationTokens` × `cacheWrite` | Anthropic-style cache write |
 * | `cacheReadTokens`       | `cacheReadTokens`        | `usage.cacheReadTokens` × `cacheRead` | Anthropic/Kimi cache hit |
 * | `reasoningTokens`       | stored (`reasoning_tokens`, since #128) | not priced separately today (billed inside output) | Monitoring / future billing; adapters must not drop it |
 * | `ttftMs`                | stored (`ttft_ms`, since #128) | not used by estimateCost | Monitoring instrumentation (TTFT); optional |
 *
 * Non-token fields on `recordUsage` (latencyMs, compression*, labels, cost,
 * status) are request/meta concerns, not stream-parse output — intentionally
 * outside this contract. Adapters map provider wire names → these fields;
 * billing consumers keep calling `recordUsage` / `estimateCost` unchanged.
 *
 * ## Terminal rules
 * - `stop` with `final: true` ends a successful stream.
 * - `error` with `fatal: true` (or any fatal error code consumers treat as
 *   terminal) ends a failed stream.
 * - Adapters must NOT invent a stream-interrupted error after a clean `stop`
 *   (the GLM `message_stop` / fake `glm_stream_interrupted` class).
 */

/** Token + timing counters shared by billing and monitoring. */
export interface NormalizedUsage {
  /** Prompt / input tokens (provider-native, post any cache accounting). */
  inputTokens: number;
  /** Completion / output tokens. */
  outputTokens: number;
  /** Tokens written into a prompt cache (Anthropic-style cache_creation). */
  cacheCreationTokens: number;
  /** Tokens served from a prompt cache (Anthropic-style cache_read). */
  cacheReadTokens: number;
  /** Reasoning / thinking tokens when the provider reports them separately. */
  reasoningTokens: number;
  /**
   * Time-to-first-token in milliseconds, measured from request start to the
   * first meaningful stream event (usually first text/thinking/tool delta).
   * Optional because non-stream responses or empty streams may not have it.
   */
  ttftMs?: number;
}

/** Incremental assistant text. */
export interface NormalizedTextEvent {
  type: 'text';
  text: string;
  /** Content-block index when the provider uses one (Anthropic/GLM). */
  index?: number;
}

/** Incremental model thinking / reasoning text. */
export interface NormalizedThinkingEvent {
  type: 'thinking';
  text: string;
  index?: number;
}

/**
 * Tool / function call fragment. Partial args may arrive across multiple
 * events; consumers should concatenate `arguments` by `id`/`name`/`index`.
 */
export interface NormalizedToolCallEvent {
  type: 'tool_call';
  id?: string;
  name?: string;
  /** JSON-string fragment of tool arguments (may be partial). */
  arguments?: string;
  index?: number;
}

/** Final or intermediate usage snapshot. Later snapshots supersede earlier ones. */
export interface NormalizedUsageEvent {
  type: 'usage';
  usage: NormalizedUsage;
}

/**
 * Terminal success event. Presence of `stop` means the provider signaled a
 * clean completion — adapters must NOT invent a stream-interrupted error
 * after this.
 */
export interface NormalizedStopEvent {
  type: 'stop';
  /** Provider stop reason when known (end_turn, tool_use, max_tokens, …). */
  reason?: string;
  /** True when this stop is the definitive end of the stream. */
  final: boolean;
}

/**
 * Terminal or recoverable parse/upstream error surfaced as a stream event.
 * Prefer stable `code` values (e.g. `glm_stream_incomplete`) so consumers can
 * branch without parsing free-text `message`.
 */
export interface NormalizedErrorEvent {
  type: 'error';
  message: string;
  /** Stable machine-readable error code (e.g. `glm_stream_incomplete`). */
  code: string;
  /** When true, the stream is finished and no further events follow. */
  fatal?: boolean;
}

/**
 * Discriminated union of every event a provider stream adapter may emit.
 * Order is not strictly fixed except:
 * - `stop` with `final: true` ends a successful stream
 * - a fatal `error` ends a failed stream
 * - `usage` may appear mid-stream and/or immediately before `stop`
 */
export type NormalizedEvent =
  | NormalizedTextEvent
  | NormalizedThinkingEvent
  | NormalizedToolCallEvent
  | NormalizedUsageEvent
  | NormalizedStopEvent
  | NormalizedErrorEvent;

/**
 * Provider-agnostic stream adapter: turn a provider-native source into the
 * normalized event vocabulary. Concrete adapters (Phase 2+) specialize
 * `TSource` (SSE string, ReadableStream, chunk iterable, etc.).
 */
export type NormalizedStreamAdapter<TSource = unknown> = (
  source: TSource,
) => AsyncIterable<NormalizedEvent>;

/** Empty usage baseline used by parsers before any provider usage arrives. */
export function emptyNormalizedUsage(partial: Partial<NormalizedUsage> = {}): NormalizedUsage {
  return {
    inputTokens: partial.inputTokens ?? 0,
    outputTokens: partial.outputTokens ?? 0,
    cacheCreationTokens: partial.cacheCreationTokens ?? 0,
    cacheReadTokens: partial.cacheReadTokens ?? 0,
    reasoningTokens: partial.reasoningTokens ?? 0,
    ...(partial.ttftMs != null ? { ttftMs: partial.ttftMs } : {}),
  };
}

/**
 * Merge two usage snapshots. Numeric token fields take the later non-nullish
 * value when provided (later snapshot wins per field if defined); `ttftMs`
 * keeps the earliest known measurement (first content is authoritative).
 *
 * Intended for adapters that receive progressive usage updates (message_start
 * then message_delta) and for consumers folding a stream into one final
 * usage snapshot. NOTE: this is last-wins supersede per field, NOT additive
 * summation — providers emit cumulative running totals, so later snapshots
 * replace (not add to) earlier ones. Do not use this to sum per-chunk deltas.
 */
export function mergeUsage(base: NormalizedUsage, next: Partial<NormalizedUsage>): NormalizedUsage {
  const merged: NormalizedUsage = {
    inputTokens: next.inputTokens ?? base.inputTokens,
    outputTokens: next.outputTokens ?? base.outputTokens,
    cacheCreationTokens: next.cacheCreationTokens ?? base.cacheCreationTokens,
    cacheReadTokens: next.cacheReadTokens ?? base.cacheReadTokens,
    reasoningTokens: next.reasoningTokens ?? base.reasoningTokens,
  };
  const ttft =
    base.ttftMs != null && next.ttftMs != null
      ? Math.min(base.ttftMs, next.ttftMs)
      : (base.ttftMs ?? next.ttftMs);
  if (ttft != null) merged.ttftMs = ttft;
  return merged;
}

/**
 * True when the event ends the stream successfully (`stop` + `final`) or
 * unsuccessfully (fatal `error`). Non-final stops and non-fatal errors are
 * not terminal.
 */
export function isTerminal(event: NormalizedEvent): boolean {
  if (event.type === 'stop') return event.final === true;
  if (event.type === 'error') return event.fatal === true;
  return false;
}

/**
 * Exhaustive switch helper: TypeScript errors if a new union member is added
 * without updating the caller. Used by tests and as a pattern for consumers.
 */
export function assertNever(value: never, message = 'Unhandled NormalizedEvent type'): never {
  throw new Error(`${message}: ${JSON.stringify(value)}`);
}
