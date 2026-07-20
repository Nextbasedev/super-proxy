import type { FastifyInstance } from 'fastify';

/** Minimal plugin contract for optional gateway features. */
export interface GatewayPlugin {
  name: string;
  register(app: FastifyInstance): void | Promise<void>;
}

/** Upstream model provider adapter. */
export interface ProviderAdapter {
  id: string;
  /** Logical provider key used in routing/usage, e.g. "anthropic" | "openai". */
  provider: string;
}

/** Authentication backend for API tokens / dashboard principals. */
export interface AuthProvider {
  name: string;
}

/** Secret material source (env, file, vault, etc.). */
export interface SecretStore {
  name: string;
  get(key: string): Promise<string | undefined> | string | undefined;
}

export class EnvSecretStore implements SecretStore {
  name = 'env';
  get(key: string): string | undefined {
    const value = process.env[key];
    return value === undefined || value === '' ? undefined : value;
  }
}
