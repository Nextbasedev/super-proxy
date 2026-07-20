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

function joinedPattern(...parts: string[]): RegExp {
  return new RegExp(parts.join(''), 'i');
}

test('dashboard assets ship in public/', () => {
  assert.ok(fs.existsSync(indexHtml), 'public/index.html');
  assert.ok(fs.existsSync(consoleJs), 'public/console.js');
  assert.ok(fs.existsSync(consoleCss), 'public/console.css');
});

test('dashboard is neutral and contains no deployment-specific setup', () => {
  const bodies = [
    fs.readFileSync(consoleJs, 'utf8'),
    fs.readFileSync(indexHtml, 'utf8'),
  ];
  const forbidden = [
    joinedPattern('next', 'base'),
    joinedPattern('oc', 'platform'),
    joinedPattern('open', 'claw'),
    joinedPattern('am', 'pere'),
    joinedPattern('/api/', 'internal/oc/'),
    joinedPattern('aside_', 'gateways'),
    joinedPattern('oc-', 'fleet'),
  ];
  for (const body of bodies) {
    for (const marker of forbidden) assert.doesNotMatch(body, marker);
  }
});

test('dashboard presents Super Proxy branding', () => {
  const html = fs.readFileSync(indexHtml, 'utf8');
  assert.match(html, /Super Proxy|super-proxy|Gateway/i);
});
