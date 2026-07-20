import test from 'node:test';
import assert from 'node:assert/strict';

const { anthropicToOpenAI, openAIToAnthropic, responsesInputToOpenAI, openAIToResponsesInput, compressionFields } = await import('./proxy/compress.js');

// ─── anthropicToOpenAI ──────────────────────────────────────────────────────

test('anthropicToOpenAI: converts system string', () => {
  const result = anthropicToOpenAI('You are helpful.', [
    { role: 'user', content: 'Hi' },
  ]);
  assert.equal(result.length, 2);
  assert.equal(result[0].role, 'system');
  assert.equal(result[0].content, 'You are helpful.');
  assert.equal(result[1].role, 'user');
  assert.equal(result[1].content, 'Hi');
});

test('anthropicToOpenAI: converts system content block array', () => {
  const result = anthropicToOpenAI(
    [{ type: 'text', text: 'Part 1.' }, { type: 'text', text: 'Part 2.' }],
    [{ role: 'user', content: 'Hi' }],
  );
  assert.equal(result[0].role, 'system');
  assert.equal(result[0].content, 'Part 1. Part 2.');
});

test('anthropicToOpenAI: no system if null', () => {
  const result = anthropicToOpenAI(null, [{ role: 'user', content: 'Hi' }]);
  assert.equal(result.length, 1);
  assert.equal(result[0].role, 'user');
});

test('anthropicToOpenAI: converts tool_use to tool_calls', () => {
  const result = anthropicToOpenAI(null, [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me check.' },
        { type: 'tool_use', id: 'tu_1', name: 'get_data', input: { query: 'test' } },
      ],
    },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].role, 'assistant');
  assert.equal(result[0].content, 'Let me check.');
  assert.ok(result[0].tool_calls);
  assert.equal(result[0].tool_calls!.length, 1);
  assert.equal(result[0].tool_calls![0].id, 'tu_1');
  assert.equal(result[0].tool_calls![0].function.name, 'get_data');
  assert.equal(result[0].tool_calls![0].function.arguments, '{"query":"test"}');
});

test('anthropicToOpenAI: converts tool_result to tool role', () => {
  const result = anthropicToOpenAI(null, [
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu_1', content: '{"data": 42}' },
      ],
    },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].role, 'tool');
  assert.equal(result[0].tool_call_id, 'tu_1');
  assert.equal(result[0].content, '{"data": 42}');
});

test('anthropicToOpenAI: tool_result with content block array', () => {
  const result = anthropicToOpenAI(null, [
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu_1',
          content: [{ type: 'text', text: 'result A' }, { type: 'text', text: 'result B' }],
        },
      ],
    },
  ]);
  assert.equal(result[0].content, 'result A result B');
});

test('anthropicToOpenAI: multiple tool_use blocks in one assistant message', () => {
  const result = anthropicToOpenAI(null, [
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'tu_1', name: 'search', input: {} },
        { type: 'tool_use', id: 'tu_2', name: 'read_file', input: { path: '/a' } },
      ],
    },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].tool_calls!.length, 2);
  assert.equal(result[0].tool_calls![0].function.name, 'search');
  assert.equal(result[0].tool_calls![1].function.name, 'read_file');
});

test('anthropicToOpenAI: mixed user text + tool_result', () => {
  const result = anthropicToOpenAI(null, [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Here are the results:' },
        { type: 'tool_result', tool_use_id: 'tu_1', content: 'data here' },
      ],
    },
  ]);
  assert.equal(result.length, 2);
  assert.equal(result[0].role, 'user');
  assert.equal(result[0].content, 'Here are the results:');
  assert.equal(result[1].role, 'tool');
  assert.equal(result[1].content, 'data here');
});

// ─── openAIToAnthropic ──────────────────────────────────────────────────────

