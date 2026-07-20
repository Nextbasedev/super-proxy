/**
 * Phase 3 billing-parity gate for Kimi.
 *
 * Feed the SAME captured upstream SSE fixture(s) through:
 *  - the legacy usage extraction path (absorbSseUsage-equivalent), and
 *  - the new normalized adapter (parseKimiStream / collectKimiEvents),
 * and assert IDENTICAL recorded token counts + terminal classification.
 *
 * CRITICAL: cacheReadTokens must match (billable input = input - cacheRead;
 * cacheRead priced cheaper in cost.ts for kimi-k2.6 / kimi-k2.7-code).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  absorbKimiSseUsageLegacy,
  classifyKimiTerminal,
  collectKimiEvents,
  lastUsageFromEvents,
} from './normalize/kimi.js';
import { emptyNormalizedUsage } from './normalize/events.js';
import { surfaceOpenAiCompatStreamChunk } from './proxy/openai-compat-errors.js';
import { estimateCost } from './proxy/cost.js';

type BillingUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
};

function billingSlice(u: {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  reasoningTokens?: number;
}): BillingUsage {
  return {
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheCreationTokens: u.cacheCreationTokens,
    cacheReadTokens: u.cacheReadTokens,
    reasoningTokens: u.reasoningTokens ?? 0,
  };
}

/** Legacy path: same field keys + last-wins as src/proxy/kimi.ts absorbSseUsage. */
function legacyExtract(sse: string, fallbackInput: number): {
  usage: BillingUsage;
  terminal: 'stop' | 'incomplete';
  sawCompletion: boolean;
} {
  const state = {
    pending: '',
    usage: {
      inputTokens: fallbackInput,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: 0,
    },
  };
  const surfaceState = { sawCompletion: false, sawContent: false };
  // Feed as one chunk (and force-flush trailing) — mirrors end-of-stream absorb.
  absorbKimiSseUsageLegacy(sse, state, fallbackInput, true);
  // Terminal classification via the same openai-compat surface used live.
  surfaceOpenAiCompatStreamChunk('kimi', sse, surfaceState);
  return {
    usage: billingSlice(state.usage),
    terminal: surfaceState.sawCompletion ? 'stop' : 'incomplete',
    sawCompletion: surfaceState.sawCompletion,
  };
}

async function adapterExtract(sse: string, fallbackInput: number): Promise<{
  usage: BillingUsage;
  terminal: 'stop' | 'incomplete';
  code?: string;
}> {
  const events = await collectKimiEvents(sse, { fallbackInputTokens: fallbackInput });
  const usage = lastUsageFromEvents(
    events,
    emptyNormalizedUsage({ inputTokens: fallbackInput }),
  );
  const terminal = classifyKimiTerminal(events);
  return {
    usage: billingSlice(usage),
    terminal: terminal.kind === 'stop' ? 'stop' : 'incomplete',
    code: terminal.kind === 'incomplete' ? terminal.code : undefined,
  };
}

function assertParity(
  name: string,
  legacy: Awaited<ReturnType<typeof legacyExtract>>,
  adapter: Awaited<ReturnType<typeof adapterExtract>>,
) {
  assert.deepEqual(
    adapter.usage,
    legacy.usage,
    `${name}: billing token counts must be identical (legacy vs adapter)`,
  );
  assert.equal(
    adapter.terminal,
    legacy.terminal,
    `${name}: terminal classification must match (legacy=${legacy.terminal} adapter=${adapter.terminal})`,
  );
}

// --- Fixtures ---

/**
 * (a) Normal OpenAI-compat completion with cached_tokens > 0.
 * Uses input_tokens_details.cached_tokens (the live legacy key).
 */
const FIXTURE_CACHED_TOKENS = [
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}',
  '',
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":120,"completion_tokens":8,"total_tokens":128,"input_tokens_details":{"cached_tokens":90},"completion_tokens_details":{"reasoning_tokens":0}}}',
  '',
  'data: [DONE]',
  '',
].join('\n');

/**
 * (b) Completion with reasoning tokens (OpenAI-compat details).
 */
const FIXTURE_REASONING = [
  'data: {"choices":[{"index":0,"delta":{"content":"ans"},"finish_reason":null}]}',
  '',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":40,"completion_tokens":25,"completion_tokens_details":{"reasoning_tokens":12},"input_tokens_details":{"cached_tokens":0}}}',
  '',
  'data: [DONE]',
  '',
].join('\n');

/**
 * (c) Truncated stream (no finish / no [DONE]) → incomplete.
 */
const FIXTURE_TRUNCATED = [
  'data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}],"usage":{"prompt_tokens":15,"completion_tokens":3}}',
  '',
].join('\n');

/**
 * (d) Empty stream → fallback input tokens.
 */
const FIXTURE_EMPTY = '';

/**
 * Progressive usage supersede with cache-read (last-wins, not additive).
 */
const FIXTURE_USAGE_SUPERSEDE = [
  'data: {"choices":[{"index":0,"delta":{"content":"x"},"finish_reason":null}],"usage":{"prompt_tokens":100,"completion_tokens":0,"input_tokens_details":{"cached_tokens":40}}}',
  '',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":20,"input_tokens_details":{"cached_tokens":40}}}',
  '',
  'data: [DONE]',
  '',
].join('\n');

