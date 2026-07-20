import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isHermesBody,
  processHermesBody,
  reverseMapHermes,
  reverseMapHermesJsonResponse,
  applyHermesOAuthHeaders,
  HERMES_CC_VERSION,
} from './anthropic/hermes-transform.js';
import { processBody as ccProcessBody } from './anthropic/claude-code-transform.js';

function hermesRequest(): any {
  return {
    model: 'claude-haiku-4-5',
    max_tokens: 1024,
    system: [
      { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
      { type: 'text', text: 'You are a helpful assistant.' },
    ],
    messages: [{ role: 'user', content: 'What is 2+2? Use the bash tool.' }],
    tools: [
      {
        name: 'mcp_bash',
        description: 'Run a shell command',
        input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      },
    ],
    tool_choice: { type: 'auto' },
  };
}

test('isHermesBody detects mcp_ tool names', () => {
  assert.equal(isHermesBody(JSON.stringify(hermesRequest())), true);
});

test('isHermesBody detects newer Hermes system identity even with bare tool names', () => {
  const req = {
    model: 'claude-opus-4-8',
    system: [{ type: 'text', text: 'You run on Hermes Agent (by Nous Research). Use the available tools carefully.' }],
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'browser_back' }, { name: 'terminal' }, { name: 'delegate_task' }],
  };
  assert.equal(isHermesBody(JSON.stringify(req)), true);
  const out = JSON.parse(processHermesBody(JSON.stringify(req)));
  assert.deepEqual(out.tools.map((t: any) => t.name), ['mcp__hermes__Browser_back', 'mcp__hermes__Terminal', 'mcp__hermes__Delegate_task']);
});

test('isHermesBody is false when Hermes is mentioned only in a user message', () => {
  const oc = { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'Tell me about Hermes Agent (by Nous Research)' }], tools: [{ name: 'exec' }, { name: 'read' }] };
  assert.equal(isHermesBody(JSON.stringify(oc)), false);
});

test('isHermesBody is false for OCPlatform-style bodies', () => {
  const oc = { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'exec' }, { name: 'read' }] };
  assert.equal(isHermesBody(JSON.stringify(oc)), false);
});

test('processHermesBody namespaces mcp_bash -> mcp__hermes__Bash', () => {
  const out = JSON.parse(processHermesBody(JSON.stringify(hermesRequest())));
  assert.equal(out.tools[0].name, 'mcp__hermes__Bash');
});

test('processHermesBody injects signed billing header as system[0]', () => {
  const out = JSON.parse(processHermesBody(JSON.stringify(hermesRequest())));
  assert.equal(out.system[0].type, 'text');
  assert.match(out.system[0].text, /^x-anthropic-billing-header: cc_version=/);
  assert.match(out.system[0].text, /cc_entrypoint=sdk-cli/);
  assert.match(out.system[0].text, /cch=[0-9a-f]{5};$/);
  // version is HERMES_CC_VERSION.<3hex>
  assert.match(out.system[0].text, new RegExp(`cc_version=${HERMES_CC_VERSION.replace(/\./g, '\\.')}\\.[0-9a-f]{3};`));
});

test('processHermesBody keeps Claude Code identity as system[1]', () => {
  const out = JSON.parse(processHermesBody(JSON.stringify(hermesRequest())));
  assert.equal(out.system[1].text, "You are Claude Code, Anthropic's official CLI for Claude.");
});

test('processHermesBody keeps non-identity system in system[] (OCPlatform parity, no relocation)', () => {
  const out = JSON.parse(processHermesBody(JSON.stringify(hermesRequest())));
  // system = [billing, identity, ...other system blocks] — nothing relocated.
  assert.ok(out.system[0].text.includes('x-anthropic-billing-header'), 'system[0] must be the billing header');
  assert.equal(out.system[1].text, "You are Claude Code, Anthropic's official CLI for Claude.");
  // The 'You are a helpful assistant.' block is preserved in system[], NOT moved.
  const sysJoined = out.system.map((s: any) => s.text).join('\n');
  assert.ok(sysJoined.includes('You are a helpful assistant.'), 'helpful-assistant block must stay in system[]');
  // The user message must be untouched — no <system-reminder> injected.
  const firstUser = out.messages.find((m: any) => m.role === 'user');
  const text = Array.isArray(firstUser.content) ? firstUser.content.map((c: any) => c.text || '').join('') : firstUser.content;
  assert.equal(text.includes('<system-reminder>'), false);
  assert.ok(text.includes('What is 2+2?'), 'user prompt must be preserved');
});

