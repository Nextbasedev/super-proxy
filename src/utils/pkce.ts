import crypto from 'node:crypto';

export interface PkceEntry { state: string; ownerKey: string; codeVerifier: string; createdAt: number }
const flows = new Map<string, PkceEntry>();

function b64url(buf: Buffer): string { return buf.toString('base64url'); }

export function startPkce(ownerKey: string): { state: string; codeChallenge: string; createdAt: number } {
  cleanupPkce();
  const state = b64url(crypto.randomBytes(24));
  const codeVerifier = b64url(crypto.randomBytes(48));
  const codeChallenge = b64url(crypto.createHash('sha256').update(codeVerifier).digest());
  const createdAt = Date.now();
  flows.set(state, { state, ownerKey, codeVerifier, createdAt });
  return { state, codeChallenge, createdAt };
}

export function consumePkce(state: string, ownerKey: string, ttlMs = 10 * 60_000): PkceEntry | null {
  cleanupPkce(ttlMs);
  const entry = flows.get(state);
  if (!entry || entry.ownerKey !== ownerKey || Date.now() - entry.createdAt > ttlMs) return null;
  flows.delete(state);
  return entry;
}

export function cleanupPkce(ttlMs = 10 * 60_000): void {
  const now = Date.now();
  for (const [state, entry] of flows) if (now - entry.createdAt > ttlMs) flows.delete(state);
}

export function parseOAuthCodeAndState(input: string, fallbackState?: string): { code: string; state: string } {
  const raw = input.trim();
  try {
    const url = new URL(raw);
    return { code: url.searchParams.get('code') || raw, state: url.searchParams.get('state') || fallbackState || '' };
  } catch {}
  return { code: raw, state: fallbackState || '' };
}
