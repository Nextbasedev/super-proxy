import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskThinkingBlocks, SseReverseMapper, unmaskThinkingBlocks } from './anthropic/claude-code-transform.js';
import { HermesSseReverseMapper } from './anthropic/hermes-transform.js';

function wrap(block: string): string {
  return `{"messages":[{"role":"assistant","content":[${block}]}]}`;
}

// A fingerprint word the scrubber rewrites; must survive untouched inside thinking.
const SECRET = 'OpenClaw SOUL.md fingerprint';

const VARIANTS: Record<string, string> = {
  'compact, type first': `{"type":"thinking","thinking":"${SECRET}","signature":"sig123"}`,
  'space after colon': `{"type": "thinking", "thinking": "${SECRET}", "signature": "sig123"}`,
  'type not first key': `{"thinking":"${SECRET}","type":"thinking","signature":"sig123"}`,
  'signature before type': `{"signature":"sig123","type":"thinking","thinking":"${SECRET}"}`,
  'redacted_thinking': `{"type":"redacted_thinking","data":"${SECRET}"}`,
};

for (const [name, block] of Object.entries(VARIANTS)) {
  test(`maskThinkingBlocks masks ${name} (whitespace/key-order tolerant)`, () => {
    const body = wrap(block);
    const { masked, masks } = maskThinkingBlocks(body);
    assert.equal(masks.length, 1, 'exactly one block masked');
    assert.ok(!masked.includes('OCPlatform'), 'secret no longer visible to scrubber');
    // Byte-identical restoration.
    assert.equal(unmaskThinkingBlocks(masked, masks), body);
  });
}

test('text block mentioning "thinking" is NOT masked', () => {
  const body = wrap('{"type":"text","text":"the thinking blocks are signed by anthropic"}');
  const { masked, masks } = maskThinkingBlocks(body);
  assert.equal(masks.length, 0);
  assert.equal(masked, body);
});

test('multiple interleaved thinking + tool_use blocks all masked, order preserved', () => {
  const body = `{"messages":[{"role":"assistant","content":[` +
    `{"type":"thinking","thinking":"${SECRET} A","signature":"s1"},` +
    `{"type":"tool_use","id":"t1","name":"x","input":{}},` +
    `{"signature":"s2","type":"thinking","thinking":"${SECRET} B"}` +
    `]}]}`;
  const { masked, masks } = maskThinkingBlocks(body);
  assert.equal(masks.length, 2);
  assert.ok(!masked.includes('OCPlatform'));
  assert.ok(masked.includes('"type":"tool_use"'), 'non-thinking blocks untouched');
  assert.equal(unmaskThinkingBlocks(masked, masks), body);
});

test('no thinking blocks → body unchanged, no masks', () => {
  const body = '{"messages":[{"role":"user","content":"hello"}]}';
  const { masked, masks } = maskThinkingBlocks(body);
  assert.equal(masks.length, 0);
  assert.equal(masked, body);
});

test('SseReverseMapper treats whitespace/key-reordered thinking content_block_start as protected', () => {
  const mapper = new SseReverseMapper();
  const start = 'data: {"type": "content_block_start", "index": 0, "content_block": {"signature":"sig", "type": "thinking", "thinking":""}}\n\n';
  const delta = 'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"OpenClaw must stay byte-identical"}}\n\n';
  const stop = 'data: {"type": "content_block_stop", "index": 0}\n\n';
  assert.equal(mapper.transform(start), start);
  assert.equal(mapper.transform(delta), delta);
  assert.equal(mapper.transform(stop), stop);
});

test('HermesSseReverseMapper treats whitespace/key-reordered thinking content_block_start as protected', () => {
  const mapper = new HermesSseReverseMapper();
  const start = 'data: {"type": "content_block_start", "index": 0, "content_block": {"signature":"sig", "type": "redacted_thinking", "data":""}}\n\n';
  const delta = 'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"OpenClaw must stay byte-identical"}}\n\n';
  const stop = 'data: {"type": "content_block_stop", "index": 0}\n\n';
  assert.equal(mapper.transform(start), start);
  assert.equal(mapper.transform(delta), delta);
  assert.equal(mapper.transform(stop), stop);
});
