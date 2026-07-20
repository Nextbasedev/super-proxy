import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import admin from 'firebase-admin';
import { config } from '../config.js';
import { getDb } from '../db/index.js';

/** Dashboard session cookie name (neutral OSS branding). */
export const SESSION_COOKIE = 'sp_session';
const SESSION_MAX_AGE_SEC = 7 * 24 * 3600;

function firebaseConfigured(): boolean {
  return Boolean(config.firebaseProjectId && config.firebaseProjectId.trim());
}

function initFirebase(): boolean {
  if (!firebaseConfigured()) return false;
  if (admin.apps.length) return true;
  admin.initializeApp({ projectId: config.firebaseProjectId });
  return true;
}

function secret(): string {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  // Deterministic fallback for local/dev only. Prefer SESSION_SECRET in production.
  return crypto.createHash('sha256').update(`${config.adminEmail}:super-proxy-session`).digest('hex');
}

function sign(email: string, ts: number): string {
  return crypto.createHmac('sha256', secret()).update(`${email}:${ts}`).digest('hex').slice(0, 48);
}

function createSession(email: string): string {
  const ts = Math.floor(Date.now() / 1000);
  return `${email}:${ts}:${sign(email, ts)}`;
}

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function verifyDashboardSessionToken(token?: string): string | null {
  if (!token) return null;
  const parts = token.split(':');
  if (parts.length !== 3) return null;
  const [email, tsRaw, sig] = parts;
  const ts = Number(tsRaw);
  if (!email || !Number.isFinite(ts)) return null;
  if (Date.now() / 1000 - ts > SESSION_MAX_AGE_SEC) return null;
  if (!safeEqualHex(sig, sign(email, ts))) return null;
  return email;
}

export function getDashboardUser(req: FastifyRequest): { id: number; email: string; role: string; isAdmin: boolean } | null {
  const email = verifyDashboardSessionToken((req.cookies as any)?.[SESSION_COOKIE]);
  if (!email) return null;
  const row = getDb().prepare('SELECT id,email,role,is_admin,enabled FROM users WHERE email = ?').get(email) as any;
  if (!row?.enabled) return null;
  return { id: row.id, email: row.email, role: row.role, isAdmin: !!row.is_admin || row.role === 'admin' };
}

export function requireDashboardAdmin(req: FastifyRequest, reply: FastifyReply): { id: number; email: string; role: string; isAdmin: boolean } | null {
  const user = getDashboardUser(req);
  if (user?.isAdmin) return user;
  const key = process.env.DEV_ADMIN_KEY;
  if (key && req.headers['x-admin-key'] === key) return { id: 0, email: 'dev-admin', role: 'admin', isAdmin: true };
  reply.code(403).send({ error: 'Forbidden' });
  return null;
}

function emptyFirebaseWebConfig() {
  return {
    apiKey: '',
    authDomain: '',
    projectId: '',
    storageBucket: '',
    messagingSenderId: '',
    appId: '',
  };
}

export function registerDashboardAuthRoutes(app: FastifyInstance) {
  app.get('/api/config', async () => {
    // Firebase web config is optional. Self-host deployments typically use API tokens only.
    if (!config.firebaseWebConfig) {
      return { firebase: emptyFirebaseWebConfig(), auth: { firebaseEnabled: firebaseConfigured() } };
    }
    try {
      return { firebase: JSON.parse(config.firebaseWebConfig), auth: { firebaseEnabled: firebaseConfigured() } };
    } catch {
      return { firebase: emptyFirebaseWebConfig(), auth: { firebaseEnabled: false } };
    }
  });

  app.post('/api/auth/verify', async (req, reply) => {
    if (!firebaseConfigured()) {
      reply.code(503).send({
        error: 'Firebase auth is not configured. Set FIREBASE_PROJECT_ID (and optionally FIREBASE_WEB_CONFIG), or use API token auth.',
      });
      return;
    }
    const body = (req.body || {}) as { idToken?: string };
    if (!body.idToken) { reply.code(400).send({ error: 'Missing idToken' }); return; }
    if (!initFirebase()) {
      reply.code(503).send({ error: 'Firebase auth is not configured' });
      return;
    }
    let decoded: admin.auth.DecodedIdToken;
    try {
      decoded = await admin.auth().verifyIdToken(body.idToken);
    } catch (err: any) {
      reply.code(401).send({ error: `Invalid token: ${String(err?.message || err).slice(0, 120)}` });
      return;
    }
    const email = String(decoded.email || '').toLowerCase();
    if (!email) { reply.code(401).send({ error: 'Missing email' }); return; }
    const db = getDb();
    let user = db.prepare('SELECT id,email,role,is_admin,enabled FROM users WHERE email = ?').get(email) as any;
    if (!user) {
      // Only bootstrap the configured admin automatically. Everyone else must be created via admin API.
      if (email !== config.adminEmail.toLowerCase()) { reply.code(403).send({ error: 'Email not authorized' }); return; }
      const info = db.prepare('INSERT INTO users (email,name,role,is_admin,enabled) VALUES (?,?,?,?,1)').run(email, decoded.name || null, 'admin', 1);
      user = { id: info.lastInsertRowid, email, role: 'admin', is_admin: 1, enabled: 1 };
    }
    if (!user.enabled) { reply.code(403).send({ error: 'User disabled' }); return; }
    const isAdmin = !!user.is_admin || user.role === 'admin';
    reply.setCookie(SESSION_COOKIE, createSession(email), { httpOnly: true, secure: config.nodeEnv === 'production', sameSite: 'lax', path: '/', maxAge: SESSION_MAX_AGE_SEC });
    return { email, role: user.role, isAdmin };
  });

  app.get('/api/auth/me', async (req, reply) => {
    const user = getDashboardUser(req);
    if (!user) { reply.code(401).send({ error: 'Not authenticated' }); return; }
    // monitorAccess: read-only /admin/metrics/* via MONITOR_ACCESS_EMAILS (optional).
    const monitorAccess = user.isAdmin || config.monitorAccessEmails.has(user.email.toLowerCase());
    return { email: user.email, role: user.role, isAdmin: user.isAdmin, monitorAccess };
  });

  app.post('/api/auth/logout', async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
}
