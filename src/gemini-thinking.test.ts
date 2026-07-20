import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

// resolveGeminiThinkingLevel imports gemini-pool which needs DB env set
const dbPath = path.join(os.tmpdir(), `super-proxy-gemini-thinking-${process.pid}-${Date.now()}.sqlite`);
process.env.DATABASE_PATH = dbPath;

import { resolveGeminiThinkingLevel } from './proxy/gemini.js';

// --- Gemini thinking level resolution ---

test('resolveGeminiThinkingLevel: maps reasoning_effort to Google thinkingLevel', () => {
  assert.equal(resolveGeminiThinkingLevel('low', undefined), 'LOW');
  assert.equal(resolveGeminiThinkingLevel('medium', undefined), 'MEDIUM');
  assert.equal(resolveGeminiThinkingLevel('high', undefined), 'HIGH');
  assert.equal(resolveGeminiThinkingLevel('xhigh', undefined), 'HIGH');
  assert.equal(resolveGeminiThinkingLevel('minimal', undefined), 'LOW');
  assert.equal(resolveGeminiThinkingLevel('adaptive', undefined), 'MEDIUM');
});

test('resolveGeminiThinkingLevel: none/off disables thinking', () => {
  assert.equal(resolveGeminiThinkingLevel('none', undefined), undefined);
  assert.equal(resolveGeminiThinkingLevel('off', undefined), undefined);
});

test('resolveGeminiThinkingLevel: empty/missing returns undefined', () => {
  assert.equal(resolveGeminiThinkingLevel(undefined, undefined), undefined);
  assert.equal(resolveGeminiThinkingLevel('', undefined), undefined);
});

test('resolveGeminiThinkingLevel: header fallback works when reasoning_effort is absent', () => {
  assert.equal(resolveGeminiThinkingLevel(undefined, 'HIGH'), 'HIGH');
  assert.equal(resolveGeminiThinkingLevel(undefined, 'low'), 'LOW');
});

test('resolveGeminiThinkingLevel: reasoning_effort takes precedence over header', () => {
  assert.equal(resolveGeminiThinkingLevel('high', 'low'), 'HIGH');
  assert.equal(resolveGeminiThinkingLevel('low', 'high'), 'LOW');
});

test('resolveGeminiThinkingLevel: case-insensitive', () => {
  assert.equal(resolveGeminiThinkingLevel('HIGH', undefined), 'HIGH');
  assert.equal(resolveGeminiThinkingLevel('Medium', undefined), 'MEDIUM');
  assert.equal(resolveGeminiThinkingLevel('LOW', undefined), 'LOW');
});

test('resolveGeminiThinkingLevel: unknown values return undefined', () => {
  assert.equal(resolveGeminiThinkingLevel('turbo', undefined), undefined);
  assert.equal(resolveGeminiThinkingLevel('max', undefined), undefined);
});
