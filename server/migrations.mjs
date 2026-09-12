import { randomUUID } from 'node:crypto';

export const SCHEMA_VERSION = 5;

export function migrate(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version > SCHEMA_VERSION) throw new Error('Database schema is newer than this application');
    if (version < 1) {
      db.exec(`CREATE TABLE installation (
        id INTEGER PRIMARY KEY CHECK (id = 1), installation_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL, boot_count INTEGER NOT NULL DEFAULT 0
      ) STRICT`);
      db.prepare('INSERT INTO installation (id, installation_id, created_at) VALUES (1, ?, ?)')
        .run(randomUUID(), new Date().toISOString());
    }
    if (version < 2) {
      db.exec(`
        CREATE TABLE users (
          id TEXT PRIMARY KEY NOT NULL, login TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
          created_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE auth_state (
          id INTEGER PRIMARY KEY CHECK (id = 1), setup_complete INTEGER NOT NULL CHECK (setup_complete IN (0, 1))
        ) STRICT;
        INSERT INTO auth_state VALUES (1, 0);
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
          access_hash TEXT NOT NULL UNIQUE, access_expires INTEGER NOT NULL,
          refresh_hash TEXT NOT NULL UNIQUE, refresh_expires INTEGER NOT NULL,
          absolute_expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1))
        ) STRICT;
        CREATE TABLE used_refresh_tokens (
          token_hash TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          used_at INTEGER NOT NULL, nonce TEXT NOT NULL
        ) STRICT;
        CREATE INDEX used_refresh_session ON used_refresh_tokens(session_id);
      `);
    }
    if (version < 3) {
      db.exec(`ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1));
        ALTER TABLE users ADD COLUMN temporary_expires INTEGER;
        ALTER TABLE users ADD COLUMN credential_version INTEGER NOT NULL DEFAULT 0;`);
    }
    if (version < 4) db.exec(`
      CREATE TABLE vaults (id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
        header TEXT, deleted INTEGER NOT NULL DEFAULT 0, replacement TEXT) STRICT;
      CREATE INDEX vaults_owner ON vaults(user_id);
      CREATE TABLE records (id TEXT PRIMARY KEY NOT NULL, vault_id TEXT NOT NULL REFERENCES vaults(id),
        object_id TEXT NOT NULL, parent_id TEXT, payload TEXT NOT NULL) STRICT;
      CREATE INDEX records_vault ON records(vault_id);
    `);
    if (version < 5) db.exec(`
      ALTER TABLE vaults ADD COLUMN lock_epoch INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE vaults ADD COLUMN access_pack TEXT;
      CREATE TABLE vault_challenges (id TEXT PRIMARY KEY NOT NULL, vault_id TEXT NOT NULL REFERENCES vaults(id),
        device_id TEXT NOT NULL, epoch INTEGER NOT NULL, nonce TEXT NOT NULL, expires INTEGER NOT NULL) STRICT;
      CREATE TABLE vault_grants (token_hash TEXT PRIMARY KEY NOT NULL, vault_id TEXT NOT NULL REFERENCES vaults(id),
        device_id TEXT NOT NULL, epoch INTEGER NOT NULL) STRICT;
      CREATE INDEX vault_grants_vault ON vault_grants(vault_id);
      CREATE TABLE vault_closures (id TEXT PRIMARY KEY NOT NULL, vault_id TEXT NOT NULL REFERENCES vaults(id), epoch INTEGER NOT NULL) STRICT;
    `);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
