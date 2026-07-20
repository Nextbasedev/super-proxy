import test from 'node:test';
import assert from 'node:assert/strict';

const { setCodexOriginatorHeaders } = await import('./proxy/openai.js');

test('luna gets codex_cli_rs originator + version header', () => {
  const h = new Headers();
  setCodexOriginatorHeaders(h, 'gpt-5.6-luna');
  assert.equal(h.get('originator'), 'codex_cli_rs');
  assert.equal(h.get('version'), '0.144.1');
});

test('other codex models keep pi originator without version', () => {
  for (const model of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.5', 'gpt-image-2', undefined]) {
    const h = new Headers();
    setCodexOriginatorHeaders(h, model);
    assert.equal(h.get('originator'), 'pi', String(model));
    assert.equal(h.get('version'), null, String(model));
  }
});
