import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

// Fresh DB for this suite.
const dbPath = path.join(os.tmpdir(), `super-proxy-monitoring-${process.pid}-${Date.now()}.sqlite`);
process.env.DATABASE_PATH = dbPath;
process.env.DEV_ADMIN_KEY = 'test-admin';

const { migrate } = await import('./db/migrate.js');
const { getDb } = await import('./db/index.js');
const { recordUsage, billingModeFor } = await import('./proxy/usage.js');
const { getRates, estimateCost } = await import('./proxy/cost.js');

migrate();

function seedUserAndToken(): { userId: number; tokenId: number } {
  const db = getDb();
  const u = db.prepare(`INSERT INTO users (email, name, role) VALUES ('mon-test@test.dev', 'Mon Test', 'member')`).run();
  const t = db.prepare(`INSERT INTO api_tokens (user_id, label, token_hash, token_prefix) VALUES (?, 'mon-token', 'hash-x', 'mgw_test')`).run(Number(u.lastInsertRowid));
  return { userId: Number(u.lastInsertRowid), tokenId: Number(t.lastInsertRowid) };
}

const ids = seedUserAndToken();

// ─── Migration ──────────────────────────────────────────────────────────────

test('migration adds monitoring columns to usage_events', () => {
  const cols = getDb().prepare(`PRAGMA table_info(usage_events)`).all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  for (const col of ['reasoning_tokens', 'ttft_ms', 'retry_count', 'retry_reason', 'unit', 'billing_mode']) {
    assert.ok(names.has(col), `missing column ${col}`);
  }
});

