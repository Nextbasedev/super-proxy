import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, '../public');
const consoleJs = path.join(publicDir, 'console.js');
const consoleCss = path.join(publicDir, 'console.css');
const indexHtml = path.join(publicDir, 'index.html');

test('dashboard assets ship in public/', () => {
  assert.ok(fs.existsSync(indexHtml), 'public/index.html');
  assert.ok(fs.existsSync(consoleJs), 'public/console.js');
  assert.ok(fs.existsSync(consoleCss), 'public/console.css');
});

test('dashboard has no private control-plane endpoints', () => {
  const src = fs.readFileSync(consoleJs, 'utf8');
  const html = fs.readFileSync(indexHtml, 'utf8');
  for (const body of [src, html]) {
    assert.doesNotMatch(body, /\/api\/internal\/oc\/aside\//);
    assert.doesNotMatch(body, /aside_gateways/);
    assert.doesNotMatch(body, /oc-fleet/i);
    assert.doesNotMatch(body, /infinitycorp\.tech/i);
    assert.doesNotMatch(body, /daxitdon/i);
  }
});

test('dashboard presents Super Proxy branding', () => {
  const html = fs.readFileSync(indexHtml, 'utf8');
  assert.match(html, /Super Proxy|super-proxy|Gateway/i);
});