test('openAIToAnthropic: replaces tool_result content with compressed version', () => {
  const compressedOAI = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'question' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'tu_1', type: 'function', function: { name: 'q', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'tu_1', content: 'COMPRESSED_DATA' },
  ];
  const origAnthropic = [
    { role: 'user', content: 'question' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'q', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ORIGINAL_LARGE_DATA' }] },
  ];
  const result = openAIToAnthropic(compressedOAI, origAnthropic);
  assert.equal(result.length, 3);
  // tool_result should have compressed content
  const toolResult = result[2].content[0];
  assert.equal(toolResult.type, 'tool_result');
  assert.equal(toolResult.content, 'COMPRESSED_DATA');
});

test('openAIToAnthropic: preserves non-tool messages unchanged', () => {
  const compressedOAI = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'world' },
  ];
  const origAnthropic = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: [{ type: 'text', text: 'world' }] },
  ];
  const result = openAIToAnthropic(compressedOAI, origAnthropic);
  // No tool messages → no changes
  assert.deepEqual(result, origAnthropic);
});

test('openAIToAnthropic: multiple tool_results mapped correctly', () => {
  const compressedOAI = [
    { role: 'tool', tool_call_id: 'tu_1', content: 'compressed_1' },
    { role: 'tool', tool_call_id: 'tu_2', content: 'compressed_2' },
  ];
  const origAnthropic = [
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu_1', content: 'original_1' },
        { type: 'tool_result', tool_use_id: 'tu_2', content: 'original_2' },
      ],
    },
  ];
  const result = openAIToAnthropic(compressedOAI, origAnthropic);
  assert.equal(result[0].content[0].content, 'compressed_1');
  assert.equal(result[0].content[1].content, 'compressed_2');
});

// ─── compressionFields ─────────────────────────────────────────────────────

test('compressionFields: returns empty object when no compression result', () => {
  const req = {} as any;
  const fields = compressionFields(req);
  assert.deepEqual(fields, {});
});

test('compressionFields: extracts all fields from compression result', () => {
  const req = {
    compressionResult: {
      status: 'compressed' as const,
      tokensBefore: 5000,
      tokensSaved: 3000,
      compressionMs: 150,
    },
  } as any;
  const fields = compressionFields(req);
  assert.equal(fields.tokensBeforeCompression, 5000);
  assert.equal(fields.tokensSavedCompression, 3000);
  assert.equal(fields.compressionMs, 150);
  assert.equal(fields.compressionStatus, 'compressed');
});

test('compressionFields: skipped status has zero tokens', () => {
  const req = {
    compressionResult: {
      status: 'skipped' as const,
      tokensBefore: 0,
      tokensSaved: 0,
      compressionMs: 0,
    },
  } as any;
  const fields = compressionFields(req);
  assert.equal(fields.compressionStatus, 'skipped');
  assert.equal(fields.tokensBeforeCompression, undefined); // 0 → undefined via || undefined
});

// ─── Full round-trip ────────────────────────────────────────────────────────

test('full round-trip: Anthropic tool_use/result → OpenAI → compress → Anthropic', () => {
  const system = 'You are an SRE assistant.';
  const origMessages = [
    { role: 'user', content: 'How many degraded services?' },
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'tu_1', name: 'list_services', input: {} },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu_1',
          content: JSON.stringify([{ id: 1, status: 'degraded' }, { id: 2, status: 'healthy' }]),
        },
      ],
    },
  ];

  // Step 1: Convert to OpenAI
  const oai = anthropicToOpenAI(system, origMessages);
  assert.equal(oai.length, 4); // system + user + assistant(tool_calls) + tool
  assert.equal(oai[0].role, 'system');
  assert.equal(oai[2].role, 'assistant');
  assert.ok(oai[2].tool_calls);
  assert.equal(oai[3].role, 'tool');

  // Step 2: Simulate compression (replace tool content)
  const compressed = oai.map((m) => {
    if (m.role === 'tool') {
      return { ...m, content: '[2]{id:int,status:string}\n1,degraded\n2,healthy' };
    }
    return m;
  });

  // Step 3: Convert back to Anthropic
  const result = openAIToAnthropic(compressed, origMessages);

  // Verify structure preserved
  assert.equal(result.length, 3);
  assert.equal(result[0].role, 'user');
  assert.equal(result[0].content, 'How many degraded services?');
  assert.equal(result[1].role, 'assistant');
  assert.equal(result[1].content[0].type, 'tool_use');

  // Verify tool_result has compressed content
  const toolResult = result[2].content[0];
  assert.equal(toolResult.type, 'tool_result');
  assert.equal(toolResult.tool_use_id, 'tu_1');
  assert.equal(toolResult.content, '[2]{id:int,status:string}\n1,degraded\n2,healthy');
});