test('processHermesBody keeps ops instructions fused after the identity line', () => {
  const req = hermesRequest();
  req.system = [
    { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude.\nAlways cite files. Never fabricate output." },
  ];
  const out = JSON.parse(processHermesBody(JSON.stringify(req)));
  // identity + fused ops text stay together in system[1], full weight.
  assert.ok(out.system[1].text.includes('Always cite files. Never fabricate output.'), 'fused ops text must stay in system[1]');
  const firstUser = out.messages.find((m: any) => m.role === 'user');
  const text = Array.isArray(firstUser.content) ? firstUser.content.map((c: any) => c.text || '').join('') : firstUser.content;
  assert.equal(text.includes('<system-reminder>'), false);
});

test('billing header signature is deterministic for the same first user text', () => {
  const a = JSON.parse(processHermesBody(JSON.stringify(hermesRequest())));
  const b = JSON.parse(processHermesBody(JSON.stringify(hermesRequest())));
  assert.equal(a.system[0].text, b.system[0].text);
});

test('processHermesBody repairs orphaned tool_use blocks', () => {
  const req = hermesRequest();
  req.messages = [
    { role: 'user', content: 'do it' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'orphan1', name: 'mcp_bash', input: {} }] },
    // no matching tool_result -> orphan must be stripped
  ];
  const out = JSON.parse(processHermesBody(JSON.stringify(req)));
  const assistantMsgs = out.messages.filter((m: any) => m.role === 'assistant');
  for (const m of assistantMsgs) {
    if (Array.isArray(m.content)) {
      for (const b of m.content) assert.notEqual(b.id, 'orphan1');
    }
  }
});

test('processHermesBody strips effort for haiku', () => {
  const req = hermesRequest();
  req.output_config = { effort: 'high', verbosity: 'low' };
  const out = JSON.parse(processHermesBody(JSON.stringify(req)));
  assert.ok(!out.output_config || !('effort' in out.output_config));
});

test('processHermesBody namespaces tool_use blocks in message history', () => {
  const req = hermesRequest();
  req.messages = [
    { role: 'user', content: 'run' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'mcp_bash', input: { command: 'ls' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
  ];
  const out = JSON.parse(processHermesBody(JSON.stringify(req)));
  const asst = out.messages.find((m: any) => m.role === 'assistant');
  assert.equal(asst.content[0].name, 'mcp__hermes__Bash');
});

test('reverseMapHermes unwraps mcp__hermes__Bash -> bash in responses', () => {
  const resp = JSON.stringify({
    type: 'message',
    content: [{ type: 'tool_use', id: 'x', name: 'mcp__hermes__Bash', input: { command: 'ls' } }],
  });
  const mapped = JSON.parse(reverseMapHermes(resp));
  assert.equal(mapped.content[0].name, 'bash');
});

test('reverseMapHermesJsonResponse preserves thinking blocks byte-for-byte', () => {
  const resp = JSON.stringify({
    type: 'message',
    content: [
      { type: 'thinking', thinking: 'mcp__hermes__Bash should NOT be rewritten here', signature: 'sig' },
      { type: 'tool_use', id: 'x', name: 'mcp__hermes__Bash', input: {} },
    ],
  });
  const mapped = reverseMapHermesJsonResponse(resp);
  const parsed = JSON.parse(mapped);
  // thinking text untouched
  assert.equal(parsed.content[0].thinking, 'mcp__hermes__Bash should NOT be rewritten here');
  // tool name unwrapped
  assert.equal(parsed.content[1].name, 'bash');
});

test('applyHermesOAuthHeaders sets sdk-cli-style fingerprint + betas', () => {
  const h = new Headers();
  applyHermesOAuthHeaders(h);
  assert.match(h.get('user-agent') || '', new RegExp(`claude-cli/${HERMES_CC_VERSION.replace(/\./g, '\\.')}`));
  assert.equal(h.get('x-stainless-lang'), 'js');
  assert.equal(h.get('anthropic-dangerous-direct-browser-access'), 'true');
  const betas = (h.get('anthropic-beta') || '').split(',');
  assert.ok(betas.includes('oauth-2025-04-20'));
  assert.ok(betas.includes('claude-code-20250219'));
  assert.ok(betas.includes('advisor-tool-2026-03-01'));
});

// ─── Isolation guarantee: OCPlatform transform must be untouched by Hermes code ──
test('OpenClaw body is NOT detected as Hermes and uses the OCPlatform transform', () => {
  const ocBody = {
    model: 'claude-sonnet-4-5',
    system: 'You are a personal assistant.',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [{ name: 'exec', description: 'run', input_schema: { type: 'object', properties: {} } }],
  };
  const str = JSON.stringify(ocBody);
  assert.equal(isHermesBody(str), false);
  // OCPlatform transform still produces its own billing block with entrypoint=cli
  const out = ccProcessBody(str);
  assert.ok(out.includes('cc_entrypoint=cli;'));
  assert.equal(out.includes('cc_entrypoint=sdk-cli'), false);
  // and does NOT contain the Hermes namespace
  assert.equal(out.includes('mcp__hermes__'), false);
});

test('Hermes transform does not emit OCPlatform entrypoint=cli', () => {
  const out = processHermesBody(JSON.stringify(hermesRequest()));
  // `sdk-cli;` ends in `cli;`, so assert the full `=cli;` token form.
  assert.equal(out.includes('=cli;'), false);
  assert.ok(out.includes('cc_entrypoint=sdk-cli;'), 'expected sdk-cli entrypoint');
});
