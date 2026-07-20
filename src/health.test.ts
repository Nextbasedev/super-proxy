import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';

process.env.DATABASE_PATH = path.join(os.tmpdir(), `nbmg-health-${process.pid}.sqlite`);

const { getDb } = await import('./db/index.js');
const { migrate, LATEST_SCHEMA_MIGRATION_VERSION } = await import('./db/migrate.js');
const { registerHealthRoutes } = await import('./admin/health.js');

migrate();

async function healthApp() {
  const app = Fastify({ logger: false });
  registerHealthRoutes(app);
  return app;
}

test('/health returns ok when DB is queryable and latest migration is present', async () => {
  const app = await healthApp();
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().ok, true);
  assert.equal(res.json().migration, LATEST_SCHEMA_MIGRATION_VERSION);
  await app.close();
});

test('/health returns 503 when latest migration is missing', async () => {
  getDb().prepare('DELETE FROM schema_migrations WHERE version = ?').run(LATEST_SCHEMA_MIGRATION_VERSION);
  const app = await healthApp();
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 503, res.body);
  assert.equal(res.json().ok, false);
  assert.equal(res.json().expectedMigration, LATEST_SCHEMA_MIGRATION_VERSION);
  await app.close();
  getDb().prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(LATEST_SCHEMA_MIGRATION_VERSION);
});
