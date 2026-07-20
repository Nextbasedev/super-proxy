/**
 * Phase 2 billing-parity gate for GLM.
 *
 * Feed the SAME captured upstream SSE fixture(s) through:
 *  - the legacy usage extraction path (absorbSseUsage-equivalent), and
 *  - the new normalized adapter (parseGlmStream / collectGlmEvents),
 * and assert IDENTICAL recorded token counts + terminal classification.
 *
 * Mandatory fixture: PR #120 message_stop complete stream (must NOT be
 * classified as incomplete / glm_stream_interrupted).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  absorbGlmSseUsageLegacy,
  classifyGlmTerminal,
  collectGlmEvents,
  lastUsageFromEvents,
} from './normalize/glm.js';
import { emptyNormalizedUsage } from './normalize/events.js';
import { surfaceOpenAiCompatStreamChunk } from './proxy/openai-compat-errors.js';

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

/** Legacy path: same field keys + last-wins as src/proxy/glm.ts absorbSseUsage. */
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
  absorbGlmSseUsageLegacy(sse, state, fallbackInput, true);
  // Terminal classification via the same openai-compat surface used live.
  surfaceOpenAiCompatStreamChunk('glm', sse, surfaceState);
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
  const events = await collectGlmEvents(sse, { fallbackInputTokens: fallbackInput });
  const usage = lastUsageFromEvents(
    events,
    emptyNormalizedUsage({ inputTokens: fallbackInput }),
  );
  const terminal = classifyGlmTerminal(events);
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

/** PR #120 mandatory: complete Anthropic-style stream with message_stop. */
const FIXTURE_MESSAGE_STOP_COMPLETE = [
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":1,"output_tokens":1}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
].join('\n');

/** Full billing fields: cache + reasoning progressive snapshots. */
const FIXTURE_BILLING_FULL = [
  'event: message_start',
  'data: {"type":"message_start","message":{"usage":{"input_tokens":13,"output_tokens":0,"cache_creation_input_tokens":2,"cache_read_input_tokens":4,"output_tokens_details":{"reasoning_tokens":7}}}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":13,"output_tokens":5,"cache_creation_input_tokens":2,"cache_read_input_tokens":4,"output_tokens_details":{"reasoning_tokens":7}}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
].join('\n');

/** Partial stream — no message_stop → incomplete (would have been fake-interrupt class if misclassified as stop). */
const FIXTURE_PARTIAL_NO_STOP = [
  'event: message_start',
  'data: {"type":"message_start","message":{"usage":{"input_tokens":7,"output_tokens":0}}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}',
  '',
].join('\n');

/** Empty stream. */
const FIXTURE_EMPTY = '';

/** Cache-read only progressive supersede (later snapshot wins, not additive). */
const FIXTURE_USAGE_SUPERSEDE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"usage":{"input_tokens":100,"output_tokens":0,"cache_read_input_tokens":40}}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":100,"output_tokens":20,"cache_read_input_tokens":40}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
].join('\n');

test('parity: PR #120 message_stop complete — identical tokens + stop terminal', async () => {
  const fallback = 50;
  const legacy = legacyExtract(FIXTURE_MESSAGE_STOP_COMPLETE, fallback);
  const adapter = await adapterExtract(FIXTURE_MESSAGE_STOP_COMPLETE, fallback);
  assertParity('message_stop_complete', legacy, adapter);
  assert.equal(legacy.terminal, 'stop');
  assert.equal(legacy.sawCompletion, true);
  assert.equal(adapter.usage.inputTokens, 1);
  assert.equal(adapter.usage.outputTokens, 1);
});

test('parity: full billing fields (cache + reasoning) identical', async () => {
  const fallback = 0;
  const legacy = legacyExtract(FIXTURE_BILLING_FULL, fallback);
  const adapter = await adapterExtract(FIXTURE_BILLING_FULL, fallback);
  assertParity('billing_full', legacy, adapter);
  assert.deepEqual(adapter.usage, {
    inputTokens: 13,
    outputTokens: 5,
    cacheCreationTokens: 2,
    cacheReadTokens: 4,
    reasoningTokens: 7,
  });
  assert.equal(adapter.terminal, 'stop');
});

test('parity: partial stream (no message_stop) → incomplete both sides, same tokens', async () => {
  const fallback = 50;
  const legacy = legacyExtract(FIXTURE_PARTIAL_NO_STOP, fallback);
  const adapter = await adapterExtract(FIXTURE_PARTIAL_NO_STOP, fallback);
  assertParity('partial_no_stop', legacy, adapter);
  assert.equal(legacy.terminal, 'incomplete');
  assert.equal(adapter.terminal, 'incomplete');
  assert.equal(adapter.code, 'glm_stream_incomplete');
  assert.equal(adapter.usage.inputTokens, 7);
  assert.equal(adapter.usage.outputTokens, 0);
});

test('parity: empty stream → incomplete, fallback input tokens', async () => {
  const fallback = 50;
  const legacy = legacyExtract(FIXTURE_EMPTY, fallback);
  const adapter = await adapterExtract(FIXTURE_EMPTY, fallback);
  assertParity('empty', legacy, adapter);
  assert.equal(adapter.terminal, 'incomplete');
  assert.equal(adapter.usage.inputTokens, 50);
  assert.equal(adapter.usage.outputTokens, 0);
});

test('parity: usage supersede is last-wins (not additive)', async () => {
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

test('parity: config.normalizeGlm defaults false (prod path unchanged)', async () => {
  // Import config as evaluated with current env (tests do not set NORMALIZE_GLM).
  const { config } = await import('./config.js');
  assert.equal(config.normalizeGlm, false, 'NORMALIZE_GLM must default false');
});
