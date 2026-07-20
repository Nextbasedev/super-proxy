import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const publicRoot = path.join(process.cwd(), 'public');

test('release does not ship client-specific setup bundles', () => {
  assert.equal(fs.existsSync(path.join(publicRoot, 'skills')), false);
});
