/**
 * Secret material sources for self-host deployments.
 * Default implementation reads process.env; swap in vault/file stores via plugins.
 */
export type { SecretStore } from '../plugins/types.js';
export { EnvSecretStore } from '../plugins/types.js';

import { EnvSecretStore, type SecretStore } from '../plugins/types.js';

let active: SecretStore = new EnvSecretStore();

/** Replace the process-wide secret store (e.g. during plugin bootstrap). */
export function setSecretStore(store: SecretStore): void {
  active = store;
}

export function getSecretStore(): SecretStore {
  return active;
}

/** Convenience: resolve a secret key from the active store. */
export async function getSecret(key: string): Promise<string | undefined> {
  return active.get(key);
}