/**
 * Anthropic-style dual path on Kimi /messages (message_stop).
 */
const FIXTURE_MESSAGES_MESSAGE_STOP = [
  'event: message_start',
  'data: {"type":"message_start","message":{"usage":{"input_tokens":13,"output_tokens":0,"cache_read_input_tokens":4}}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":13,"output_tokens":5,"cache_read_input_tokens":4}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
].join('\n');

test('parity: (a) normal completion with cached_tokens > 0 — identical tokens + stop', async () => {
  const fallback = 50;
  const legacy = legacyExtract(FIXTURE_CACHED_TOKENS, fallback);
  const adapter = await adapterExtract(FIXTURE_CACHED_TOKENS, fallback);
  assertParity('cached_tokens', legacy, adapter);
  assert.equal(legacy.terminal, 'stop');
  assert.equal(legacy.sawCompletion, true);
  assert.equal(adapter.terminal, 'stop');
  assert.deepEqual(adapter.usage, {
    inputTokens: 120,
    outputTokens: 8,
    cacheCreationTokens: 0,
    cacheReadTokens: 90,
    reasoningTokens: 0,
  });
  // Prove cost.ts billable-input math depends on cacheReadTokens.
  const cost = estimateCost('kimi-k2.6', adapter.usage, 'kimi');
  const costNoCache = estimateCost(
    'kimi-k2.6',
    { ...adapter.usage, cacheReadTokens: 0 },
    'kimi',
  );
  assert.ok(cost < costNoCache, 'cacheRead must reduce notional cost vs treating all as input');
});

test('parity: (b) completion with reasoning tokens identical', async () => {
  const fallback = 0;
  const legacy = legacyExtract(FIXTURE_REASONING, fallback);
  const adapter = await adapterExtract(FIXTURE_REASONING, fallback);
  assertParity('reasoning', legacy, adapter);
  assert.deepEqual(adapter.usage, {
    inputTokens: 40,
    outputTokens: 25,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 12,
  });
  assert.equal(adapter.terminal, 'stop');
});

test('parity: (c) truncated stream (no finish) → incomplete both sides, same tokens', async () => {
  const fallback = 50;
  const legacy = legacyExtract(FIXTURE_TRUNCATED, fallback);
  const adapter = await adapterExtract(FIXTURE_TRUNCATED, fallback);
  assertParity('truncated', legacy, adapter);
  assert.equal(legacy.terminal, 'incomplete');
  assert.equal(adapter.terminal, 'incomplete');
  assert.equal(adapter.code, 'kimi_stream_incomplete');
  assert.equal(adapter.usage.inputTokens, 15);
  assert.equal(adapter.usage.outputTokens, 3);
});

test('parity: (d) empty stream → incomplete, fallback input tokens', async () => {
  const fallback = 50;
  const legacy = legacyExtract(FIXTURE_EMPTY, fallback);
  const adapter = await adapterExtract(FIXTURE_EMPTY, fallback);
  assertParity('empty', legacy, adapter);
  assert.equal(adapter.terminal, 'incomplete');
  assert.equal(adapter.usage.inputTokens, 50);
  assert.equal(adapter.usage.outputTokens, 0);
  assert.equal(adapter.usage.cacheReadTokens, 0);
});

test('parity: usage supersede is last-wins (not additive) incl cacheRead', async () => {
  const fallback = 0;
  const legacy = legacyExtract(FIXTURE_USAGE_SUPERSEDE, fallback);
  const adapter = await adapterExtract(FIXTURE_USAGE_SUPERSEDE, fallback);
  assertParity('usage_supersede', legacy, adapter);
  // Must be 100/20/40 — NOT 200/20/80 from additive merge.
  assert.deepEqual(adapter.usage, {
    inputTokens: 100,
    outputTokens: 20,
    cacheCreationTokens: 0,
    cacheReadTokens: 40,
    reasoningTokens: 0,
  });
  assert.equal(adapter.terminal, 'stop');
});

test('parity: Anthropic-style message_stop on /messages dual path', async () => {
  const fallback = 0;
  const legacy = legacyExtract(FIXTURE_MESSAGES_MESSAGE_STOP, fallback);
  const adapter = await adapterExtract(FIXTURE_MESSAGES_MESSAGE_STOP, fallback);
  assertParity('messages_message_stop', legacy, adapter);
  assert.deepEqual(adapter.usage, {
    inputTokens: 13,
    outputTokens: 5,
    cacheCreationTokens: 0,
    cacheReadTokens: 4,
    reasoningTokens: 0,
  });
  assert.equal(adapter.terminal, 'stop');
});

test('parity: config.normalizeKimi defaults false (prod path unchanged)', async () => {
  // Import config as evaluated with current env (tests do not set NORMALIZE_KIMI).
  const { config } = await import('./config.js');
  assert.equal(config.normalizeKimi, false, 'NORMALIZE_KIMI must default false');
});
