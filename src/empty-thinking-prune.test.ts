import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropEmptySignedThinkingBlocks, maskThinkingBlocks, processBody } from './anthropic/claude-code-transform.js';
import { processHermesBody } from './anthropic/hermes-transform.js';

function bodyWith(content: any[]) {
  return JSON.stringify({ model: 'claude-opus-4-8', messages: [{ role: 'assistant', content }] });
}

test('dropEmptySignedThinkingBlocks removes compacted empty signed thinking blocks', () => {
  const body = bodyWith([
    { type: 'thinking', thinking: '', signature: 'sig' },
    { type: 'text', text: 'visible answer' },
  ]);
  const out = dropEmptySignedThinkingBlocks(body);
  assert.equal(out.dropped, 1);
  const parsed = JSON.parse(out.body);
  assert.deepEqual(parsed.messages[0].content, [{ type: 'text', text: 'visible answer' }]);
});

test('dropEmptySignedThinkingBlocks removes empty signed redacted_thinking blocks', () => {
  const body = bodyWith([
    { type: 'redacted_thinking', data: '', signature: 'sig' },
    { type: 'tool_use', id: 't1', name: 'x', input: {} },
  ]);
  const out = dropEmptySignedThinkingBlocks(body);
  assert.equal(out.dropped, 1);
  const parsed = JSON.parse(out.body);
  assert.equal(parsed.messages[0].content.length, 1);
  assert.equal(parsed.messages[0].content[0].type, 'tool_use');
});


test('dropEmptySignedThinkingBlocks removes whitespace-only signed thinking payloads', () => {
  const body = bodyWith([
    { type: 'thinking', thinking: '   \n\t', signature: 'sig' },
    { type: 'text', text: 'visible answer' },
  ]);
  const out = dropEmptySignedThinkingBlocks(body);
  assert.equal(out.dropped, 1);
  const parsed = JSON.parse(out.body);
  assert.deepEqual(parsed.messages[0].content, [{ type: 'text', text: 'visible answer' }]);
});

test('dropEmptySignedThinkingBlocks drops corrupt blocks while preserving valid signed thinking in the same message', () => {
  const valid = { type: 'thinking', thinking: 'actual hidden reasoning', signature: 'valid-sig' };
  const body = bodyWith([
    { type: 'thinking', thinking: '', signature: 'empty-sig' },
    valid,
    { type: 'text', text: 'answer' },
  ]);
  const out = dropEmptySignedThinkingBlocks(body);
  assert.equal(out.dropped, 1);
  const parsed = JSON.parse(out.body);
  assert.equal(parsed.messages[0].content.length, 2);
  assert.deepEqual(parsed.messages[0].content[0], valid);
  assert.deepEqual(parsed.messages[0].content[1], { type: 'text', text: 'answer' });
});


test('dropEmptySignedThinkingBlocks preserves valid non-empty signed thinking blocks', () => {
  const block = { type: 'thinking', thinking: 'actual hidden reasoning', signature: 'sig' };
  const body = bodyWith([block, { type: 'text', text: 'answer' }]);
  const out = dropEmptySignedThinkingBlocks(body);
  assert.equal(out.dropped, 0);
  assert.equal(out.body, body);
  const masked = maskThinkingBlocks(out.body);
  assert.equal(masked.masks.length, 1);
});


test('dropEmptySignedThinkingBlocks replaces all-pruned assistant content with neutral marker', () => {
  const body = JSON.stringify({ messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'sig' }] }] });
  const out = dropEmptySignedThinkingBlocks(body);
  assert.equal(out.dropped, 1);
  const parsed = JSON.parse(out.body);
  assert.deepEqual(parsed.messages[0].content, [{ type: 'text', text: '[compacted signed thinking block removed]' }]);
});


test('processBody prunes already-corrupted compacted thinking history before forwarding', () => {
  const body = JSON.stringify({
    model: 'claude-opus-4-8',
    messages: [
      { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: 'hello' }] },
      { role: 'user', content: 'next turn' },
    ],
  });
  const out = processBody(body);
  assert.ok(!out.includes('"signature":"sig"'));
  assert.ok(!out.includes('"type":"thinking"'));
});

test('processHermesBody also prunes already-corrupted compacted thinking history', () => {
  const body = JSON.stringify({
    model: 'claude-opus-4-8',
    system: [{ type: 'text', text: 'You are Hermes' }],
    messages: [
      { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: 'hello' }] },
      { role: 'user', content: 'next turn' },
    ],
    tools: [],
  });
  const out = processHermesBody(body);
  assert.ok(!out.includes('"signature":"sig"'));
  assert.ok(!out.includes('"type":"thinking"'));
});
