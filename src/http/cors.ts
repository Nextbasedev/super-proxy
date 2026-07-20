import cors from '@fastify/cors';
import type { FastifyInstance } from 'fastify';

/**
 * Install HTTP CORS once for every route. There is currently no HTTP origin
 * allowlist setting, so this intentionally preserves the gateway's existing
 * credentialed Origin reflection and requested-header reflection behavior.
 */
export async function registerBrowserCors(app: FastifyInstance): Promise<void> {
  await app.register(cors, {
    origin: true,
    credentials: true,
  });
}
