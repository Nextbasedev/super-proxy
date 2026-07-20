import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

process.env.NODE_ENV = 'development';
process.env.ADMIN_EMAIL = 'admin@example.test';
delete process.env.SESSION_SECRET;
delete process.env.DEV_ADMIN_KEY;

const {
  preflightDashboardAuth,
  requireDashboardAdmin,
  verifyDashboardSessionToken,
} = await import('./dashboard-auth.js');

function productionStartup(sessionSecret?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production', PORT: '0' };
  delete env.SESSION_SECRET;
  delete env.DEV_ADMIN_KEY;
  if (sessionSecret !== undefined) env.SESSION_SECRET = sessionSecret;

  return spawnSync(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    timeout: 5_000,
  });
}

function productionPreflight(sessionSecret: string) {
  return spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      "const auth = await import('./src/auth/dashboard-auth.ts'); auth.preflightDashboardAuth();",
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, NODE_ENV: 'production', SESSION_SECRET: sessionSecret },
      encoding: 'utf8',
      timeout: 5_000,
    },
  );
}

test('production startup fails closed when SESSION_SECRET is missing', () => {
  const result = productionStartup();

  assert.notEqual(result.status, 0, 'server unexpectedly started without SESSION_SECRET');
  assert.match(`${result.stderr}\n${result.stdout}`, /SESSION_SECRET.*at least 32 bytes/i);
  assert.notEqual(result.signal, 'SIGTERM', 'server reached listen instead of failing preflight');
});

test('production startup rejects a weak SESSION_SECRET', () => {
  const result = productionStartup('predictable');

  assert.notEqual(result.status, 0, 'server unexpectedly started with a weak SESSION_SECRET');
  assert.match(`${result.stderr}\n${result.stdout}`, /SESSION_SECRET.*at least 32 bytes/i);
  assert.notEqual(result.signal, 'SIGTERM', 'server reached listen instead of failing preflight');
});

test('production preflight accepts an explicitly configured strong SESSION_SECRET', () => {
  const result = productionPreflight('0123456789abcdef0123456789abcdef');

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
});

test('development uses one ephemeral secret, warns once, and rejects the old predictable forgery', () => {
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));
  try {
    preflightDashboardAuth();
    preflightDashboardAuth();
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ephemeral.*SESSION_SECRET/i);

  const email = process.env.ADMIN_EMAIL!;
  const timestamp = Math.floor(Date.now() / 1000);
  const oldFallback = crypto
    .createHash('sha256')
    .update(`${email}:super-proxy-session`)
    .digest('hex');
  const forgedSignature = crypto
    .createHmac('sha256', oldFallback)
    .update(`${email}:${timestamp}`)
    .digest('hex')
    .slice(0, 48);

  assert.equal(verifyDashboardSessionToken(`${email}:${timestamp}:${forgedSignature}`), null);
});

test('an explicitly configured strong SESSION_SECRET still verifies dashboard sessions', () => {
  const originalSecret = process.env.SESSION_SECRET;
  const configuredSecret = '0123456789abcdef0123456789abcdef';
  process.env.SESSION_SECRET = configuredSecret;
  try {
    preflightDashboardAuth();
    const email = 'firebase-user@example.test';
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = crypto
      .createHmac('sha256', configuredSecret)
      .update(`${email}:${timestamp}`)
      .digest('hex')
      .slice(0, 48);

    assert.equal(
      verifyDashboardSessionToken(`${email}:${timestamp}:${signature}`),
      email,
    );
  } finally {
    if (originalSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = originalSecret;
  }
});

test('DEV_ADMIN_KEY grants bootstrap admin access only when explicitly configured', () => {
  const request = { cookies: {}, headers: { 'x-admin-key': 'explicit-admin-key' } } as any;
  const replies: Array<{ status?: number; payload?: unknown }> = [];
  const reply = {
    code(status: number) {
      replies.push({ status });
      return this;
    },
    send(payload: unknown) {
      replies.at(-1)!.payload = payload;
      return this;
    },
  } as any;

  delete process.env.DEV_ADMIN_KEY;
  assert.equal(requireDashboardAdmin(request, reply), null);
  assert.equal(replies.at(-1)?.status, 403);

  process.env.DEV_ADMIN_KEY = 'explicit-admin-key';
  try {
    assert.deepEqual(requireDashboardAdmin(request, reply), {
      id: 0,
      email: 'dev-admin',
      role: 'admin',
      isAdmin: true,
    });
  } finally {
    delete process.env.DEV_ADMIN_KEY;
  }
});
