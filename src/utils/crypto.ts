import crypto from 'node:crypto';
import { nanoid } from 'nanoid';

export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function createProxyToken(): { raw: string; hash: string; prefix: string } {
  const raw = `sp_${nanoid(48)}`;
  return { raw, hash: sha256(raw), prefix: raw.slice(0, 14) };
}

export function maskSecret(secret: string): string {
  if (secret.length < 16) return '***';
  return `${secret.slice(0, 8)}...${secret.slice(-4)}`;
}
