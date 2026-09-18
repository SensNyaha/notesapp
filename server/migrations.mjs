import { randomUUID } from 'node:crypto';

export const SCHEMA_VERSION = 13;

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
    if(version<9)db.exec(`
      ALTER TABLE reminder_settings ADD COLUMN all_day_time TEXT NOT NULL DEFAULT '09:00';
      ALTER TABLE reminders ADD COLUMN schedule TEXT NOT NULL DEFAULT '{"repeat":{"type":"once"},"end":{"type":"never"},"allDay":false,"important":false}';
      CREATE TABLE reminder_occurrences(
        id TEXT PRIMARY KEY, reminder_id TEXT NOT NULL REFERENCES reminders(id) ON DELETE CASCADE, config_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK(sequence>0), scheduled_local TEXT NOT NULL,
        due_at INTEGER, snooze_local TEXT, effective_due_at INTEGER,
        status TEXT NOT NULL CHECK(status IN('scheduled','fired','seen','done','skipped','missed')),
        fired_at INTEGER, seen_at INTEGER, completed_at INTEGER, next_nudge INTEGER,
        cycle INTEGER NOT NULL DEFAULT 0 CHECK(cycle>=0), UNIQUE(reminder_id,sequence)
      ) STRICT;
      CREATE INDEX reminder_occurrence_due ON reminder_occurrences(status,effective_due_at);
      ALTER TABLE reminder_deliveries ADD COLUMN occurrence_id TEXT;
      INSERT INTO reminder_occurrences(id,reminder_id,config_id,sequence,scheduled_local,due_at,effective_due_at,status,fired_at,seen_at,completed_at,next_nudge,cycle)
        SELECT id,id,config_id,1,local_at,due_at,due_at,
          CASE WHEN plan_state='done' THEN 'done' WHEN seen_at IS NOT NULL THEN 'seen' WHEN fired_at IS NOT NULL THEN 'fired' ELSE 'scheduled' END,
          fired_at,seen_at,CASE WHEN plan_state='done' THEN coalesce(seen_at,fired_at,due_at) END,next_nudge,cycle FROM reminders;
      UPDATE reminder_deliveries SET occurrence_id=reminder_id WHERE occurrence_id IS NULL;
    `);
    if(version<10)db.exec(`
      CREATE TABLE note_lifecycle(
        vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
        object_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN('active','trash','purged')),
        record_id TEXT NOT NULL,
        changed_at INTEGER NOT NULL,
        purge_after INTEGER,
        PRIMARY KEY(vault_id,object_id)
      ) STRICT;
      CREATE INDEX note_lifecycle_cleanup ON note_lifecycle(state,purge_after);
    `);
    if(version<11){
      const columns=new Set(db.prepare('PRAGMA table_info(sessions)').all().map(row=>row.name));
      for(const [name,type] of [['device_id','TEXT'],['device_name','TEXT'],['client_kind','TEXT'],
        ['created_at','INTEGER NOT NULL DEFAULT 0'],['last_seen','INTEGER NOT NULL DEFAULT 0']]){
        if(!columns.has(name))db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${type}`);
      }
      db.exec('CREATE INDEX IF NOT EXISTS sessions_user_active ON sessions(user_id,revoked,last_seen)');
    }
    if(version<12)db.exec(`
      CREATE TABLE webauthn_credentials(
        id TEXT PRIMARY KEY NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        credential_id TEXT NOT NULL UNIQUE,
        public_key BLOB NOT NULL,
        counter INTEGER NOT NULL DEFAULT 0 CHECK(counter>=0),
        transports TEXT NOT NULL DEFAULT '[]',
        device_type TEXT NOT NULL CHECK(device_type IN('singleDevice','multiDevice')),
        backed_up INTEGER NOT NULL DEFAULT 0 CHECK(backed_up IN(0,1)),
        display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 80),
        created_at INTEGER NOT NULL,
        last_used INTEGER
      ) STRICT;
      CREATE INDEX webauthn_credentials_user ON webauthn_credentials(user_id,created_at);
      CREATE TABLE webauthn_challenges(
        id TEXT PRIMARY KEY NOT NULL,
        challenge TEXT NOT NULL UNIQUE,
        purpose TEXT NOT NULL CHECK(purpose IN('register','authenticate')),
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
        expires INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX webauthn_challenges_expiry ON webauthn_challenges(expires);
    `);
    if(version<13)db.exec(`
      CREATE TABLE collaboration_identities(
        user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        version INTEGER NOT NULL CHECK(version>=1),
        public_key TEXT NOT NULL CHECK(length(public_key) BETWEEN 80 AND 1024),
        private_box TEXT NOT NULL CHECK(length(private_box) BETWEEN 80 AND 8192),
        password_wrapper TEXT NOT NULL CHECK(length(password_wrapper) BETWEEN 80 AND 8192),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE contact_requests(
        id TEXT PRIMARY KEY NOT NULL,
        sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        CHECK(sender_id<>recipient_id), UNIQUE(sender_id,recipient_id)
      ) STRICT;
      CREATE INDEX contact_requests_recipient ON contact_requests(recipient_id,created_at);
      CREATE TABLE contacts(
        user_a TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        user_b TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        CHECK(user_a<user_b), PRIMARY KEY(user_a,user_b)
      ) STRICT;
      CREATE TABLE vault_members(
        vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN('owner','editor','viewer')),
        joined_at INTEGER NOT NULL,
        PRIMARY KEY(vault_id,user_id)
      ) STRICT;
      CREATE UNIQUE INDEX vault_one_owner ON vault_members(vault_id) WHERE role='owner';
      CREATE INDEX vault_members_user ON vault_members(user_id,vault_id);
      INSERT INTO vault_members(vault_id,user_id,role,joined_at)
        SELECT id,user_id,'owner',0 FROM vaults;
      CREATE TABLE vault_keyrings(
        vault_id TEXT PRIMARY KEY NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
        version INTEGER NOT NULL CHECK(version>=1),
        current_epoch INTEGER NOT NULL CHECK(current_epoch>=0),
        owner_box TEXT NOT NULL CHECK(length(owner_box) BETWEEN 40 AND 32768),
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE vault_invites(
        id TEXT PRIMARY KEY NOT NULL,
        vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
        inviter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN('editor','viewer')),
        keyring_version INTEGER NOT NULL CHECK(keyring_version>=1),
        identity_version INTEGER NOT NULL CHECK(identity_version>=1),
        key_envelope TEXT NOT NULL CHECK(length(key_envelope) BETWEEN 80 AND 65536),
        created_at INTEGER NOT NULL,
        UNIQUE(vault_id,recipient_id)
      ) STRICT;
      CREATE INDEX vault_invites_recipient ON vault_invites(recipient_id,created_at);
      CREATE TABLE vault_member_envelopes(
        vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        keyring_version INTEGER NOT NULL CHECK(keyring_version>=1),
        identity_version INTEGER NOT NULL CHECK(identity_version>=1),
        key_envelope TEXT NOT NULL CHECK(length(key_envelope) BETWEEN 80 AND 65536),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(vault_id,user_id)
      ) STRICT;
      CREATE TABLE comments(
        id TEXT PRIMARY KEY NOT NULL,
        vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
        object_id TEXT NOT NULL,
        author_user_id TEXT NOT NULL REFERENCES users(id),
        key_epoch INTEGER NOT NULL CHECK(key_epoch>=0),
        payload TEXT NOT NULL CHECK(length(payload) BETWEEN 20 AND 1399000),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER
      ) STRICT;
      CREATE INDEX comments_note ON comments(vault_id,object_id,created_at);
      CREATE TABLE personal_reminder_configs(
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
        object_id TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        payload TEXT NOT NULL CHECK(length(payload) BETWEEN 20 AND 1399000),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(user_id,vault_id,object_id)
      ) STRICT;
      CREATE INDEX personal_reminder_configs_vault ON personal_reminder_configs(user_id,vault_id);
      CREATE TABLE collaboration_deliveries(
        id TEXT PRIMARY KEY NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL CHECK(event_type IN('friend_request','vault_invite','comment','role_changed','member_removed','key_changed')),
        vault_id TEXT,
        object_id TEXT,
        created_at INTEGER NOT NULL,
        due_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN('scheduled','sending','accepted','expired','failed','unknown')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
        lease_until INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE INDEX collaboration_delivery_due ON collaboration_deliveries(status,due_at);

      ALTER TABLE records ADD COLUMN author_user_id TEXT;
      ALTER TABLE records ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
      UPDATE records SET author_user_id=(SELECT user_id FROM vaults WHERE vaults.id=records.vault_id)
        WHERE author_user_id IS NULL;
      CREATE INDEX records_author ON records(vault_id,author_user_id,created_at);
      ALTER TABLE vault_grants ADD COLUMN user_id TEXT;
      UPDATE vault_grants SET user_id=(SELECT user_id FROM vaults WHERE vaults.id=vault_grants.vault_id) WHERE user_id IS NULL;
      CREATE INDEX vault_grants_user ON vault_grants(vault_id,user_id);
      ALTER TABLE vault_challenges ADD COLUMN user_id TEXT;
      UPDATE vault_challenges SET user_id=(SELECT user_id FROM vaults WHERE vaults.id=vault_challenges.vault_id) WHERE user_id IS NULL;
      CREATE INDEX vault_challenges_user ON vault_challenges(vault_id,user_id);

      DROP TRIGGER reminder_record_changed;
      DROP TRIGGER reminder_vault_deleted;
      CREATE TEMP TABLE reminders_backup AS SELECT * FROM reminders;
      CREATE TEMP TABLE reminder_occurrences_backup AS SELECT * FROM reminder_occurrences;
      CREATE TEMP TABLE reminder_deliveries_backup AS SELECT * FROM reminder_deliveries;
      DROP TABLE reminder_deliveries;
      DROP TABLE reminder_occurrences;
      DROP TABLE reminders;
      CREATE TABLE reminders(
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        vault_id TEXT NOT NULL REFERENCES vaults(id),
        object_id TEXT NOT NULL,
        config_id TEXT NOT NULL,
        record_id TEXT NOT NULL,
        local_at TEXT NOT NULL,
        due_at INTEGER,
        plan_state TEXT NOT NULL CHECK(plan_state IN('active','off','done')),
        body TEXT,
        paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN(0,1)),
        fired_at INTEGER,
        seen_at INTEGER,
        next_nudge INTEGER,
        cycle INTEGER NOT NULL DEFAULT 0 CHECK(cycle>=0),
        schedule TEXT NOT NULL DEFAULT '{"repeat":{"type":"once"},"end":{"type":"never"},"allDay":false,"important":false}',
        UNIQUE(user_id,vault_id,object_id)
      ) STRICT;
      CREATE TABLE reminder_occurrences(
        id TEXT PRIMARY KEY,
        reminder_id TEXT NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
        config_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK(sequence>0),
        scheduled_local TEXT NOT NULL,
        due_at INTEGER,
        snooze_local TEXT,
        effective_due_at INTEGER,
        status TEXT NOT NULL CHECK(status IN('scheduled','fired','seen','done','skipped','missed')),
        fired_at INTEGER,
        seen_at INTEGER,
        completed_at INTEGER,
        next_nudge INTEGER,
        cycle INTEGER NOT NULL DEFAULT 0 CHECK(cycle>=0),
        UNIQUE(reminder_id,sequence)
      ) STRICT;
      CREATE INDEX reminder_occurrence_due ON reminder_occurrences(status,effective_due_at);
      CREATE TABLE reminder_deliveries(
        id TEXT PRIMARY KEY,
        reminder_id TEXT NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
        subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
        cycle INTEGER NOT NULL CHECK(cycle>0),
        status TEXT NOT NULL CHECK(status IN('scheduled','sending','accepted','expired','failed','unknown')),
        due_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
        lease_until INTEGER NOT NULL DEFAULT 0,
        occurrence_id TEXT
      ) STRICT;
      CREATE INDEX reminder_delivery_due ON reminder_deliveries(status,due_at);
      INSERT INTO reminders SELECT * FROM reminders_backup;
      INSERT INTO reminder_occurrences SELECT * FROM reminder_occurrences_backup;
      INSERT INTO reminder_deliveries SELECT * FROM reminder_deliveries_backup;
      DROP TABLE reminders_backup;
      DROP TABLE reminder_occurrences_backup;
      DROP TABLE reminder_deliveries_backup;
      CREATE TRIGGER reminder_record_changed AFTER INSERT ON records BEGIN
        UPDATE reminders SET paused=1 WHERE vault_id=NEW.vault_id AND object_id=NEW.object_id;
        DELETE FROM reminder_deliveries WHERE reminder_id IN(
          SELECT id FROM reminders WHERE vault_id=NEW.vault_id AND object_id=NEW.object_id);
      END;
      CREATE TRIGGER reminder_vault_deleted AFTER UPDATE OF deleted ON vaults WHEN NEW.deleted=1 BEGIN
        DELETE FROM reminders WHERE vault_id=NEW.id;
      END;
    `);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
