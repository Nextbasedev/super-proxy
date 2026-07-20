import test from 'node:test';
import assert from 'node:assert/strict';

const { estimateCost } = await import('./proxy/cost.js');

const approx = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} !== ${b}`);

test('kimi k2.6 priced at notional retail (cache-miss input + output)', () => {
  // 1M input, 1M output -> 0.95 + 4.00
  approx(estimateCost('kimi-k2.6', { inputTokens: 1_000_000, outputTokens: 1_000_000 }, 'kimi'), 0.95 + 4.0);
});

test('kimi cache-read tokens billed at cache-hit rate, deducted from input', () => {
  // 1M input of which 0.4M is cache-read, 0 output
  // billable input = 0.6M * 0.95 + 0.4M * 0.16
  approx(
    estimateCost('kimi-k2.6', { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 400_000 }, 'kimi'),
    0.6 * 0.95 + 0.4 * 0.16,
  );
});

test('kimi k2.7 code priced at official retail-equivalent rate', () => {
  approx(estimateCost('kimi-k2.7-code', { inputTokens: 1_000_000, outputTokens: 1_000_000 }, 'kimi'), 0.95 + 4.0);
  approx(
    estimateCost('kimi-k2.7-code', { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 400_000 }, 'kimi'),
    0.6 * 0.95 + 0.4 * 0.19,
  );
});

test('kimi-for-coding shares k2.6 rate', () => {
  approx(estimateCost('kimi-for-coding', { inputTokens: 1_000_000, outputTokens: 0 }, 'kimi'), 0.95);
});

test('xAI grok-4.5 uses published chat pricing', () => {
  approx(estimateCost('grok-4.5', { inputTokens: 1_000_000, outputTokens: 1_000_000 }, 'xai'), 2 + 6);
});

test('unknown kimi model falls back to default kimi rate (not 0)', () => {
  approx(estimateCost('kimi-mystery', { inputTokens: 1_000_000, outputTokens: 0 }, 'kimi'), 0.95);
});

test('claude-fable-5 billed at $10/$50 per MTok, not sonnet rates', () => {
  // 1M in + 1M out -> 10 + 50 = 60 (NOT 3 + 15 = 18 from the generic claude->sonnet fallback)
  approx(estimateCost('claude-fable-5', { inputTokens: 1_000_000, outputTokens: 1_000_000 }, 'anthropic'), 60);
  // cache: write 1.25x input, read 0.1x input
  approx(estimateCost('claude-fable-5', { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 1_000_000, cacheReadTokens: 1_000_000 }, 'anthropic'), 12.5 + 1.0);
  // opus/sonnet/haiku unchanged by the new branch
  approx(estimateCost('claude-opus-4-8', { inputTokens: 1_000_000, outputTokens: 0 }, 'anthropic'), 15);
  approx(estimateCost('claude-sonnet-4-6', { inputTokens: 1_000_000, outputTokens: 0 }, 'anthropic'), 3);
});

test('non-priced free providers still return 0', () => {
  assert.equal(estimateCost('any', { inputTokens: 1_000_000, outputTokens: 1_000_000 }, 'groq'), 0);
  assert.equal(estimateCost('any', { inputTokens: 1_000_000, outputTokens: 1_000_000 }, 'cerebras'), 0);
});

// ─── cache savings across provider semantics (verified live 2026-07-10) ──────
const { cacheSavedUsd } = await import('./monitoring/rollup.js');
const { getRates, cacheSemantics } = await import('./proxy/cost.js');

test('cacheSemantics: subset only for known subset providers; separate otherwise', () => {
  assert.equal(cacheSemantics('anthropic'), 'separate');
  assert.equal(cacheSemantics('glm'), 'separate');
  assert.equal(cacheSemantics('gemini'), 'separate');
  assert.equal(cacheSemantics('openai_codex'), 'subset');
  assert.equal(cacheSemantics('xai'), 'subset');
  assert.equal(cacheSemantics('kimi'), 'subset');
});

test('getRates now returns retail rates for glm/xai/codex (was null before)', () => {
  assert.ok(getRates('glm', 'glm-4.6'), 'glm priced');
  assert.ok(getRates('xai', 'grok-4.5'), 'xai grok-4.5 priced');
  assert.ok(getRates('openai_codex', 'gpt-5.5'), 'codex priced');
  // xai non-priced text model still null (no retail row)
  assert.equal(getRates('xai', 'grok-3-mini'), null);
});

test('cacheSavedUsd: GLM (separate) values reads at input-minus-cacheRead discount', () => {
  // glm-4.6: input $0.6/1M, cacheRead $0.11/1M. 1M cached reads save (0.6-0.11)=$0.49.
  approx(cacheSavedUsd('glm', 'glm-4.6', 1_000_000, 0), 0.49);
});

test('cacheSavedUsd: xAI (subset) grok-4.5 read discount', () => {
  // grok-4.5: input $2/1M, cacheRead $0.5/1M. 1M cached reads save (2-0.5)=$1.5.
  approx(cacheSavedUsd('xai', 'grok-4.5', 1_000_000, 0), 1.5);
});

test('cacheSavedUsd: Codex (subset) gpt-5.5 read discount', () => {
  // gpt-5.5: input $5/1M, cacheRead $0.5/1M. 1M cached reads save (5-0.5)=$4.5.
  approx(cacheSavedUsd('openai_codex', 'gpt-5.5', 1_000_000, 0), 4.5);
});

test('cacheSavedUsd: Anthropic (separate) subtracts write premium', () => {
  // opus: input $15, cacheRead $1.5, cacheWrite $18.75. 1M read + 1M write:
  //   read saving = 1M*(15-1.5)=13.5 ; write premium = 1M*(18.75-15)=3.75 ; net 9.75.
  approx(cacheSavedUsd('anthropic', 'claude-opus-4-8', 1_000_000, 1_000_000), 9.75);
});

test('cacheSavedUsd: unpriced provider (groq) stays 0', () => {
  assert.equal(cacheSavedUsd('groq', 'whatever', 1_000_000, 0), 0);
});

test('estimateCost: xAI subset — cached slice priced at cacheRead, deducted from input', () => {
  // real probe: input=1722 (cached=1664). billable input = 58.
  //   58*$2/1M + 1664*$0.5/1M + output. Use 0 output for clarity.
  const c = estimateCost('grok-4.5', { inputTokens: 1722, outputTokens: 0, cacheReadTokens: 1664 }, 'xai');
  approx(c, (58 * 2 + 1664 * 0.5) / 1_000_000);
});

test('estimateCost: Codex subset — gpt-5.5 cached slice discounted', () => {
  // real probe: input=2031 (cached=1792). billable = 239.
  const c = estimateCost('gpt-5.5', { inputTokens: 2031, outputTokens: 0, cacheReadTokens: 1792 }, 'openai_codex');
  approx(c, (239 * 5 + 1792 * 0.5) / 1_000_000);
});

test('estimateCost: GLM separate — cache read is its own pool, NOT deducted from input', () => {
  // real probe warm call: input=32, cache_read=1984 (SEPARATE — do not merge).
  // glm-4.6: 32*$0.6/1M + 1984*$0.11/1M.
  const c = estimateCost('glm-4.6', { inputTokens: 32, outputTokens: 0, cacheReadTokens: 1984 }, 'glm');
  // roundUsd truncates to 6 decimals: 0.00023744 -> 0.000237.
  approx(c, Math.round((32 * 0.6 + 1984 * 0.11) / 1_000_000 * 1e6) / 1e6);
});
