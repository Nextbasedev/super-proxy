/**
 * Phase 3: Kimi OpenAI-compat SSE → NormalizedEvent unit tests.
 * Does not exercise the live proxy path.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectKimiEvents,
  parseKimiStream,
  usageFromProviderObject,
} from './normalize/kimi.js';
import { emptyNormalizedUsage, type NormalizedEvent, type NormalizedUsage } from './normalize/events.js';

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
  return events.filter((e) => e.type === 'error' && e.code === 'kimi_stream_incomplete');
}

const COMPLETE_OPENAI_SSE = [
  'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"finish_reason":null}]}',
  '',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":1,"input_tokens_details":{"cached_tokens":3}}}',
  '',
  'data: [DONE]',
  '',
].join('\n');

test('normalized: complete OpenAI-compat SSE emits text + usage + final stop (no incomplete error)', async () => {
  const events = await collectKimiEvents(COMPLETE_OPENAI_SSE, { fallbackInputTokens: 50 });
  assert.equal(textJoin(events), 'hello');
  assert.equal(hasFinalStop(events), true);
  assert.equal(incompleteErrors(events).length, 0);

  const stop = events.find((e) => e.type === 'stop');
  assert.ok(stop && stop.type === 'stop');
  assert.equal(stop.final, true);

  const usage = lastUsage(events);
  assert.ok(usage);
  assert.equal(usage.inputTokens, 10);
  assert.equal(usage.outputTokens, 1);
  assert.equal(usage.cacheReadTokens, 3);
  assert.equal(usage.cacheCreationTokens, 0);
  assert.equal(usage.reasoningTokens, 0);
});

test('normalized: input_tokens_details.cached_tokens maps to cacheReadTokens', async () => {
  const sse = [
    'data: {"choices":[{"index":0,"delta":{"content":"x"},"finish_reason":"stop"}],"usage":{"prompt_tokens":200,"completion_tokens":5,"input_tokens_details":{"cached_tokens":150}}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');
  const events = await collectKimiEvents(sse);
  const usage = lastUsage(events)!;
  assert.equal(usage.inputTokens, 200);
  assert.equal(usage.cacheReadTokens, 150);
  assert.equal(usage.outputTokens, 5);
});

test('normalized: prompt_tokens_details.cached_tokens also maps to cacheReadTokens (adapter)', async () => {
  // Live legacy absorbSseUsage does not read this key; adapter does so we do
  // not drop cache hits when Kimi emits the Chat Completions shape.
  const u = usageFromProviderObject(
    {
      prompt_tokens: 80,
      completion_tokens: 4,
      prompt_tokens_details: { cached_tokens: 55 },
    },
    emptyNormalizedUsage(),
    0,
  );
  assert.equal(u.inputTokens, 80);
  assert.equal(u.outputTokens, 4);
  assert.equal(u.cacheReadTokens, 55);
});

test('normalized: reasoning tokens from completion_tokens_details', async () => {
  const sse = [
    'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":20,"completion_tokens_details":{"reasoning_tokens":9}}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');
  const events = await collectKimiEvents(sse);
  assert.equal(lastUsage(events)?.reasoningTokens, 9);
  assert.equal(hasFinalStop(events), true);
});

test('normalized: empty stream yields incomplete error, never a final stop', async () => {
  const events = await collectKimiEvents('', { fallbackInputTokens: 50 });
  assert.equal(hasFinalStop(events), false);
  assert.ok(incompleteErrors(events).length >= 1);
  const usage = lastUsage(events);
  assert.ok(usage);
  assert.equal(usage.inputTokens, 50);
});

test('normalized: truncated stream (no [DONE]) is incomplete, not completion', async () => {
  const partial = [
    'data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}],"usage":{"prompt_tokens":7,"completion_tokens":1}}',
    '',
  ].join('\n');
  const events = await collectKimiEvents(partial);
  assert.equal(textJoin(events), 'partial');
  assert.equal(hasFinalStop(events), false);
  assert.ok(incompleteErrors(events).length >= 1);
  assert.equal(events.some((e) => e.type === 'stop'), false);
  // finish_reason alone on a later chunk without [DONE] still incomplete —
  // matches surfaceOpenAiCompatStreamChunk (only [DONE]/message_stop set sawCompletion).
});

test('normalized: finish_reason without [DONE] does not invent stop', async () => {
  const sse = [
    'data: {"choices":[{"index":0,"delta":{"content":"x"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1}}',
    '',
  ].join('\n');
  const events = await collectKimiEvents(sse);
  assert.equal(hasFinalStop(events), false);
  assert.ok(incompleteErrors(events).length >= 1);
});

test('normalized: tool_calls delta maps to tool_call events', async () => {
  const sse = [
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{\\"q\\":"}}]},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"x\\"}"}}]},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":9,"completion_tokens":12}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');
  const events = await collectKimiEvents(sse);
  const tools = events.filter(
    (e): e is Extract<NormalizedEvent, { type: 'tool_call' }> => e.type === 'tool_call',
  );
  assert.ok(tools.length >= 1);
  assert.equal(tools[0].name, 'lookup');
  assert.equal(tools[0].id, 'call_1');
  assert.ok(tools.some((t) => (t.arguments || '').includes('q') || (t.arguments || '').includes('x')));
  assert.equal(hasFinalStop(events), true);
});

test('normalized: Anthropic-style message_stop path still works for /messages', async () => {
  const sse = [
    'event: content_block_delta',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":4,"output_tokens":1,"cache_read_input_tokens":2}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n');
  const events = await collectKimiEvents(sse);
  assert.equal(textJoin(events), 'hi');
  assert.equal(hasFinalStop(events), true);
  assert.equal(lastUsage(events)?.cacheReadTokens, 2);
});

test('normalized: reasoning_content delta maps to thinking', async () => {
  const sse = [
    'data: {"choices":[{"index":0,"delta":{"reasoning_content":"think"},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"index":0,"delta":{"content":"out"},"finish_reason":"stop"}]}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');
  const events = await collectKimiEvents(sse);
  const thinking = events.filter((e) => e.type === 'thinking');
  assert.equal(thinking.length, 1);
  assert.equal((thinking[0] as any).text, 'think');
  assert.equal(textJoin(events), 'out');
});

test('normalized: ttftMs is set from first contentful event relative to startedAtMs', async () => {
  const started = Date.now() - 40;
  const events = await collectKimiEvents(COMPLETE_OPENAI_SSE, { startedAtMs: started });
  const usage = lastUsage(events);
  assert.ok(usage);
  assert.ok(typeof usage.ttftMs === 'number');
  assert.ok((usage.ttftMs as number) >= 0);
  assert.ok((usage.ttftMs as number) < 5_000);
});

test('normalized: parseKimiStream is lazy and yields stop last among terminals', async () => {
  const types: string[] = [];
  for await (const ev of parseKimiStream(COMPLETE_OPENAI_SSE)) {
    types.push(ev.type);
  }
  assert.ok(types.includes('text'));
  assert.ok(types.includes('usage'));
  assert.ok(types.includes('stop'));
  assert.equal(types[types.length - 1], 'stop');
  assert.ok(!types.includes('error'));
});

test('normalized: unicode surrogate pair split across SSE chunks re-assembles', async () => {
  const emoji = '😀';
  assert.equal(emoji.length, 2);
  const high = emoji[0];
  const low = emoji[1];

  const head = 'data: {"choices":[{"index":0,"delta":{"content":"hi ';
  const mid = high;
  const tail =
    low + '"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';

  async function* chunks() {
    yield head + mid;
    yield tail;
  }

  const events = await collectKimiEvents(chunks());
  assert.equal(textJoin(events), `hi ${emoji}`);
  assert.equal(hasFinalStop(events), true);
});
