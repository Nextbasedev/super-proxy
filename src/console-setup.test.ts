import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const consoleJs = fs.readFileSync('public/console.js', 'utf8');

test('Setup tab surfaces Aside client endpoints and keeps Mac endpoints internal', () => {
  assert.match(consoleJs, /id: 'aside'\s*,\s*label: 'Aside'/);
  assert.match(consoleJs, /POST \$\{baseUrl\}\/api\/internal\/oc\/aside\/task/);
  assert.match(consoleJs, /\$\{baseUrl\}\/api\/internal\/oc\/aside\/mcp/);
  assert.match(consoleJs, /Authorization: Bearer \$\{token\}/);
  assert.match(consoleJs, /"prompt": "Describe the browser task to run in your assigned Aside profile\."/);
  assert.match(consoleJs, /"timeoutMs": 600000/);
  assert.match(consoleJs, /Do not call Mac gateway URLs directly from clients\./);
  assert.match(consoleJs, /\/v1\/profiles\/:label\/tasks/);
  assert.match(consoleJs, /stored gateway service tokens/);
});

test('Kimi setup templates consistently expose K3 in Hermes, OCPlatform, and the one-shot installer', () => {
  assert.match(consoleJs, /name: 'nextbase-kimi'[\s\S]*?model: 'k3'[\s\S]*?models: \['k3', 'kimi-k2\.7-code', 'kimi-k2\.6', 'kimi-for-coding'\]/);
  assert.equal((consoleJs.match(/\{ "id": "k3", "name": "Kimi K3" \}/g) || []).length, 2);
  assert.match(consoleJs, /"model":"k3","reasoning_effort":"max"/);
  assert.match(consoleJs, /const kimi = \{ baseUrl: baseUrl \+ '\/v1\/kimi', apiKey: token, models: \[\{ id: 'k3', name: 'Kimi K3' \}/);
});
