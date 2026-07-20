/**
 * Phase 1: unit tests for the finalized NormalizedEvent contract.
 * No provider adapters — types + pure helpers only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertNever,
  emptyNormalizedUsage,
  isTerminal,
  mergeUsage,
  type NormalizedErrorEvent,
  type NormalizedEvent,
  type NormalizedStreamAdapter,
  type NormalizedUsage,
} from './events.js';

const BILLING_TOKEN_FIELDS = [
  'inputTokens',
  'outputTokens',
  'cacheCreationTokens',
  'cacheReadTokens',
] as const;

const MONITORING_FIELDS = ['reasoningTokens', 'ttftMs'] as const;

test('emptyNormalizedUsage defaults all billed token fields to 0', () => {
  const u = emptyNormalizedUsage();
  for (const key of BILLING_TOKEN_FIELDS) {
    assert.equal(u[key], 0, key);
  }
  assert.equal(u.reasoningTokens, 0);
  assert.equal(u.ttftMs, undefined);
});

test('emptyNormalizedUsage applies partial overrides without inventing ttftMs', () => {
  const u = emptyNormalizedUsage({ inputTokens: 10, cacheReadTokens: 3 });
  assert.equal(u.inputTokens, 10);
  assert.equal(u.cacheReadTokens, 3);
  assert.equal(u.outputTokens, 0);
  assert.equal(u.ttftMs, undefined);

  const withTtft = emptyNormalizedUsage({ ttftMs: 42 });
  assert.equal(withTtft.ttftMs, 42);
});

test('mergeUsage: later snapshot wins per defined token field', () => {
  const base = emptyNormalizedUsage({
    inputTokens: 10,
    outputTokens: 1,
    cacheCreationTokens: 2,
    cacheReadTokens: 3,
    reasoningTokens: 4,
  });
  const merged = mergeUsage(base, {
    outputTokens: 9,
    reasoningTokens: 0,
  });
  assert.equal(merged.inputTokens, 10);
  assert.equal(merged.outputTokens, 9);
  assert.equal(merged.cacheCreationTokens, 2);
  assert.equal(merged.cacheReadTokens, 3);
  assert.equal(merged.reasoningTokens, 0);
});

test('mergeUsage: ttftMs keeps earliest measurement', () => {
  const a = emptyNormalizedUsage({ inputTokens: 1, ttftMs: 120 });
  const b = mergeUsage(a, { outputTokens: 5, ttftMs: 80 });
  assert.equal(b.ttftMs, 80);
  assert.equal(b.outputTokens, 5);

  const c = mergeUsage(b, { ttftMs: 200 });
  assert.equal(c.ttftMs, 80);

  const noBase = mergeUsage(emptyNormalizedUsage({ inputTokens: 1 }), { ttftMs: 15 });
  assert.equal(noBase.ttftMs, 15);
});

test('mergeUsage covers every recordUsage / estimateCost token field', () => {
  // recordUsage bills: inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens
  // estimateCost reads the same four; reasoningTokens/ttftMs are monitoring-only.
  const full = mergeUsage(emptyNormalizedUsage(), {
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationTokens: 10,
    cacheReadTokens: 20,
    reasoningTokens: 7,
    ttftMs: 33,
  });
  for (const key of BILLING_TOKEN_FIELDS) {
    assert.equal(typeof full[key], 'number');
    assert.ok(full[key] > 0, key);
  }
  for (const key of MONITORING_FIELDS) {
    if (key === 'ttftMs') assert.equal(full.ttftMs, 33);
    else assert.equal(full.reasoningTokens, 7);
  }
});

test('isTerminal: final stop and fatal error only', () => {
  assert.equal(isTerminal({ type: 'stop', final: true }), true);
  assert.equal(isTerminal({ type: 'stop', final: false, reason: 'tool_use' }), false);
  assert.equal(
    isTerminal({ type: 'error', message: 'boom', code: 'glm_stream_incomplete', fatal: true }),
    true,
  );
  assert.equal(
    isTerminal({ type: 'error', message: 'soft', code: 'glm_sse_parse_error', fatal: false }),
    false,
  );
  assert.equal(isTerminal({ type: 'error', message: 'no fatal flag', code: 'x' }), false);
  assert.equal(isTerminal({ type: 'text', text: 'hi' }), false);
  assert.equal(isTerminal({ type: 'thinking', text: 'hmm' }), false);
  assert.equal(isTerminal({ type: 'tool_call', name: 'lookup' }), false);
  assert.equal(isTerminal({ type: 'usage', usage: emptyNormalizedUsage() }), false);
});

test('error event requires a stable code (e.g. glm_stream_incomplete)', () => {
  const err: NormalizedErrorEvent = {
    type: 'error',
    message: 'GLM stream ended without message_stop',
    code: 'glm_stream_incomplete',
    fatal: true,
  };
  assert.equal(err.code, 'glm_stream_incomplete');
  assert.equal(typeof err.code, 'string');
  assert.ok(err.code.length > 0);
  assert.equal(isTerminal(err), true);
});

test('NormalizedEvent union is exhaustive in switch (all six variants)', () => {
  const samples: NormalizedEvent[] = [
    { type: 'text', text: 'a' },
    { type: 'thinking', text: 'b' },
    { type: 'tool_call', id: 't1', name: 'fn', arguments: '{}' },
    { type: 'usage', usage: emptyNormalizedUsage({ inputTokens: 1 }) },
    { type: 'stop', final: true, reason: 'end_turn' },
    { type: 'error', message: 'nope', code: 'glm_stream_incomplete', fatal: true },
  ];

  const seen = new Set<NormalizedEvent['type']>();
  for (const event of samples) {
    switch (event.type) {
      case 'text':
        assert.equal(typeof event.text, 'string');
        seen.add('text');
        break;
      case 'thinking':
        assert.equal(typeof event.text, 'string');
        seen.add('thinking');
        break;
      case 'tool_call':
        assert.ok(event.name || event.id || event.arguments != null);
        seen.add('tool_call');
        break;
      case 'usage':
        assert.equal(typeof event.usage.inputTokens, 'number');
        seen.add('usage');
        break;
      case 'stop':
        assert.equal(typeof event.final, 'boolean');
        seen.add('stop');
        break;
      case 'error':
        assert.equal(typeof event.code, 'string');
        seen.add('error');
        break;
      default:
        assertNever(event);
    }
  }
  assert.deepEqual(
    [...seen].sort(),
    ['error', 'stop', 'text', 'thinking', 'tool_call', 'usage'],
  );
});

test('assertNever throws on unexpected values', () => {
  assert.throws(() => assertNever('surprise' as never), /Unhandled NormalizedEvent type/);
});

test('NormalizedStreamAdapter type: async generator shape is assignable', async () => {
  const adapter: NormalizedStreamAdapter<string> = async function* (source) {
    if (source) {
      yield { type: 'text', text: source };
      yield { type: 'usage', usage: emptyNormalizedUsage({ outputTokens: 1 }) };
      yield { type: 'stop', final: true, reason: 'end_turn' };
    } else {
      yield {
        type: 'error',
        message: 'empty',
        code: 'glm_stream_incomplete',
        fatal: true,
      };
    }
  };

  const events: NormalizedEvent[] = [];
  for await (const ev of adapter('hi')) events.push(ev);
  assert.equal(events[0]?.type, 'text');
  assert.equal(events.at(-1)?.type, 'stop');
  assert.equal(isTerminal(events.at(-1)!), true);

  const emptyEvents: NormalizedEvent[] = [];
  for await (const ev of adapter('')) emptyEvents.push(ev);
  assert.equal(emptyEvents[0]?.type, 'error');
  assert.equal((emptyEvents[0] as NormalizedErrorEvent).code, 'glm_stream_incomplete');
  assert.equal(isTerminal(emptyEvents[0]!), true);
});

test('NormalizedUsage shape documents monitoring fields beyond recordUsage columns', () => {
  // Explicit documentation test: recordUsage does not currently persist
  // reasoningTokens or ttftMs, but the contract still requires them so
  // adapters never drop provider-reported values before Phase 2 wiring.
  const usage: NormalizedUsage = {
    inputTokens: 1,
    outputTokens: 2,
    cacheCreationTokens: 3,
    cacheReadTokens: 4,
    reasoningTokens: 5,
    ttftMs: 6,
  };
  const keys = Object.keys(usage).sort();
  assert.deepEqual(keys, [
    'cacheCreationTokens',
    'cacheReadTokens',
    'inputTokens',
    'outputTokens',
    'reasoningTokens',
    'ttftMs',
  ]);
});