// ─── Edge cases ─────────────────────────────────────────────────────────────

test('anthropicToOpenAI: assistant with only text blocks (no tool_use)', () => {
  const result = anthropicToOpenAI(null, [
    { role: 'assistant', content: [{ type: 'text', text: 'Hello there.' }] },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].role, 'assistant');
  assert.equal(result[0].content, 'Hello there.');
  assert.equal(result[0].tool_calls, undefined);
});

test('anthropicToOpenAI: plain string content messages pass through', () => {
  const result = anthropicToOpenAI(null, [
    { role: 'user', content: 'plain text' },
    { role: 'assistant', content: 'plain response' },
  ]);
  assert.equal(result.length, 2);
  assert.equal(result[0].content, 'plain text');
  assert.equal(result[1].content, 'plain response');
});

test('anthropicToOpenAI: empty system string produces no system message', () => {
  const result = anthropicToOpenAI('', [{ role: 'user', content: 'Hi' }]);
  assert.equal(result.length, 1);
  assert.equal(result[0].role, 'user');
});

// ─── responsesInputToOpenAI ───────────────────────────────────────────────

test('responsesInputToOpenAI: converts message items', () => {
  const result = responsesInputToOpenAI([
    { type: 'message', role: 'user', content: 'hello' },
    { type: 'message', role: 'assistant', content: 'hi there' },
  ]);
  assert.equal(result.length, 2);
  assert.equal(result[0].role, 'user');
  assert.equal(result[0].content, 'hello');
  assert.equal(result[1].role, 'assistant');
});

test('responsesInputToOpenAI: converts function_call to tool_calls', () => {
  const result = responsesInputToOpenAI([
    { type: 'message', role: 'user', content: 'search' },
    { type: 'function_call', name: 'web_search', call_id: 'call_1', arguments: '{"q":"test"}' },
  ]);
  assert.equal(result.length, 2);
  assert.equal(result[1].role, 'assistant');
  assert.ok(result[1].tool_calls);
  assert.equal(result[1].tool_calls![0].id, 'call_1');
  assert.equal(result[1].tool_calls![0].function.name, 'web_search');
  assert.equal(result[1].tool_calls![0].function.arguments, '{"q":"test"}');
});

test('responsesInputToOpenAI: converts function_call_output to tool role', () => {
  const result = responsesInputToOpenAI([
    { type: 'function_call_output', call_id: 'call_1', output: '{"data": 42}' },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].role, 'tool');
  assert.equal(result[0].tool_call_id, 'call_1');
  assert.equal(result[0].content, '{"data": 42}');
});

test('responsesInputToOpenAI: handles array output in function_call_output', () => {
  const result = responsesInputToOpenAI([
    { type: 'function_call_output', call_id: 'call_1', output: [
      { type: 'input_text', text: 'part A' },
      { type: 'input_text', text: 'part B' },
      { type: 'input_image', image_url: 'http://...' }, // should be skipped
    ]},
  ]);
  assert.equal(result[0].content, 'part A part B');
});

