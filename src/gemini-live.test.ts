import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

// Minimal DB so importing gemini-pool (which calls getDb lazily) is safe.
const dbPath = path.join(os.tmpdir(), `mg-gemini-live-${process.pid}-${Date.now()}.sqlite`);
process.env.DATABASE_PATH = dbPath;
new Database(dbPath).exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);');

const {
  KNOWN_GEMINI_LIVE_MODELS,
  KNOWN_GEMINI_MODELS,
  geminiModelFamily,
  GEMINI_DAILY_CAPS,
} = await import('./providers/gemini-pool.js');

test('GL1 the three Live models are registered', () => {
  for (const m of [
    'gemini-2.5-flash-native-audio-preview-12-2025',
    'gemini-3.1-flash-live-preview',
    'gemini-3.5-live-translate-preview',
  ]) {
    assert.ok(KNOWN_GEMINI_LIVE_MODELS.has(m), `${m} missing from KNOWN_GEMINI_LIVE_MODELS`);
    assert.ok(KNOWN_GEMINI_MODELS.has(m), `${m} missing from KNOWN_GEMINI_MODELS`);
  }
});

test('GL2 Live models route to the live family', () => {
  assert.equal(geminiModelFamily('gemini-3.1-flash-live-preview'), 'live');
  assert.equal(geminiModelFamily('gemini-3.5-live-translate-preview'), 'live');
  assert.equal(geminiModelFamily('gemini-2.5-flash-native-audio-preview-12-2025'), 'live');
});

test('GL3 live family has a daily cap and does not steal chat/video families', () => {
  assert.ok(GEMINI_DAILY_CAPS.live > 0);
  // A non-live chat model must still resolve to its own family.
  assert.equal(geminiModelFamily('gemini-3.1-flash-lite'), 'chat');
  assert.equal(geminiModelFamily('gemini-2.5-flash'), 'chat-video');
});

test('GL4 unknown model has no family', () => {
  assert.equal(geminiModelFamily('gemini-does-not-exist'), null);
});
