import { randomUUID } from 'node:crypto';

export const SCHEMA_VERSION = 8;

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
    if (version < 6) db.exec(`
      CREATE TABLE push_config (id INTEGER PRIMARY KEY CHECK(id=1), public_key TEXT NOT NULL, private_key TEXT NOT NULL) STRICT;
      CREATE TABLE push_subscriptions (id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, device_id TEXT NOT NULL,
        endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
        UNIQUE(session_id,device_id)) STRICT;
      CREATE TABLE push_tests (id TEXT PRIMARY KEY NOT NULL, subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
        due_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0) STRICT;
      CREATE INDEX push_tests_due ON push_tests(status,due_at);
      CREATE TABLE push_test_limits (user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id), last_test INTEGER NOT NULL) STRICT;
      CREATE TRIGGER push_revoke_session AFTER UPDATE OF revoked ON sessions WHEN NEW.revoked=1
        BEGIN DELETE FROM push_subscriptions WHERE session_id=NEW.id; END;
    `);
    if(version<7)db.exec(`
      CREATE TABLE reminder_settings(user_id TEXT PRIMARY KEY REFERENCES users(id),zone TEXT NOT NULL DEFAULT 'UTC',nudge_hours INTEGER NOT NULL DEFAULT 1 CHECK(nudge_hours IN(0,1,3,6,24))) STRICT;
      CREATE TABLE reminders(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),vault_id TEXT NOT NULL REFERENCES vaults(id),object_id TEXT NOT NULL,
        config_id TEXT NOT NULL,record_id TEXT NOT NULL,local_at TEXT NOT NULL,due_at INTEGER,plan_state TEXT NOT NULL CHECK(plan_state IN('active','off','done')),body TEXT,
        paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN(0,1)),fired_at INTEGER,seen_at INTEGER,next_nudge INTEGER,cycle INTEGER NOT NULL DEFAULT 0 CHECK(cycle>=0),
        UNIQUE(vault_id,object_id)) STRICT;
      CREATE TABLE reminder_deliveries(id TEXT PRIMARY KEY,reminder_id TEXT NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
        subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,cycle INTEGER NOT NULL CHECK(cycle>0),
        status TEXT NOT NULL CHECK(status IN('scheduled','sending','accepted','expired','failed','unknown')),
        due_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),lease_until INTEGER NOT NULL DEFAULT 0) STRICT;
      CREATE INDEX reminder_delivery_due ON reminder_deliveries(status,due_at);
      CREATE INDEX records_object ON records(vault_id,object_id);
      CREATE TRIGGER reminder_record_changed AFTER INSERT ON records BEGIN
        UPDATE reminders SET paused=1 WHERE vault_id=NEW.vault_id AND object_id=NEW.object_id;
        DELETE FROM reminder_deliveries WHERE reminder_id IN(SELECT id FROM reminders WHERE vault_id=NEW.vault_id AND object_id=NEW.object_id);
      END;
      CREATE TRIGGER reminder_vault_deleted AFTER UPDATE OF deleted ON vaults WHEN NEW.deleted=1 BEGIN
        DELETE FROM reminders WHERE vault_id=NEW.id;
      END;
    `);
    if(version<8)db.exec(`
      CREATE TABLE IF NOT EXISTS vault_labels (vault_id TEXT PRIMARY KEY REFERENCES vaults(id) ON DELETE CASCADE,
        display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 200)) STRICT;
      CREATE TRIGGER IF NOT EXISTS vault_label_deleted AFTER UPDATE OF deleted ON vaults WHEN NEW.deleted=1
        BEGIN DELETE FROM vault_labels WHERE vault_id=NEW.id; END;
    `);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