test('responsesInputToOpenAI: groups consecutive function_calls under one assistant', () => {
  const result = responsesInputToOpenAI([
    { type: 'message', role: 'user', content: 'do both' },
    { type: 'function_call', name: 'search', call_id: 'c1', arguments: '{}' },
    { type: 'function_call', name: 'read', call_id: 'c2', arguments: '{}' },
  ]);
  // Both function_calls should be under one assistant message
  assert.equal(result.length, 2);
  assert.equal(result[1].tool_calls!.length, 2);
  assert.equal(result[1].tool_calls![0].function.name, 'search');
  assert.equal(result[1].tool_calls![1].function.name, 'read');
});

// ─── openAIToResponsesInput ───────────────────────────────────────────────

test('openAIToResponsesInput: replaces function_call_output with compressed content', () => {
  const compressedOAI = [
    { role: 'user', content: 'question' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'q', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'COMPRESSED' },
  ];
  const origItems = [
    { type: 'message', role: 'user', content: 'question' },
    { type: 'function_call', name: 'q', call_id: 'c1', arguments: '{}' },
    { type: 'function_call_output', call_id: 'c1', output: 'ORIGINAL_LARGE' },
  ];
  const result = openAIToResponsesInput(compressedOAI, origItems);
  assert.equal(result[2].output, 'COMPRESSED');
  assert.equal(result[0].content, 'question'); // unchanged
  assert.equal(result[1].name, 'q'); // unchanged
});

test('openAIToResponsesInput: unmatched call_id leaves original', () => {
  const compressedOAI = [
    { role: 'tool', tool_call_id: 'WRONG', content: 'compressed' },
  ];
  const origItems = [
    { type: 'function_call_output', call_id: 'c1', output: 'original' },
  ];
  const result = openAIToResponsesInput(compressedOAI, origItems);
  assert.equal(result[0].output, 'original');
});

test('openAIToResponsesInput: no tool messages returns original', () => {
  const compressedOAI = [
    { role: 'user', content: 'hello' },
  ];
  const origItems = [
    { type: 'message', role: 'user', content: 'hello' },
  ];
  const result = openAIToResponsesInput(compressedOAI, origItems);
  assert.deepEqual(result, origItems);
});

// ─── Responses full round-trip ───────────────────────────────────────────

test('full round-trip: Responses input → OpenAI → compress → Responses', () => {
  const origItems = [
    { type: 'message', role: 'user', content: 'Count items.' },
    { type: 'function_call', name: 'list', call_id: 'c1', arguments: '{}' },
    { type: 'function_call_output', call_id: 'c1', output: JSON.stringify([{id:1,x:"a"},{id:2,x:"b"}]) },
  ];

  // Convert to OpenAI
  const oai = responsesInputToOpenAI(origItems);
  assert.equal(oai.length, 3);
  assert.equal(oai[0].role, 'user');
  assert.equal(oai[1].role, 'assistant');
  assert.equal(oai[2].role, 'tool');

  // Simulate compression
  const compressed = oai.map(m => {
    if (m.role === 'tool') return { ...m, content: '[2]{id:int,x:string}\n1,a\n2,b' };
    return m;
  });

  // Convert back
  const result = openAIToResponsesInput(compressed, origItems);
  assert.equal(result.length, 3);
  assert.equal(result[0].type, 'message');
  assert.equal(result[1].type, 'function_call');
  assert.equal(result[2].type, 'function_call_output');
  assert.equal(result[2].output, '[2]{id:int,x:string}\n1,a\n2,b');
  assert.equal(result[2].call_id, 'c1');
});

// ─── Edge cases ──────────────────────────────────────────────────────────

test('openAIToAnthropic: unmatched tool_call_id leaves original intact', () => {
  const compressedOAI = [
    { role: 'tool', tool_call_id: 'WRONG_ID', content: 'compressed' },
  ];
  const origAnthropic = [
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu_1', content: 'original' },
      ],
    },
  ];
  const result = openAIToAnthropic(compressedOAI, origAnthropic);
  assert.equal(result[0].content[0].content, 'original'); // unchanged
});
