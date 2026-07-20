import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/index.js';
import { LATEST_SCHEMA_MIGRATION_VERSION } from '../db/migrate.js';

export function registerHealthRoutes(app: FastifyInstance) {
  app.get('/health', async (_req, reply) => {
    try {
      const db = getDb();
      db.prepare('SELECT 1').get();
      const row = db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get() as { version: number };
      const latest = db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(LATEST_SCHEMA_MIGRATION_VERSION);
      if (!latest) {
        reply.code(503);
        return { ok: false, service: 'model-gateway', db: 'migrations_pending', expectedMigration: LATEST_SCHEMA_MIGRATION_VERSION, actualMigration: row.version || 0, ts: new Date().toISOString() };
      }
      return { ok: true, service: 'model-gateway', db: 'ok', migration: LATEST_SCHEMA_MIGRATION_VERSION, ts: new Date().toISOString() };
    } catch (err: any) {
      reply.code(503);
      return { ok: false, service: 'model-gateway', db: 'unavailable', error: String(err?.message || err), ts: new Date().toISOString() };
    }
  });
}
