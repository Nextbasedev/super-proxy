#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');

async function collect(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collect(full)));
    } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      files.push(full);
    }
  }
  return files;
}

const tests = (await collect(srcDir)).sort();
if (tests.length === 0) {
  console.error('No test files found under src/');
  process.exit(1);
}

const child = spawn(
  process.execPath,
  ['--import', 'tsx', '--test', '--test-reporter=spec', ...tests],
  { stdio: 'inherit', cwd: root, env: process.env },
);

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
