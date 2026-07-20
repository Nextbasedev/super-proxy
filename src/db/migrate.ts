import { getDb } from './index.js';
import { config } from '../config.js';

export const LATEST_SCHEMA_MIGRATION_VERSION = 2026071301;

function columnExists(table: string, column: string): boolean {
  return (getDb().prepare(`PRAGMA table_info(${table})`).all() as any[]).some((c) => c.name === column);
}

function addColumn(table: string, column: string, ddl: string): void {
  if (!columnExists(table, column)) getDb().exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

function providerAccountsAllowsGroq(): boolean {
  const row = getDb().prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='provider_accounts'").get() as { sql?: string } | undefined;
  return !!row?.sql?.includes("'groq'");
}

function rebuildProviderAccountsForGroq(): void {
  const db = getDb();
  db.exec(`
    PRAGMA foreign_keys=OFF;
    CREATE TABLE provider_accounts_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL CHECK(provider IN ('anthropic','openai_codex','openai','groq','kimi')),
      label TEXT NOT NULL,
      owner_email TEXT,
      secret TEXT NOT NULL,
      refresh_secret TEXT,
      account_id TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active',
      max_in_flight INTEGER,
      cooldown_until INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL DEFAULT 0,
      last_used_at INTEGER NOT NULL DEFAULT 0,
      last_refresh_at INTEGER NOT NULL DEFAULT 0,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      risk_notes TEXT,
      quota_notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO provider_accounts_new (id,provider,label,owner_email,secret,refresh_secret,account_id,enabled,status,max_in_flight,cooldown_until,expires_at,last_used_at,last_refresh_at,consecutive_failures,notes,risk_notes,quota_notes,created_at,updated_at)
    SELECT id,provider,label,owner_email,secret,refresh_secret,account_id,enabled,status,max_in_flight,cooldown_until,expires_at,last_used_at,last_refresh_at,consecutive_failures,notes,risk_notes,quota_notes,created_at,updated_at FROM provider_accounts;
    DROP TABLE provider_accounts;
    ALTER TABLE provider_accounts_new RENAME TO provider_accounts;
    PRAGMA foreign_keys=ON;
  `);
}

function providerAccountsAllowsKimi(): boolean {
  const row = getDb().prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='provider_accounts'").get() as { sql?: string } | undefined;
  return !!row?.sql?.includes("'kimi'");
}

function providerAccountsAllowsCerebras(): boolean {
  const row = getDb().prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='provider_accounts'").get() as { sql?: string } | undefined;
  return !!row?.sql?.includes("'cerebras'");
}

function providerAccountsAllowsOpenRouter(): boolean {
  const row = getDb().prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='provider_accounts'").get() as { sql?: string } | undefined;
  return !!row?.sql?.includes("'openrouter'");
}

function providerAccountsAllowsDeepgram(): boolean {
  const row = getDb().prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='provider_accounts'").get() as { sql?: string } | undefined;
  return !!row?.sql?.includes("'deepgram'");
}

function providerAccountsAllowsRunpod(): boolean {
  const row = getDb().prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='provider_accounts'").get() as { sql?: string } | undefined;
  return !!row?.sql?.includes("'runpod'");
}

function providerAccountsAllowsGemini(): boolean {
  const row = getDb().prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='provider_accounts'").get() as { sql?: string } | undefined;
  return !!row?.sql?.includes("'gemini'");
}

function providerAccountsAllowsXai(): boolean {
  const row = getDb().prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='provider_accounts'").get() as { sql?: string } | undefined;
  return !!row?.sql?.includes("'xai'");
}

function providerAccountsAllowsSerper(): boolean {
  const row = getDb().prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='provider_accounts'").get() as { sql?: string } | undefined;
  return !!row?.sql?.includes("'serper'");
}

function providerAccountsAllowsGlm(): boolean {
  const row = getDb().prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='provider_accounts'").get() as { sql?: string } | undefined;
  return !!row?.sql?.includes("'glm'");
}

function providerAccountsAllowsFish(): boolean {
  const row = getDb().prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='provider_accounts'").get() as { sql?: string } | undefined;
  return !!row?.sql?.includes("'fish'");
}

function migrationApplied(version: number): boolean {
  const row = getDb().prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(version);
  return !!row;
}

function rebuildProviderAccountsForCerebras(): void {
  const db = getDb();
  const version = 2026051501;
  if (migrationApplied(version) && providerAccountsAllowsCerebras()) return;
  if (!providerAccountsAllowsCerebras()) {
    db.exec(`
      PRAGMA foreign_keys=OFF;
      PRAGMA legacy_alter_table=ON;
      BEGIN TRANSACTION;
      ALTER TABLE provider_accounts RENAME TO provider_accounts_old;
      CREATE TABLE provider_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL CHECK(provider IN ('anthropic','openai_codex','openai','groq','cerebras','kimi')),
        label TEXT NOT NULL,
        owner_email TEXT,
        secret TEXT NOT NULL,
        refresh_secret TEXT,
        account_id TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active',
        max_in_flight INTEGER,
        cooldown_until INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER NOT NULL DEFAULT 0,
        last_used_at INTEGER NOT NULL DEFAULT 0,
        last_refresh_at INTEGER NOT NULL DEFAULT 0,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        notes TEXT,
        risk_notes TEXT,
        quota_notes TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO provider_accounts (id,provider,label,owner_email,secret,refresh_secret,account_id,enabled,status,max_in_flight,cooldown_until,expires_at,last_used_at,last_refresh_at,consecutive_failures,notes,risk_notes,quota_notes,created_at,updated_at)
      SELECT id,provider,label,owner_email,secret,refresh_secret,account_id,enabled,status,max_in_flight,cooldown_until,expires_at,last_used_at,last_refresh_at,consecutive_failures,notes,risk_notes,quota_notes,created_at,updated_at
      FROM provider_accounts_old;
      DROP TABLE provider_accounts_old;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_accounts_provider_account_id ON provider_accounts(provider, account_id) WHERE account_id IS NOT NULL AND account_id != '';
      COMMIT;
      PRAGMA legacy_alter_table=OFF;
      PRAGMA foreign_keys=ON;
    `);
  }
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(version);
}

function rebuildProviderAccountsForKimi(): void {
  const db = getDb();
  const version = 2026051301;
  if (migrationApplied(version) && providerAccountsAllowsKimi()) return;
  if (!providerAccountsAllowsKimi()) {
    db.exec(`
      PRAGMA foreign_keys=OFF;
      PRAGMA legacy_alter_table=ON;
      BEGIN TRANSACTION;
      ALTER TABLE provider_accounts RENAME TO provider_accounts_old;
      CREATE TABLE provider_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL CHECK(provider IN ('anthropic','openai_codex','openai','groq','kimi')),
        label TEXT NOT NULL,
        owner_email TEXT,
        secret TEXT NOT NULL,
        refresh_secret TEXT,
        account_id TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active',
        max_in_flight INTEGER,
        cooldown_until INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER NOT NULL DEFAULT 0,
        last_used_at INTEGER NOT NULL DEFAULT 0,
        last_refresh_at INTEGER NOT NULL DEFAULT 0,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        notes TEXT,
        risk_notes TEXT,
        quota_notes TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO provider_accounts (id,provider,label,owner_email,secret,refresh_secret,account_id,enabled,status,max_in_flight,cooldown_until,expires_at,last_used_at,last_refresh_at,consecutive_failures,notes,risk_notes,quota_notes,created_at,updated_at)
      SELECT id,provider,label,owner_email,secret,refresh_secret,account_id,enabled,status,max_in_flight,cooldown_until,expires_at,last_used_at,last_refresh_at,consecutive_failures,notes,risk_notes,quota_notes,created_at,updated_at
      FROM provider_accounts_old;
      DROP TABLE provider_accounts_old;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_accounts_provider_account_id ON provider_accounts(provider, account_id) WHERE account_id IS NOT NULL AND account_id != '';
      COMMIT;
      PRAGMA legacy_alter_table=OFF;
      PRAGMA foreign_keys=ON;
    `);
  }
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(version);
}

function rebuildProviderAccountsForOpenRouter(): void {
  const db = getDb();
  const version = 2026051803;
  if (migrationApplied(version) && providerAccountsAllowsOpenRouter()) return;
  if (!providerAccountsAllowsOpenRouter()) {
    db.exec(`
      PRAGMA foreign_keys=OFF;
      PRAGMA legacy_alter_table=ON;
      BEGIN TRANSACTION;
      ALTER TABLE provider_accounts RENAME TO provider_accounts_old;
      CREATE TABLE provider_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL CHECK(provider IN ('anthropic','openai_codex','openai','groq','cerebras','kimi','gemini','openrouter','deepgram','xai','runpod','serper')),
        label TEXT NOT NULL,
        owner_email TEXT,
        secret TEXT NOT NULL,
        refresh_secret TEXT,
        account_id TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active',
        max_in_flight INTEGER,
        cooldown_until INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER NOT NULL DEFAULT 0,
        last_used_at INTEGER NOT NULL DEFAULT 0,
        last_refresh_at INTEGER NOT NULL DEFAULT 0,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        notes TEXT,
        risk_notes TEXT,
        quota_notes TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO provider_accounts (id,provider,label,owner_email,secret,refresh_secret,account_id,enabled,status,max_in_flight,cooldown_until,expires_at,last_used_at,last_refresh_at,consecutive_failures,notes,risk_notes,quota_notes,created_at,updated_at)
      SELECT id,provider,label,owner_email,secret,refresh_secret,account_id,enabled,status,max_in_flight,cooldown_until,expires_at,last_used_at,last_refresh_at,consecutive_failures,notes,risk_notes,quota_notes,created_at,updated_at
      FROM provider_accounts_old;
      DROP TABLE provider_accounts_old;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_accounts_provider_account_id ON provider_accounts(provider, account_id) WHERE account_id IS NOT NULL AND account_id != '';
      COMMIT;
      PRAGMA legacy_alter_table=OFF;
      PRAGMA foreign_keys=ON;
    `);
  }
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(version);
}

function rebuildProviderAccountsForDeepgram(): void {
  const db = getDb();
  const version = 2026051804;
  if (migrationApplied(version) && providerAccountsAllowsDeepgram()) return;
  if (!providerAccountsAllowsDeepgram()) {
    db.exec(`
      PRAGMA foreign_keys=OFF;
      PRAGMA legacy_alter_table=ON;
      BEGIN TRANSACTION;
      ALTER TABLE provider_accounts RENAME TO provider_accounts_old;
      CREATE TABLE provider_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL CHECK(provider IN ('anthropic','openai_codex','openai','groq','cerebras','kimi','gemini','openrouter','deepgram','xai','runpod','serper')),
        label TEXT NOT NULL,
        owner_email TEXT,
        secret TEXT NOT NULL,
        refresh_secret TEXT,
        account_id TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active',
        max_in_flight INTEGER,
        cooldown_until INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER NOT NULL DEFAULT 0,
        last_used_at INTEGER NOT NULL DEFAULT 0,
        last_refresh_at INTEGER NOT NULL DEFAULT 0,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        notes TEXT,
        risk_notes TEXT,
        quota_notes TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO provider_accounts (id,provider,label,owner_email,secret,refresh_secret,account_id,enabled,status,max_in_flight,cooldown_until,expires_at,last_used_at,last_refresh_at,consecutive_failures,notes,risk_notes,quota_notes,created_at,updated_at)
      SELECT id,provider,label,owner_email,secret,refresh_secret,account_id,enabled,status,max_in_flight,cooldown_until,expires_at,last_used_at,last_refresh_at,consecutive_failures,notes,risk_notes,quota_notes,created_at,updated_at
      FROM provider_accounts_old;
      DROP TABLE provider_accounts_old;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_accounts_provider_account_id ON provider_accounts(provider, account_id) WHERE account_id IS NOT NULL AND account_id != '';
      COMMIT;
      PRAGMA legacy_alter_table=OFF;
      PRAGMA foreign_keys=ON;
    `);
  }
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(version);
}

function rebuildProviderAccountsForXai(): void {
  const db = getDb();
  const version = 2026052001;
  if (migrationApplied(version) && providerAccountsAllowsXai()) return;
  if (!providerAccountsAllowsXai()) {
    db.exec(`
      PRAGMA foreign_keys=OFF;
      PRAGMA legacy_alter_table=ON;
      BEGIN TRANSACTION;
      ALTER TABLE provider_accounts RENAME TO provider_accounts_old;
      CREATE TABLE provider_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL CHECK(provider IN ('anthropic','openai_codex','openai','groq','cerebras','kimi','gemini','openrouter','deepgram','xai','runpod','serper')),
        label TEXT NOT NULL,
        owner_email TEXT,
        secret TEXT NOT NULL,
        refresh_secret TEXT,
        account_id TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active',
        max_in_flight INTEGER,
        cooldown_until INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER NOT NULL DEFAULT 0,
        last_used_at INTEGER NOT NULL DEFAULT 0,
        last_refresh_at INTEGER NOT NULL DEFAULT 0,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        notes TEXT,
        risk_notes TEXT,
        quota_notes TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO provider_accounts (id,provider,label,owner_email,secret,refresh_secret,account_id,enabled,status,max_in_flight,cooldown_until,expires_at,last_used_at,last_refresh_at,consecutive_failures,notes,risk_notes,quota_notes,created_at,updated_at)
      SELECT id,provider,label,owner_email,secret,refresh_secret,account_id,enabled,status,max_in_flight,cooldown_until,expires_at,last_used_at,last_refresh_at,consecutive_failures,notes,risk_notes,quota_notes,created_at,updated_at
      FROM provider_accounts_old;
      DROP TABLE provider_accounts_old;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_accounts_provider_account_id ON provider_accounts(provider, account_id) WHERE account_id IS NOT NULL AND account_id != '';
      COMMIT;
      PRAGMA legacy_alter_table=OFF;
      PRAGMA foreign_keys=ON;
    `);
  }
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(version);
}

function rebuildProviderAccountsForRunpod(): void {
  const db = getDb();
  const version = 2026052801;
  if (migrationApplied(version) && providerAccountsAllowsRunpod()) return;
  if (!providerAccountsAllowsRunpod()) {
    db.exec(`
      PRAGMA foreign_keys=OFF;
      PRAGMA legacy_alter_table=ON;
      BEGIN TRANSACTION;
      ALTER TABLE provider_accounts RENAME TO provider_accounts_old;
      CREATE TABLE provider_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL CHECK(provider IN ('anthropic','openai_codex','openai','groq','cerebras','kimi','openrouter','deepgram','xai','runpod','serper')),
        label TEXT NOT NULL,
        owner_email TEXT,
        secret TEXT NOT NULL,
        refresh_secret TEXT,
        account_id TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active',
        max_in_flight INTEGER,
        cooldown_until INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER NOT NULL DEFAULT 0,
        last_used_at INTEGER NOT NULL DEFAULT 0,
        last_refresh_at INTEGER NOT NULL DEFAULT 0,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        notes TEXT,
        risk_notes TEXT,
        quota_notes TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO provider_accounts (id,provider,label,owner_email,secret,refresh_secret,account_id,enabled,status,max_in_flight,cooldown_until,expires_at,last_used_at,last_refresh_at,consecutive_failures,notes,risk_notes,quota_notes,created_at,updated_at)
      SELECT id,provider,label,owner_email,secret,refresh_secret,account_id,enabled,status,max_in_flight,cooldown_until,expires_at,last_used_at,last_refresh_at,consecutive_failures,notes,risk_notes,quota_notes,created_at,updated_at
      FROM provider_accounts_old;
      DROP TABLE provider_accounts_old;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_accounts_provider_account_id ON provider_accounts(provider, account_id) WHERE account_id IS NOT NULL AND account_id != '';
      COMMIT;
      PRAGMA legacy_alter_table=OFF;
      PRAGMA foreign_keys=ON;
    `);
  }
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(version);
}

function rebuildProviderAccountsForGemini(): void {
  const db = getDb();
  const version = 2026060303;
  if (migrationApplied(version) && providerAccountsAllowsGemini()) return;
  if (!providerAccountsAllowsGemini()) {
    db.exec(`
      PRAGMA foreign_keys=OFF;
      PRAGMA legacy_alter_table=ON;
      BEGIN TRANSACTION;
      ALTER TABLE provider_accounts RENAME TO provider_accounts_old;
      CREATE TABLE provider_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL CHECK(provider IN ('anthropic','openai_codex','openai','groq','cerebras','kimi','gemini','openrouter','deepgram','xai','runpod','serper')),
        label TEXT NOT NULL,
        owner_email TEXT,
        secret TEXT NOT NULL,
        refresh_secret TEXT,
        account_id TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active',
        max_in_flight INTEGER,
        cooldown_until INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER NOT NULL DEFAULT 0,
        last_used_at INTEGER NOT NULL DEFAULT 0,
        last_refresh_at INTEGER NOT NULL DEFAULT 0,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        notes TEXT,
        risk_notes TEXT,
        quota_notes TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO provider_accounts (id,provider,label,owner_email,secret,refresh_secret,account_id,enabled,status,max_in_flight,cooldown_until,expires_at,last_used_at,last_refresh_at,consecutive_failures,notes,risk_notes,quota_notes,created_at,updated_at)
      SELECT id,provider,label,owner_email,secret,refresh_secret,account_id,enabled,status,max_in_flight,cooldown_until,expires_at,last_used_at,last_refresh_at,consecutive_failures,notes,risk_notes,quota_notes,created_at,updated_at
      FROM provider_accounts_old;
      DROP TABLE provider_accounts_old;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_accounts_provider_account_id ON provider_accounts(provider, account_id) WHERE account_id IS NOT NULL AND account_id != '';
      COMMIT;
      PRAGMA legacy_alter_table=OFF;
      PRAGMA foreign_keys=ON;
    `);
  }
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(version);
}


function rebuildProviderAccountsForSerper(): void {
  const db = getDb();
  const version = 2026061501;
  if (migrationApplied(version) && providerAccountsAllowsSerper()) return;
  if (!providerAccountsAllowsSerper()) {
    db.exec(`
      PRAGMA foreign_keys=OFF;
      PRAGMA legacy_alter_table=ON;
      BEGIN TRANSACTION;
      ALTER TABLE provider_accounts RENAME TO provider_accounts_old;
      CREATE TABLE provider_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL CHECK(provider IN ('anthropic','openai_codex','openai','groq','cerebras','kimi','gemini','openrouter','deepgram','xai','runpod','serper')),
        label TEXT NOT NULL,
        owner_email TEXT,
        secret TEXT NOT NULL,
        refresh_secret TEXT,
        account_id TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active',
        max_in_flight INTEGER,
        cooldown_until INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER NOT NULL DEFAULT 0,
        last_used_at INTEGER NOT NULL DEFAULT 0,
        last_refresh_at INTEGER NOT NULL DEFAULT 0,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        notes TEXT,
        risk_notes TEXT,
        quota_notes TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO provider_accounts (id,provider,label,owner_email,secret,refresh_secret,account_id,enabled,status,max_in_flight,cooldown_until,expires_at,last_used_at,last_refresh_at,consecutive_failures,notes,risk_notes,quota_notes,created_at,updated_at)
      SELECT id,provider,label,owner_email,secret,refresh_secret,account_id,enabled,status,max_in_flight,cooldown_until,expires_at,last_used_at,last_refresh_at,consecutive_failures,notes,risk_notes,quota_notes,created_at,updated_at
      FROM provider_accounts_old;
      DROP TABLE provider_accounts_old;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_accounts_provider_account_id ON provider_accounts(provider, account_id) WHERE account_id IS NOT NULL AND account_id != '';
      COMMIT;
      PRAGMA legacy_alter_table=OFF;
      PRAGMA foreign_keys=ON;
    `);
  }
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(version);
}

function rebuildProviderAccountsForGlm(): void {
  const db = getDb();
  const version = 2026062501;
  if (migrationApplied(version) && providerAccountsAllowsGlm()) return;
  if (!providerAccountsAllowsGlm()) {
    db.exec(`
      PRAGMA foreign_keys=OFF;
      PRAGMA legacy_alter_table=ON;
      BEGIN TRANSACTION;
      ALTER TABLE provider_accounts RENAME TO provider_accounts_old;
      CREATE TABLE provider_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL CHECK(provider IN ('anthropic','openai_codex','openai','groq','cerebras','kimi','glm','gemini','openrouter','deepgram','xai','runpod','serper')),
        label TEXT NOT NULL,
        owner_email TEXT,
        secret TEXT NOT NULL,
        refresh_secret TEXT,
        account_id TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active',
        max_in_flight INTEGER,
        cooldown_until INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER NOT NULL DEFAULT 0,
        last_used_at INTEGER NOT NULL DEFAULT 0,
        last_refresh_at INTEGER NOT NULL DEFAULT 0,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        notes TEXT,
        risk_notes TEXT,
        quota_notes TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO provider_accounts (id,provider,label,owner_email,secret,refresh_secret,account_id,enabled,status,max_in_flight,cooldown_until,expires_at,last_used_at,last_refresh_at,consecutive_failures,notes,risk_notes,quota_notes,created_at,updated_at)
      SELECT id,provider,label,owner_email,secret,refresh_secret,account_id,enabled,status,max_in_flight,cooldown_until,expires_at,last_used_at,last_refresh_at,consecutive_failures,notes,risk_notes,quota_notes,created_at,updated_at
      FROM provider_accounts_old;
      DROP TABLE provider_accounts_old;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_accounts_provider_account_id ON provider_accounts(provider, account_id) WHERE account_id IS NOT NULL AND account_id != '';
      COMMIT;
      PRAGMA legacy_alter_table=OFF;
      PRAGMA foreign_keys=ON;
    `);
  }
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(version);
}

function rebuildProviderAccountsForFish(): void {
  const db = getDb();
  const version = 2026070201;
  if (migrationApplied(version) && providerAccountsAllowsFish()) return;
  if (!providerAccountsAllowsFish()) {
    db.exec(`
      PRAGMA foreign_keys=OFF;
      PRAGMA legacy_alter_table=ON;
      BEGIN TRANSACTION;
      ALTER TABLE provider_accounts RENAME TO provider_accounts_old;
      CREATE TABLE provider_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL CHECK(provider IN ('anthropic','openai_codex','openai','groq','cerebras','kimi','glm','gemini','openrouter','deepgram','fish','xai','runpod','serper')),
        label TEXT NOT NULL,
        owner_email TEXT,
        secret TEXT NOT NULL,
        refresh_secret TEXT,
        account_id TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active',
        max_in_flight INTEGER,
        cooldown_until INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER NOT NULL DEFAULT 0,
        last_used_at INTEGER NOT NULL DEFAULT 0,
        last_refresh_at INTEGER NOT NULL DEFAULT 0,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        notes TEXT,
        risk_notes TEXT,
        quota_notes TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO provider_accounts (id,provider,label,owner_email,secret,refresh_secret,account_id,enabled,status,max_in_flight,cooldown_until,expires_at,last_used_at,last_refresh_at,consecutive_failures,notes,risk_notes,quota_notes,created_at,updated_at)
      SELECT id,provider,label,owner_email,secret,refresh_secret,account_id,enabled,status,max_in_flight,cooldown_until,expires_at,last_used_at,last_refresh_at,consecutive_failures,notes,risk_notes,quota_notes,created_at,updated_at
      FROM provider_accounts_old;
      DROP TABLE provider_accounts_old;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_accounts_provider_account_id ON provider_accounts(provider, account_id) WHERE account_id IS NOT NULL AND account_id != '';
      COMMIT;
      PRAGMA legacy_alter_table=OFF;
      PRAGMA foreign_keys=ON;
    `);
  }
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(version);
}

function seedRunpodAccountFromEnv(): void {
  // Bootstrap a single Runpod account from env when none exists. Multi-account
  // setups can be added via /admin/provider-accounts afterwards.
  if (!config.runpodApiKey || !config.runpodEndpointId) return;
  const db = getDb();
  const existing = db.prepare("SELECT 1 FROM provider_accounts WHERE provider='runpod' LIMIT 1").get();
  if (existing) return;
  db.prepare(`INSERT INTO provider_accounts (provider,label,secret,account_id,max_in_flight,notes) VALUES ('runpod','runpod-env',?,?,?,?)`).run(
    config.runpodApiKey,
    config.runpodEndpointId,
    config.runpodConcurrencyLimit,
    'Seeded from RUNPOD_API_KEY/RUNPOD_ENDPOINT_ID env vars',
  );
}

export function migrate() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      name TEXT,
      role TEXT NOT NULL CHECK(role IN ('admin','founder','developer','member')) DEFAULT 'member',
      enabled INTEGER NOT NULL DEFAULT 1,
      is_admin INTEGER NOT NULL DEFAULT 0,
      full_body_logging INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS api_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      token_prefix TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      cap_usd_daily REAL,
      cap_tokens_daily INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_used_at TEXT
    );

    CREATE TABLE IF NOT EXISTS provider_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL CHECK(provider IN ('anthropic','openai_codex','openai','groq','cerebras','kimi','gemini','openrouter','deepgram','xai','runpod','serper')),
      label TEXT NOT NULL,
      owner_email TEXT,
      secret TEXT NOT NULL,
      refresh_secret TEXT,
      account_id TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active',
      max_in_flight INTEGER,
      cooldown_until INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL DEFAULT 0,
      last_used_at INTEGER NOT NULL DEFAULT 0,
      last_refresh_at INTEGER NOT NULL DEFAULT 0,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      risk_notes TEXT,
      quota_notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS role_limits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      provider TEXT NOT NULL,
      daily_usd REAL,
      daily_tokens INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(role, provider)
    );

    CREATE TABLE IF NOT EXISTS user_limits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      daily_usd REAL,
      daily_tokens INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, provider)
    );

    CREATE TABLE IF NOT EXISTS usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      token_id INTEGER REFERENCES api_tokens(id),
      provider_account_id INTEGER REFERENCES provider_accounts(id),
      provider TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      model TEXT,
      stream INTEGER NOT NULL DEFAULT 0,
      status_code INTEGER,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_cost_usd REAL NOT NULL DEFAULT 0,
      latency_ms INTEGER,
      error TEXT,
      token_label TEXT,
      provider_account_label TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS request_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usage_event_id INTEGER REFERENCES usage_events(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id),
      request_json TEXT,
      response_text TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS admin_audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_user_id INTEGER REFERENCES users(id),
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT,
      before_json TEXT,
      after_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS provider_health_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_account_id INTEGER REFERENCES provider_accounts(id),
      status TEXT NOT NULL,
      reason TEXT,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL DEFAULT 'info',
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      metadata_json TEXT,
      resolved INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS user_model_denies (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      created_by_user_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, provider, model)
    );
    CREATE TABLE IF NOT EXISTS user_provider_access_modes (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('allow_all','custom','deny_all')) DEFAULT 'allow_all',
      created_by_user_id INTEGER REFERENCES users(id),
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, provider)
    );
    CREATE TABLE IF NOT EXISTS groq_limits (
      account_id INTEGER NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      rpm INTEGER,
      rpd INTEGER,
      tpm INTEGER,
      tpd INTEGER,
      PRIMARY KEY(account_id, model)
    );

    CREATE TABLE IF NOT EXISTS groq_usage_buckets (
      account_id INTEGER NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      window_minute TEXT NOT NULL,
      window_day TEXT NOT NULL,
      requests INTEGER DEFAULT 0,
      tokens INTEGER DEFAULT 0,
      PRIMARY KEY(account_id, model, window_minute, window_day)
    );

    CREATE TABLE IF NOT EXISTS groq_model_cooldowns (
      account_id INTEGER NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      cooldown_until INTEGER DEFAULT 0,
      reason TEXT,
      PRIMARY KEY(account_id, model)
    );

    CREATE TABLE IF NOT EXISTS cerebras_limits (
      account_id INTEGER NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      rpm INTEGER,
      rpd INTEGER,
      tpm INTEGER,
      tpd INTEGER,
      PRIMARY KEY(account_id, model)
    );

    CREATE TABLE IF NOT EXISTS cerebras_usage_buckets (
      account_id INTEGER NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      window_minute TEXT NOT NULL,
      window_day TEXT NOT NULL,
      requests INTEGER DEFAULT 0,
      tokens INTEGER DEFAULT 0,
      PRIMARY KEY(account_id, model, window_minute, window_day)
    );

    CREATE TABLE IF NOT EXISTS cerebras_model_cooldowns (
      account_id INTEGER NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      cooldown_until INTEGER DEFAULT 0,
      reason TEXT,
      PRIMARY KEY(account_id, model)
    );

    CREATE TABLE IF NOT EXISTS codex_bucket_cooldowns (
      account_id INTEGER NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
      bucket TEXT NOT NULL CHECK(bucket IN ('spark','main')),
      cooldown_until INTEGER DEFAULT 0,
      reason TEXT,
      resets_at INTEGER,
      PRIMARY KEY(account_id, bucket)
    );

    CREATE TABLE IF NOT EXISTS xai_video_jobs (
      request_id TEXT PRIMARY KEY,
      provider_account_id INTEGER NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      token_id INTEGER REFERENCES api_tokens(id) ON DELETE CASCADE,
      model TEXT NOT NULL DEFAULT 'grok-imagine-video',
      submit_cost_usd REAL,
      trued_up INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_accounts_provider_account_id ON provider_accounts(provider, account_id) WHERE account_id IS NOT NULL AND account_id != '';
  `);

  if (!providerAccountsAllowsGroq()) {
    rebuildProviderAccountsForGroq();
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_accounts_provider_account_id ON provider_accounts(provider, account_id) WHERE account_id IS NOT NULL AND account_id != '';");
  }

  for (const [table, cols] of Object.entries({
    users: [['full_body_logging', 'INTEGER NOT NULL DEFAULT 0']],
    usage_events: [['token_label', 'TEXT'], ['provider_account_label', 'TEXT']],
    provider_accounts: [['expires_at', 'INTEGER NOT NULL DEFAULT 0'], ['last_used_at', 'INTEGER NOT NULL DEFAULT 0'], ['last_refresh_at', 'INTEGER NOT NULL DEFAULT 0'], ['consecutive_failures', 'INTEGER NOT NULL DEFAULT 0']],
    alerts: [['resolved_at', 'TEXT']],
  } as Record<string, [string,string][] >)) {
    for (const [col, ddl] of cols) addColumn(table, col, ddl);
  }

  rebuildProviderAccountsForKimi();
  rebuildProviderAccountsForCerebras();
  rebuildProviderAccountsForOpenRouter();
  rebuildProviderAccountsForDeepgram();
  rebuildProviderAccountsForXai();
  rebuildProviderAccountsForRunpod();
  rebuildProviderAccountsForGemini();
  rebuildProviderAccountsForSerper();
  rebuildProviderAccountsForGlm();
  rebuildProviderAccountsForFish();
  seedRunpodAccountFromEnv();

  // Migration 2026051502 — time-bounded grants. A grant is a temporary override
  // that lets a specific user use a specific (provider, model_pattern) tuple
  // with custom (or unlimited) daily caps between valid_from and valid_until.
  // Expired rows are kept for audit but are inert to the policy ladder.
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_grants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      model_pattern TEXT,
      daily_usd REAL,
      daily_tokens INTEGER,
      valid_from INTEGER NOT NULL,
      valid_until INTEGER NOT NULL,
      reason TEXT,
      created_by_user_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_user_grants_active
      ON user_grants(user_id, provider, valid_until);
  `);

  // Migration 2026051802 — provider access modes. `allow_all` means unknown
  // future models are allowed for that provider, `custom` means only known ON
  // models are allowed, and `deny_all` blocks the provider entirely.
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_provider_access_modes (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('allow_all','custom','deny_all')) DEFAULT 'allow_all',
      created_by_user_id INTEGER REFERENCES users(id),
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, provider)
    );
  `);

  // Migration 2026052901 — Codex account reservations. A reserved Codex
  // provider account is eligible ONLY for the listed emails (exclusivity), and
  // those emails get the reserved account prioritized first with soft fallback
  // to the unreserved pool. Accounts with no reservation rows behave exactly as
  // before. Stored in the DB so it survives container restarts.
  db.exec(`
    CREATE TABLE IF NOT EXISTS codex_account_reservations (
      account_id INTEGER NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (account_id, email)
    );
    CREATE INDEX IF NOT EXISTS idx_codex_reservations_email ON codex_account_reservations(email);
  `);

  // Migration 2026060101 — Codex quota buckets. ChatGPT Codex quota is split
  // into exactly two buckets: spark (gpt-5.3-codex-spark) and main (all other
  // Codex models). Cooldowns live here so a 429 on one bucket does not cool the
  // whole OAuth account or the other bucket.
  db.exec(`
    CREATE TABLE IF NOT EXISTS codex_bucket_cooldowns (
      account_id INTEGER NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
      bucket TEXT NOT NULL CHECK(bucket IN ('spark','main')),
      cooldown_until INTEGER DEFAULT 0,
      reason TEXT,
      resets_at INTEGER,
      PRIMARY KEY(account_id, bucket)
    );
  `);

  // Migration 2026060201 — xAI video job account affinity. xAI video status
  // polling must use the same upstream account/API key that created the async
  // video request, so store request_id -> owner + provider account on submit.
  db.exec(`
    CREATE TABLE IF NOT EXISTS xai_video_jobs (
      request_id TEXT PRIMARY KEY,
      provider_account_id INTEGER NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      token_id INTEGER REFERENCES api_tokens(id) ON DELETE CASCADE,
      model TEXT NOT NULL DEFAULT 'grok-imagine-video',
      submit_cost_usd REAL,
      trued_up INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
  `);
  for (const [col, ddl] of [
    ['user_id', 'INTEGER REFERENCES users(id) ON DELETE CASCADE'],
    ['token_id', 'INTEGER REFERENCES api_tokens(id) ON DELETE CASCADE'],
    ['model', "TEXT NOT NULL DEFAULT 'grok-imagine-video'"],
  ] as [string, string][]) addColumn('xai_video_jobs', col, ddl);

  // Migration 2026060301 — xAI video edit/extension true-up billing. These
  // async jobs are billed at submit with a conservative floor, then reconciled
  // once polling returns authoritative upstream cost ticks.
  for (const [col, ddl] of [
    ['submit_cost_usd', 'REAL'],
    ['trued_up', 'INTEGER NOT NULL DEFAULT 0'],
  ] as [string, string][]) addColumn('xai_video_jobs', col, ddl);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_xai_video_jobs_owner ON xai_video_jobs(user_id, request_id);
    CREATE INDEX IF NOT EXISTS idx_xai_video_jobs_created_at ON xai_video_jobs(created_at);
  `);

  // Migration 2026060302 — xAI batch job account affinity. xAI batch IDs are
  // account-scoped, so status/request/result operations must use the same
  // upstream account that created the batch container.
  db.exec(`
    CREATE TABLE IF NOT EXISTS xai_batch_jobs (
      batch_id TEXT PRIMARY KEY,
      provider_account_id INTEGER REFERENCES provider_accounts(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      token_id INTEGER REFERENCES api_tokens(id) ON DELETE CASCADE,
      created_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_xai_batch_jobs_owner ON xai_batch_jobs(user_id, batch_id);
    CREATE INDEX IF NOT EXISTS idx_xai_batch_jobs_created_at ON xai_batch_jobs(created_at);
  `);

  // Migration 2026060303 — native Gemini free-tier per-key/per-model-family
  // Pacific-day counters. Incremented on every upstream attempt so tiny free
  // quotas rotate fairly and exhausted keys stay skipped until Pacific midnight.
  db.exec(`
    CREATE TABLE IF NOT EXISTS gemini_key_usage (
      account_id INTEGER NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
      model_family TEXT NOT NULL CHECK(model_family IN ('embeddings','tts','chat')),
      day_pacific TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(account_id, model_family, day_pacific)
    );
    CREATE INDEX IF NOT EXISTS idx_gemini_key_usage_family_day ON gemini_key_usage(model_family, day_pacific, count);
  `);

  // Migration 2026060304 — allow the 'chat-video' model family in gemini_key_usage.
  // Video-understanding models (gemini-2.5-flash, gemini-3.5-flash) have a much
  // lower free-tier daily request cap, so they are pooled under their own family.
  // SQLite can't ALTER a CHECK constraint, so rebuild the table preserving rows.
  // Idempotent: only rebuilds if the current CHECK still rejects 'chat-video'.
  {
    const tableSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='gemini_key_usage'").get() as { sql?: string } | undefined)?.sql || '';
    if (tableSql && !tableSql.includes('chat-video')) {
      // Atomic table rebuild: if any step fails, the whole thing rolls back so the
      // live daily-counter table is never left dropped/half-migrated in prod.
      db.exec('DROP TABLE IF EXISTS gemini_key_usage_new');
      const rebuild = db.transaction(() => {
        db.exec(`
          CREATE TABLE gemini_key_usage_new (
            account_id INTEGER NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
            model_family TEXT NOT NULL CHECK(model_family IN ('embeddings','tts','chat','chat-video')),
            day_pacific TEXT NOT NULL,
            count INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY(account_id, model_family, day_pacific)
          );
          INSERT INTO gemini_key_usage_new (account_id, model_family, day_pacific, count, updated_at)
            SELECT account_id, model_family, day_pacific, count, updated_at FROM gemini_key_usage;
          DROP TABLE gemini_key_usage;
          ALTER TABLE gemini_key_usage_new RENAME TO gemini_key_usage;
          CREATE INDEX IF NOT EXISTS idx_gemini_key_usage_family_day ON gemini_key_usage(model_family, day_pacific, count);
        `);
      });
      rebuild();
    }
  }

  // Migration 2026062401 — allow the 'live' model family in gemini_key_usage.
  // Gemini Live (realtime) sessions are counted under their own pool family so
  // their tight free-tier daily cap can't starve embeddings/chat/video budgets.
  // SQLite can't ALTER a CHECK constraint, so rebuild the table preserving rows.
  // Idempotent: only rebuilds if the current CHECK still rejects 'live'.
  {
    const tableSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='gemini_key_usage'").get() as { sql?: string } | undefined)?.sql || '';
    if (tableSql && !tableSql.includes("'live'")) {
      db.exec('DROP TABLE IF EXISTS gemini_key_usage_new');
      const rebuild = db.transaction(() => {
        db.exec(`
          CREATE TABLE gemini_key_usage_new (
            account_id INTEGER NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
            model_family TEXT NOT NULL CHECK(model_family IN ('embeddings','tts','chat','chat-video','live')),
            day_pacific TEXT NOT NULL,
            count INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY(account_id, model_family, day_pacific)
          );
          INSERT INTO gemini_key_usage_new (account_id, model_family, day_pacific, count, updated_at)
            SELECT account_id, model_family, day_pacific, count, updated_at FROM gemini_key_usage;
          DROP TABLE gemini_key_usage;
          ALTER TABLE gemini_key_usage_new RENAME TO gemini_key_usage;
          CREATE INDEX IF NOT EXISTS idx_gemini_key_usage_family_day ON gemini_key_usage(model_family, day_pacific, count);
        `);
      });
      rebuild();
    }
  }

  const admin = db.prepare('SELECT id FROM users WHERE email = ?').get(config.adminEmail) as { id: number } | undefined;
  if (!admin) {
    db.prepare('INSERT INTO users (email, role, is_admin, enabled) VALUES (?, ?, 1, 1)').run(config.adminEmail, 'admin');
  }

  db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(2026051201);
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(2026051501);
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(2026051502);
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(2026051801);
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(2026051802);
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(2026051803);
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(2026051804);
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(2026052001);
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(2026052801);
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(2026052901);
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(2026060101);
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(2026060301);
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(2026060302);
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(2026060303);
  // Migration 2026061901 — fusion_presets and fusion_calls tables.
  // fusion_presets stores user-saved custom panel/synthesizer configurations.
  // fusion_calls stores per-call metadata for audit and dashboard analytics.
  db.exec(`
    CREATE TABLE IF NOT EXISTS fusion_presets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      panel_models_json TEXT NOT NULL,
      synthesizer_model TEXT NOT NULL,
      panel_max_tokens INTEGER DEFAULT 4096,
      synthesizer_max_tokens INTEGER DEFAULT 8192,
      panel_timeout_ms INTEGER DEFAULT 120000,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, name)
    );

    CREATE TABLE IF NOT EXISTS fusion_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_usage_event_id INTEGER REFERENCES usage_events(id),
      user_id INTEGER REFERENCES users(id),
      preset TEXT,
      panel_models_json TEXT,
      synthesizer_model TEXT,
      panel_succeeded INTEGER NOT NULL DEFAULT 0,
      panel_failed INTEGER NOT NULL DEFAULT 0,
      failed_models_json TEXT,
      synthesizer_succeeded INTEGER NOT NULL DEFAULT 1,
      synthesizer_skipped INTEGER NOT NULL DEFAULT 0,
      total_latency_ms INTEGER,
      panel_latency_ms INTEGER,
      synthesizer_latency_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_fusion_calls_user ON fusion_calls(user_id, created_at);
  `);

  // Migration 2026061902 — add thinking_level column to fusion_presets.
  addColumn('fusion_presets', 'thinking_level', "TEXT DEFAULT 'medium'");

  // Migration 2026061903 — add thinking_overrides_json to fusion_presets.
  // Stores raw per-provider thinking config as JSON string.
  addColumn('fusion_presets', 'thinking_overrides_json', 'TEXT');

  // Migration 2026070301 — async (poll-based) Codex image jobs. Slow Codex/
  // ChatGPT-OAuth image generations can exceed Cloudflare's ~100s 524 timeout,
  // so the async routes queue a job here, run the worker in the background, and
  // let clients poll for the result. request_json holds the parsed Images-API
  // body (for edits this includes base64 image(s)); result_json holds the final
  // OpenAI Images shape on success. Rows expire 1h after creation.
  db.exec(`
    CREATE TABLE IF NOT EXISTS image_jobs (
      id TEXT PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      token_id INTEGER REFERENCES api_tokens(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      request_json TEXT NOT NULL,
      result_json TEXT,
      error_json TEXT,
      status_code INTEGER,
      provider_account_label TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_image_jobs_user ON image_jobs(user_id);
    CREATE INDEX IF NOT EXISTS idx_image_jobs_status ON image_jobs(status);
    CREATE INDEX IF NOT EXISTS idx_image_jobs_expires_at ON image_jobs(expires_at);
  `);

  // ─── Headroom compression columns (2026070302) ──────────────────────────
  addColumn('usage_events', 'tokens_before_compression', 'INTEGER');
  addColumn('usage_events', 'tokens_saved_compression', 'INTEGER');
  addColumn('usage_events', 'compression_ms', 'INTEGER');
  addColumn('usage_events', 'compression_status', 'TEXT');
  addColumn('users', 'compression_enabled', 'INTEGER NOT NULL DEFAULT 1');

  // ─── App settings KV store (2026070303) ──────────────────────────────
  db.exec(`CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  // Seed headroom defaults
  db.prepare(`INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)`).run('headroom.enabled', 'false');
  db.prepare(`INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)`).run('headroom.skipProviders', '');

  // ─── Monitoring instrumentation columns (2026070901) ────────────────────
  // Phase 1 of docs/MONITORING-SYSTEM.md. All additive + nullable.
  addColumn('usage_events', 'reasoning_tokens', 'INTEGER');   // subset of output_tokens spent on thinking
  addColumn('usage_events', 'ttft_ms', 'INTEGER');            // time to first upstream byte/chunk
  addColumn('usage_events', 'retry_count', 'INTEGER');        // upstream attempts - 1
  addColumn('usage_events', 'retry_reason', 'TEXT');          // rate_limited | account_rotation | stale_reasoning | upstream_error
  addColumn('usage_events', 'unit', 'TEXT');                  // NULL=tokens | seconds | chars | images | videos
  addColumn('usage_events', 'billing_mode', 'TEXT');          // metered | flat_fee | self_hosted | free_tier
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_usage_events_created ON usage_events(created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_events_provider_created ON usage_events(provider, created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_events_user_created ON usage_events(user_id, created_at);
  `);

  // ─── Monitoring rollups & retention (2026070902) ──────────────────────
  // Phase 2 of docs/MONITORING-SYSTEM.md. user_id=0 means "unattributed"
  // (user deleted); NULLs are avoided in the PK because SQLite treats NULLs
  // as distinct in unique constraints (would allow duplicate rows).
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_rollup_hourly (
      bucket TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT '',
      user_id INTEGER NOT NULL DEFAULT 0,
      billing_mode TEXT NOT NULL DEFAULT 'metered',
      requests INTEGER NOT NULL DEFAULT 0,
      errors_4xx INTEGER NOT NULL DEFAULT 0,
      errors_429 INTEGER NOT NULL DEFAULT 0,
      errors_5xx INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      tokens_saved_compression INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      cache_saved_usd REAL NOT NULL DEFAULT 0,
      latency_ms_sum INTEGER NOT NULL DEFAULT 0,
      latency_ms_p50 INTEGER,
      latency_ms_p95 INTEGER,
      ttft_ms_p50 INTEGER,
      ttft_ms_p95 INTEGER,
      retry_count INTEGER NOT NULL DEFAULT 0,
      -- Per-request cache metrics (distinct from token-weighted cache_read_tokens):
      -- cacheable_requests = requests whose prompt was large enough to cache
      --   (input+cache_read >= caching minimum), cache_hit_requests = subset of
      -- those that actually got cache_read_tokens > 0. Lets the dashboard show a
      -- true per-request hit rate instead of a token-weighted one.
      cacheable_requests INTEGER NOT NULL DEFAULT 0,
      cache_hit_requests INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (bucket, provider, model, user_id, billing_mode)
    );
    CREATE INDEX IF NOT EXISTS idx_rollup_hourly_bucket ON usage_rollup_hourly(bucket);
    CREATE TABLE IF NOT EXISTS usage_rollup_daily (
      bucket TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT '',
      user_id INTEGER NOT NULL DEFAULT 0,
      billing_mode TEXT NOT NULL DEFAULT 'metered',
      requests INTEGER NOT NULL DEFAULT 0,
      errors_4xx INTEGER NOT NULL DEFAULT 0,
      errors_429 INTEGER NOT NULL DEFAULT 0,
      errors_5xx INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      tokens_saved_compression INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      cache_saved_usd REAL NOT NULL DEFAULT 0,
      latency_ms_sum INTEGER NOT NULL DEFAULT 0,
      latency_ms_p50 INTEGER,
      latency_ms_p95 INTEGER,
      ttft_ms_p50 INTEGER,
      ttft_ms_p95 INTEGER,
      retry_count INTEGER NOT NULL DEFAULT 0,
      cacheable_requests INTEGER NOT NULL DEFAULT 0,
      cache_hit_requests INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (bucket, provider, model, user_id, billing_mode)
    );
    CREATE INDEX IF NOT EXISTS idx_rollup_daily_bucket ON usage_rollup_daily(bucket);
    CREATE TABLE IF NOT EXISTS alert_cooldowns (
      rule TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT '',
      last_fired_at TEXT NOT NULL,
      PRIMARY KEY (rule, scope)
    );
    CREATE TABLE IF NOT EXISTS monitor_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_request_logs_expires_at ON request_logs(expires_at);
  `);

  // Aside / fleet control-plane tables intentionally omitted from Super Proxy OSS.


  // Per-request cache-hit columns for existing rollup tables (idempotent).
  // Backfilled naturally on the next rollup recompute of live buckets; older
  // buckets simply read 0/0 (null per-request rate) until recomputed.
  addColumn('usage_rollup_hourly', 'cacheable_requests', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('usage_rollup_hourly', 'cache_hit_requests', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('usage_rollup_daily', 'cacheable_requests', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('usage_rollup_daily', 'cache_hit_requests', 'INTEGER NOT NULL DEFAULT 0');

  db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(LATEST_SCHEMA_MIGRATION_VERSION);
}

if (import.meta.url === `file://${process.argv[1]}`) migrate();
