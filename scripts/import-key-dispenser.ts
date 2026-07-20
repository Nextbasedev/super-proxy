import fs from 'node:fs';
import path from 'node:path';
import { migrate } from '../src/db/migrate.js';
import { getDb } from '../src/db/index.js';

const source = process.argv[2] || '/root/.openclaw/workspace/projects/key-dispenser/keys.json';
if (!fs.existsSync(source)) throw new Error(`Source not found: ${source}`);
migrate();
const keys = JSON.parse(fs.readFileSync(source, 'utf8')) as Array<{ key: string; label?: string; enabled?: boolean }>;
let count = 0;
for (const [i, k] of keys.entries()) {
  if (!k.key) continue;
  const label = k.label || `imported-${i + 1}`;
  const exists = getDb().prepare('SELECT id FROM provider_accounts WHERE provider = ? AND label = ?').get('anthropic', label);
  if (exists) continue;
  getDb().prepare('INSERT INTO provider_accounts (provider,label,secret,enabled,notes) VALUES (?,?,?,?,?)')
    .run('anthropic', label, k.key, k.enabled === false ? 0 : 1, `Imported from ${path.basename(source)}`);
  count++;
}
console.log(`Imported ${count} Anthropic accounts from ${source}`);
