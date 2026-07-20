import type { FastifyReply, FastifyRequest } from 'fastify';
import { getDb } from '../db/index.js';
import { sha256 } from '../utils/crypto.js';

export interface AuthContext {
  user: {
    id: number;
    email: string;
    role: 'admin' | 'founder' | 'developer' | 'member';
    isAdmin: boolean;
    compressionEnabled: boolean;
  };
  token: {
    id: number;
    label: string;
    prefix: string;
  };
}

function headerValue(req: FastifyRequest, name: string): string | null {
  const value = req.headers[name.toLowerCase()];
  if (!value) return null;
  return (Array.isArray(value) ? value[0] : value).trim() || null;
}

export function getProxyToken(req: FastifyRequest): string | null {
  const authorization = headerValue(req, 'authorization');
  if (authorization) {
    const bearer = authorization.match(/^Bearer\s+(.+)$/i);
    if (bearer?.[1]?.trim()) return bearer[1].trim();
    // Some OpenAI-compatible clients can only set an api-key-like value in the
    // Authorization header and do not include the Bearer scheme.
    if (!/^Basic\s+/i.test(authorization)) return authorization;
  }
  return headerValue(req, 'x-api-key') || headerValue(req, 'api-key') || headerValue(req, 'apikey');
}

async function getProxyAuthContext(req: FastifyRequest): Promise<AuthContext | null> {
  const token = getProxyToken(req);
  if (!token) return null;

  const db = getDb();
  const row = db.prepare(`
    SELECT
      t.id token_id, t.label token_label, t.token_prefix, t.enabled token_enabled,
      u.id user_id, u.email, u.role, u.enabled user_enabled, u.is_admin, u.compression_enabled
    FROM api_tokens t
    JOIN users u ON u.id = t.user_id
    WHERE t.token_hash = ?
  `).get(sha256(token)) as any;

  if (!row || !row.token_enabled || !row.user_enabled) return null;

  db.prepare('UPDATE api_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.token_id);

  return {
    user: { id: row.user_id, email: row.email, role: row.role, isAdmin: !!row.is_admin, compressionEnabled: row.compression_enabled !== 0 },
    token: { id: row.token_id, label: row.token_label, prefix: row.token_prefix },
  };
}

// Resolve an AuthContext from a raw bearer/api-key string. Used by the Gemini
// Live WebSocket relay, where browsers cannot set Authorization headers and pass
// the token via the `access_token`/`token` query param or the `authorization`
// query value instead.
export function authContextFromToken(token: string | null | undefined): AuthContext | null {
  const t = (token || '').trim();
  if (!t) return null;
  const db = getDb();
  const row = db.prepare(`
    SELECT
      t.id token_id, t.label token_label, t.token_prefix, t.enabled token_enabled,
      u.id user_id, u.email, u.role, u.enabled user_enabled, u.is_admin, u.compression_enabled
    FROM api_tokens t
    JOIN users u ON u.id = t.user_id
    WHERE t.token_hash = ?
  `).get(sha256(t)) as any;
  if (!row || !row.token_enabled || !row.user_enabled) return null;
  db.prepare('UPDATE api_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.token_id);
  return {
    user: { id: row.user_id, email: row.email, role: row.role, isAdmin: !!row.is_admin, compressionEnabled: row.compression_enabled !== 0 },
    token: { id: row.token_id, label: row.token_label, prefix: row.token_prefix },
  };
}

export async function requireProxyToken(req: FastifyRequest, reply: FastifyReply): Promise<AuthContext | null> {
  const auth = await getProxyAuthContext(req);
  if (!auth) {
    reply.code(401).send({ type: 'error', error: { type: 'authentication_error', message: 'Missing, invalid, or disabled API token' } });
    return null;
  }
  return auth;
}
