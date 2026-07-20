import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCodexUpstreamError, computeCodexCooldownMs } from './providers/codex-pool.js';

test('computeCodexCooldownMs honors retry-after seconds', () => {
  assert.equal(computeCodexCooldownMs('30', 'Rate limit exceeded'), 30_000);
});

test('computeCodexCooldownMs clamps zero, negative, and garbage retry-after to min', () => {
  assert.equal(computeCodexCooldownMs('0', 'Rate limit exceeded'), 1_000);
  assert.equal(computeCodexCooldownMs('-5', 'Rate limit exceeded'), 1_000);
  assert.equal(computeCodexCooldownMs('nonsense', 'Rate limit exceeded'), 1_000);
});

test('computeCodexCooldownMs clamps huge retry-after to max', () => {
  assert.equal(computeCodexCooldownMs('99999', 'Rate limit exceeded'), 6 * 60 * 60 * 1000);
});

test('computeCodexCooldownMs honors retry-after HTTP-date', () => {
  const targetMs = Date.now() + 60_000;
  const cooldownMs = computeCodexCooldownMs(new Date(targetMs).toUTCString(), 'Rate limit exceeded');
  assert.ok(cooldownMs >= 58_000 && cooldownMs <= 60_000, `expected ~60000ms, got ${cooldownMs}`);
});

test('computeCodexCooldownMs uses long cooldown for quota exhaustion without retry-after', () => {
  assert.equal(computeCodexCooldownMs(null, "You've hit your usage limit"), 900_000);
});

test('computeCodexCooldownMs uses short cooldown for burst rate limit without retry-after', () => {
  assert.equal(computeCodexCooldownMs(null, 'Rate limit exceeded, too many requests'), 45_000);
});

test('classifyCodexUpstreamError marks quota-exhausted 429s', () => {
  const cls = classifyCodexUpstreamError(429, "You've hit your usage limit");
  assert.equal(cls.kind, 'rate_limit');
  assert.equal(cls.retryable, true);
  assert.equal(cls.quotaExhausted, true);
});

test('classifyCodexUpstreamError marks burst 429s as non-quota rate limits', () => {
  const cls = classifyCodexUpstreamError(429, 'Rate limit exceeded, too many requests');
  assert.equal(cls.kind, 'rate_limit');
  assert.equal(cls.retryable, true);
  assert.equal(cls.quotaExhausted, false);
});
