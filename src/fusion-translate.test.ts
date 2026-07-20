import test from 'node:test';
import assert from 'node:assert/strict';

const { translateToAnthropic, translateRequest, getProviderRoute } = await import('./fusion/translate.js');
const { validateProviderModel } = await import('./fusion/presets.js');
const { findCatalogModel } = await import('./providers/model-catalog.js');

const MSGS = [{ role: 'user', content: 'hi' }];
const PM = 'anthropic/claude-opus-4-8';

test('anthropic effort goes under output_config.effort, not top-level (Anthropic rejects top-level effort)', () => {
  const body = translateToAnthropic(MSGS, 'claude-opus-4-8', 1024, false, undefined,
    { [PM]: { effort: 'xhigh' } }, PM);
  assert.equal(body.effort, undefined, 'must not set top-level effort (Anthropic 400s on it)');
  assert.ok(body.output_config, 'output_config present');
  assert.equal(body.output_config.effort, 'xhigh');
});

test('anthropic thinking + effort coexist; effort nested, thinking top-level', () => {
  const body = translateToAnthropic(MSGS, 'claude-opus-4-8', 1024, false, undefined,
    { [PM]: { thinking: { type: 'adaptive' }, effort: 'max' } }, PM);
  assert.deepEqual(body.thinking, { type: 'adaptive' });
  assert.equal(body.effort, undefined);
  assert.equal(body.output_config.effort, 'max');
});

test('anthropic effort merges into existing output_config from extraFields', () => {
  const body = translateToAnthropic(MSGS, 'claude-opus-4-8', 1024, false,
    { output_config: { keep: 1 } }, { [PM]: { effort: 'high' } }, PM);
  assert.equal(body.output_config.keep, 1, 'pre-existing output_config preserved');
  assert.equal(body.output_config.effort, 'high');
});

test('no thinking config → no output_config injected', () => {
  const body = translateToAnthropic(MSGS, 'claude-opus-4-8', 1024, false);
  assert.equal(body.output_config, undefined);
  assert.equal(body.effort, undefined);
});

test('Fusion validation requires an exact canonical chat model on a supported route', () => {
  assert.ok(findCatalogModel('glm', 'glm-5.2'), 'catalog existence is independent of Fusion routing');
  assert.equal(findCatalogModel('gemini', 'not-a-real-model'), undefined);
  assert.deepEqual(validateProviderModel('gemini/gemini-3.5-flash'), { ok: true });
  assert.equal(validateProviderModel('gemini/not-a-real-model').ok, false);
  assert.match((validateProviderModel('gemini/not-a-real-model') as any).message, /Unknown canonical model/);
  assert.equal(validateProviderModel('glm/glm-5.2').ok, false);
  assert.match((validateProviderModel('glm/glm-5.2') as any).message, /not supported by Fusion routing/);
  assert.equal(validateProviderModel('runpod/qwen36-27b').ok, false);
  assert.match((validateProviderModel('runpod/qwen36-27b') as any).message, /not supported by Fusion routing/);
  assert.deepEqual(validateProviderModel('openrouter/tencent/hy3:free'), { ok: true }, 'model ids may contain a slash after the provider delimiter');
});

test('xAI Fusion route targets the implemented Responses endpoint and translates that API shape', () => {
  assert.deepEqual(getProviderRoute('xai/grok-4-fast'), { url: '/v1/xai/responses', format: 'xai_responses' });
  const body = translateRequest('xai/grok-4-fast', MSGS, 512, false, undefined, {
    'xai/grok-4-fast': 'reasoning',
  });
  assert.equal(body.model, 'grok-4-fast-reasoning');
  assert.equal(body.max_output_tokens, 512);
  assert.ok(Array.isArray(body.input));
  assert.equal(body.messages, undefined);
});