test('migration creates monitoring indexes', () => {
  const idx = getDb().prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='usage_events'`).all() as Array<{ name: string }>;
  const names = new Set(idx.map((i) => i.name));
  for (const name of ['idx_usage_events_created', 'idx_usage_events_provider_created', 'idx_usage_events_user_created']) {
    assert.ok(names.has(name), `missing index ${name}`);
  }
});

test('migration is idempotent (re-run adds nothing and does not throw)', () => {
  migrate();
  const cols = getDb().prepare(`PRAGMA table_info(usage_events)`).all() as Array<{ name: string }>;
  const reasoningCols = cols.filter((c: any) => c.name === 'reasoning_tokens');
  assert.equal(reasoningCols.length, 1);
});

// ─── billing mode derivation ────────────────────────────────────────────────

test('billing modes: subscriptions vs metered vs self-hosted vs free', () => {
  assert.equal(billingModeFor('anthropic'), 'flat_fee');
  assert.equal(billingModeFor('openai_codex'), 'flat_fee');
  assert.equal(billingModeFor('kimi'), 'flat_fee');
  assert.equal(billingModeFor('glm'), 'flat_fee');
  assert.equal(billingModeFor('xai'), 'flat_fee');
  assert.equal(billingModeFor('runpod'), 'self_hosted');
  assert.equal(billingModeFor('fish'), 'free_tier');
  assert.equal(billingModeFor('gemini'), 'metered');
  assert.equal(billingModeFor('openrouter'), 'metered');
  assert.equal(billingModeFor('groq'), 'metered');
  assert.equal(billingModeFor('cerebras'), 'metered');
  assert.equal(billingModeFor('deepgram'), 'metered');
  assert.equal(billingModeFor('unknown-future-provider'), 'metered');
});

// ─── recordUsage new fields ─────────────────────────────────────────────────

test('recordUsage persists all monitoring fields', () => {
  const id = recordUsage({
    userId: ids.userId, tokenId: ids.tokenId, provider: 'anthropic', endpoint: '/v1/messages',
    model: 'claude-sonnet-4-6', stream: true, statusCode: 200,
    inputTokens: 100, outputTokens: 50, cacheCreationTokens: 10, cacheReadTokens: 500,
    reasoningTokens: 20, ttftMs: 350, retryCount: 2, retryReason: 'rate_limited',
    estimatedCostUsd: 0.01, latencyMs: 1200,
  });
  const row = getDb().prepare('SELECT * FROM usage_events WHERE id = ?').get(id) as any;
  assert.equal(row.reasoning_tokens, 20);
  assert.equal(row.ttft_ms, 350);
  assert.equal(row.retry_count, 2);
  assert.equal(row.retry_reason, 'rate_limited');
  assert.equal(row.unit, null); // tokens default
  assert.equal(row.billing_mode, 'flat_fee'); // anthropic derived
});

test('recordUsage derives billing_mode from provider when not passed', () => {
  const idA = recordUsage({ userId: ids.userId, tokenId: ids.tokenId, provider: 'gemini', endpoint: '/e' });
  const idB = recordUsage({ userId: ids.userId, tokenId: ids.tokenId, provider: 'runpod', endpoint: '/e' });
  const a = getDb().prepare('SELECT billing_mode FROM usage_events WHERE id = ?').get(idA) as any;
  const b = getDb().prepare('SELECT billing_mode FROM usage_events WHERE id = ?').get(idB) as any;
  assert.equal(a.billing_mode, 'metered');
  assert.equal(b.billing_mode, 'self_hosted');
});

test('recordUsage stores unit for non-token usage', () => {
  const id = recordUsage({
    userId: ids.userId, tokenId: ids.tokenId, provider: 'deepgram', endpoint: '/v1/deepgram/listen',
    inputTokens: 93, unit: 'seconds',
  });
  const row = getDb().prepare('SELECT unit, input_tokens FROM usage_events WHERE id = ?').get(id) as any;
  assert.equal(row.unit, 'seconds');
  assert.equal(row.input_tokens, 93);
});

test('recordUsage omits retry_reason when retryCount is 0/absent', () => {
  const id = recordUsage({
    userId: ids.userId, tokenId: ids.tokenId, provider: 'kimi', endpoint: '/e',
    retryCount: 0, retryReason: 'account_rotation',
  });
  const row = getDb().prepare('SELECT retry_count, retry_reason FROM usage_events WHERE id = ?').get(id) as any;
  assert.equal(row.retry_count, null);
  assert.equal(row.retry_reason, null);
});

test('recordUsage degrades malformed numeric values to NULL, never throws', () => {
  const id = recordUsage({
    userId: ids.userId, tokenId: ids.tokenId, provider: 'glm', endpoint: '/e',
    reasoningTokens: NaN as any, ttftMs: Infinity as any,
  });
  const row = getDb().prepare('SELECT reasoning_tokens, ttft_ms FROM usage_events WHERE id = ?').get(id) as any;
  assert.equal(row.reasoning_tokens, null);
  assert.equal(row.ttft_ms, null);
});

// ─── getRates single source of truth ────────────────────────────────────────

test('getRates returns anthropic-class rates with cache pricing', () => {
  const r = getRates('anthropic', 'claude-fable-5');
  assert.ok(r);
  assert.equal(r!.input, 10 / 1_000_000);
  assert.equal(r!.output, 50 / 1_000_000);
  assert.equal(r!.cacheWrite, 12.5 / 1_000_000);
  assert.equal(r!.cacheRead, 1.0 / 1_000_000);
});

test('getRates kimi models include cacheRead', () => {
  const r = getRates('kimi', 'kimi-k2.7-code');
  assert.ok(r);
  assert.equal(r!.cacheRead, 0.19 / 1_000_000);
  // unknown model falls back to default, not null
  assert.ok(getRates('kimi', 'kimi-mystery'));
});

test('getRates returns null for providers without per-token pricing', () => {
  assert.equal(getRates('groq', 'openai/gpt-oss-120b'), null);
  assert.equal(getRates('cerebras', 'gpt-oss-120b'), null);
  assert.equal(getRates('fish', 's2.1-pro-free'), null);
  assert.equal(getRates('deepgram', 'nova-3'), null);
  assert.equal(getRates('xai', 'grok-4'), null); // no retail row for non-4.5 grok text
  assert.equal(getRates('runpod', 'qwen36-27b'), null);
  assert.equal(getRates('fusion', 'max'), null);
  assert.equal(getRates('openrouter', 'tencent/hy3:free'), null);
});

test('getRates now returns retail rates for glm/xai-4.5/codex (notional pools)', () => {
  assert.ok(getRates('glm', 'glm-5'), 'glm-5 priced');
  assert.ok(getRates('glm', 'glm-4.6'), 'glm-4.6 priced');
  assert.ok(getRates('xai', 'grok-4.5'), 'grok-4.5 priced');
  assert.ok(getRates('openai_codex', 'gpt-5.5'), 'gpt-5.5 priced');
  assert.ok(getRates('openai_codex', 'gpt-5.6-sol'), 'gpt-5.6-sol priced');
});

test('getRates gemini/openrouter model-family mapping', () => {
  assert.equal(getRates('openrouter', 'google/gemini-2.5-flash-lite')!.input, 0.1 / 1_000_000);
  assert.equal(getRates('openrouter', 'google/gemini-2.5-flash')!.input, 0.3 / 1_000_000);
  assert.equal(getRates('openrouter', 'google/gemini-3.5-flash')!.input, 1.5 / 1_000_000);
  assert.equal(getRates('openrouter', 'google/gemini-2.5-pro')!.input, 1.25 / 1_000_000);
  assert.equal(getRates('gemini', 'gemini-2.5-flash')!.input, 0.3 / 1_000_000);
});

test('estimateCost behavior unchanged after getRates refactor', () => {
  // Spot-check the exact cases from cost.test.ts still hold
  const approx = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} !== ${b}`);
  approx(estimateCost('kimi-k2.6', { inputTokens: 1_000_000, outputTokens: 1_000_000 }, 'kimi'), 0.95 + 4.0);
  approx(estimateCost('claude-fable-5', { inputTokens: 1_000_000, outputTokens: 1_000_000 }, 'anthropic'), 60);
  assert.equal(estimateCost('any', { inputTokens: 1_000_000, outputTokens: 1_000_000 }, 'groq'), 0);
  assert.equal(estimateCost('google/gemini-2.5-flash', { inputTokens: 1_000_000, outputTokens: 0 }, 'openrouter'), 0.3);
  assert.equal(estimateCost('tencent/hy3:free', { inputTokens: 1_000_000, outputTokens: 0 }, 'openrouter'), 0);
});
