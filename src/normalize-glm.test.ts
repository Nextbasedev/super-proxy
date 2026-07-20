/**
 * Phase 2: GLM SSE → NormalizedEvent unit tests.
 * Ported/expanded from the Phase 0 spike. Does not exercise the live proxy path.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { collectGlmEvents, parseGlmStream } from './normalize/glm.js';
import type { NormalizedEvent, NormalizedUsage } from './normalize/events.js';

function textJoin(events: NormalizedEvent[]): string {
  return events
    .filter((e): e is Extract<NormalizedEvent, { type: 'text' }> => e.type === 'text')
    .map((e) => e.text)
    .join('');
}

function lastUsage(events: NormalizedEvent[]): NormalizedUsage | undefined {
  const usages = events.filter(
    (e): e is Extract<NormalizedEvent, { type: 'usage' }> => e.type === 'usage',
  );
  return usages.length ? usages[usages.length - 1].usage : undefined;
}

function hasFinalStop(events: NormalizedEvent[]): boolean {
  return events.some((e) => e.type === 'stop' && e.final);
}

function incompleteErrors(events: NormalizedEvent[]): NormalizedEvent[] {
  return events.filter((e) => e.type === 'error' && e.code === 'glm_stream_incomplete');
}

// Full Anthropic-style happy path used by the existing glm.test.ts message_stop case.
const COMPLETE_SSE = [
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

test('normalized: complete GLM/Anthropic SSE emits text + usage + final stop (no incomplete error)', async () => {
  const events = await collectGlmEvents(COMPLETE_SSE, { fallbackInputTokens: 50 });
  assert.equal(textJoin(events), 'hello');
  assert.equal(hasFinalStop(events), true);
  assert.equal(incompleteErrors(events).length, 0);

  const stop = events.find((e) => e.type === 'stop');
  assert.ok(stop && stop.type === 'stop');
  assert.equal(stop.reason, 'end_turn');
  assert.equal(stop.final, true);

  const usage = lastUsage(events);
  assert.ok(usage);
  assert.equal(usage.inputTokens, 1);
  assert.equal(usage.outputTokens, 1);
  assert.equal(usage.cacheCreationTokens, 0);
  assert.equal(usage.cacheReadTokens, 0);
  assert.equal(usage.reasoningTokens, 0);

  // Structural prevention of the PR #120 bug class: once `stop` exists,
  // consumers must not invent glm_stream_interrupted.
  const wouldFakeInterrupt = !hasFinalStop(events);
  assert.equal(wouldFakeInterrupt, false);
});

test('normalized: message_start + message_delta usage extraction (billing fields)', async () => {
  const sse = [
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

  const events = await collectGlmEvents(sse);
  const usage = lastUsage(events)!;
  assert.equal(usage.inputTokens, 13);
  assert.equal(usage.outputTokens, 5);
  assert.equal(usage.cacheCreationTokens, 2);
  assert.equal(usage.cacheReadTokens, 4);
  assert.equal(usage.reasoningTokens, 7);
  for (const key of [
    'inputTokens',
    'outputTokens',
    'cacheCreationTokens',
    'cacheReadTokens',
    'reasoningTokens',
  ] as const) {
    assert.equal(typeof usage[key], 'number');
  }
});

test('normalized: bare delta.text (GLM fixture style without text_delta type) still yields text', async () => {
  const sse =
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":7,"output_tokens":0}}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"partial"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
  const events = await collectGlmEvents(sse);
  assert.equal(textJoin(events), 'partial');
  assert.equal(hasFinalStop(events), true);
  assert.equal(lastUsage(events)?.inputTokens, 7);
});

test('normalized: tokens edge-case — zero-token empty assistant turn still stops cleanly', async () => {
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":3,"output_tokens":0}}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":3,"output_tokens":0}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n');
  const events = await collectGlmEvents(sse);
  assert.equal(textJoin(events), '');
  assert.equal(hasFinalStop(events), true);
  assert.equal(lastUsage(events)?.inputTokens, 3);
  assert.equal(lastUsage(events)?.outputTokens, 0);
  assert.equal(incompleteErrors(events).length, 0);
});

test('normalized: empty stream yields incomplete error, never a final stop', async () => {
  const events = await collectGlmEvents('', { fallbackInputTokens: 50 });
  assert.equal(hasFinalStop(events), false);
  assert.ok(incompleteErrors(events).length >= 1);
  const usage = lastUsage(events);
  assert.ok(usage);
  assert.equal(usage.inputTokens, 50);
});

test('normalized: abort/partial stream (no message_stop) is incomplete, not completion', async () => {
  const partial = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":7,"output_tokens":0}}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}',
    '',
  ].join('\n');
  const events = await collectGlmEvents(partial);
  assert.equal(textJoin(events), 'partial');
  assert.equal(hasFinalStop(events), false);
  assert.ok(incompleteErrors(events).length >= 1);
  assert.equal(events.some((e) => e.type === 'stop'), false);
});

test('normalized: tool-call-without-result still completes when message_stop arrives', async () => {
  const sse = [
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"lookup","input":{}}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":\\"x\\"}"}}',
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"input_tokens":9,"output_tokens":12}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n');
  const events = await collectGlmEvents(sse);
  const tools = events.filter(
    (e): e is Extract<NormalizedEvent, { type: 'tool_call' }> => e.type === 'tool_call',
  );
  assert.ok(tools.length >= 1);
  assert.equal(tools[0].name, 'lookup');
  assert.equal(tools[0].id, 'toolu_1');
  assert.ok(tools.some((t) => (t.arguments || '').includes('"q"')));
  assert.equal(hasFinalStop(events), true);
  const stop = events.find((e) => e.type === 'stop');
  assert.ok(stop && stop.type === 'stop');
  assert.equal(stop.reason, 'tool_use');
});

test('normalized: unicode surrogate pair split across SSE chunks re-assembles', async () => {
  const emoji = '😀';
  assert.equal(emoji.length, 2); // two UTF-16 code units
  const high = emoji[0];
  const low = emoji[1];

  const head =
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi ';
  const mid = high;
  const tail = low + '"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';

  async function* chunks() {
    yield head + mid;
    yield tail;
  }

  const events = await collectGlmEvents(chunks());
  assert.equal(textJoin(events), `hi ${emoji}`);
  assert.equal(hasFinalStop(events), true);
});

test('normalized: thinking deltas map to thinking events', async () => {
  const sse = [
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"step 1"}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"answer"}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n');
  const events = await collectGlmEvents(sse);
  const thinking = events.filter((e) => e.type === 'thinking');
  assert.equal(thinking.length, 1);
  assert.equal((thinking[0] as any).text, 'step 1');
  assert.equal(textJoin(events), 'answer');
  assert.equal(hasFinalStop(events), true);
});

test('normalized: ttftMs is set from first contentful event relative to startedAtMs', async () => {
  const started = Date.now() - 40;
  const sse = [
    'event: content_block_delta',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n');
  const events = await collectGlmEvents(sse, { startedAtMs: started });
  const usage = lastUsage(events);
  assert.ok(usage);
  assert.ok(typeof usage.ttftMs === 'number');
  assert.ok((usage.ttftMs as number) >= 0);
  assert.ok((usage.ttftMs as number) < 5_000);
});

test('normalized: async iterable of binary chunks works (ReadableStream-like)', async () => {
  const encoder = new TextEncoder();
  async function* bin() {
    yield encoder.encode(
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ab"}}\n\n',
    );
    yield encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  }
  const events = await collectGlmEvents(bin());
  assert.equal(textJoin(events), 'ab');
  assert.equal(hasFinalStop(events), true);
});

test('normalized: parseGlmStream is lazy (AsyncIterable) and yields stop last among terminals', async () => {
  const types: string[] = [];
  for await (const ev of parseGlmStream(COMPLETE_SSE)) {
    types.push(ev.type);
  }
  assert.ok(types.includes('text'));
  assert.ok(types.includes('usage'));
  assert.ok(types.includes('stop'));
  assert.equal(types[types.length - 1], 'stop');
  assert.ok(!types.includes('error'));
});
