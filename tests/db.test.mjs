import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/db.mjs';
import { createBackup } from '../server/cli/backup.mjs';
import { prepareRestore } from '../server/cli/restore.mjs';
import { migrate } from '../server/migrations.mjs';
import { stripSchema13 } from './schema-helpers.mjs';

test('schema 3 upgrades atomically to current version without changing installation or account credentials', () => {
  const db = new DatabaseSync(':memory:');
  try {
    migrate(db);stripSchema13(db);
    db.exec('DROP TABLE webauthn_challenges; DROP TABLE webauthn_credentials;');
    db.exec("DROP TABLE note_lifecycle; DROP TRIGGER reminder_record_changed; DROP TRIGGER reminder_vault_deleted; DROP TABLE reminder_occurrences; DROP TABLE reminder_deliveries; DROP TABLE reminders; DROP TABLE reminder_settings; DROP INDEX records_object; DROP TRIGGER push_revoke_session; DROP TABLE push_tests; DROP TABLE push_subscriptions; DROP TABLE push_test_limits; DROP TABLE push_config; DROP TABLE vault_grants; DROP TABLE vault_challenges; DROP TABLE vault_closures; DROP TABLE records; DROP TABLE vaults; PRAGMA user_version=3; INSERT INTO users(id,login,password_hash,role,created_at) VALUES('owner','owner','stored-hash','admin',123);");
    const installation = db.prepare('SELECT * FROM installation').get(), user = db.prepare('SELECT * FROM users').get();
    migrate(db); migrate(db);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version,14);
    assert.deepEqual(db.prepare('SELECT * FROM installation').get(),installation);
    assert.deepEqual(db.prepare('SELECT * FROM users').get(),user);
    assert.equal(db.prepare('SELECT count(*) n FROM vaults').get().n,0);
  } finally { db.close(); }
});

test('schema 4 vault headers and immutable ciphertext survive the access migration', () => {
  const db = new DatabaseSync(':memory:');
  try {
    migrate(db);stripSchema13(db);
    db.exec('DROP TABLE webauthn_challenges; DROP TABLE webauthn_credentials;');
    db.exec(`DROP TABLE note_lifecycle; DROP TRIGGER reminder_record_changed; DROP TRIGGER reminder_vault_deleted; DROP TABLE reminder_occurrences; DROP TABLE reminder_deliveries; DROP TABLE reminders; DROP TABLE reminder_settings; DROP INDEX records_object; DROP TRIGGER push_revoke_session; DROP TABLE push_tests; DROP TABLE push_subscriptions; DROP TABLE push_test_limits; DROP TABLE push_config; DROP TABLE vault_grants; DROP TABLE vault_challenges; DROP TABLE vault_closures;
      ALTER TABLE vaults DROP COLUMN access_pack; ALTER TABLE vaults DROP COLUMN lock_epoch;
      PRAGMA user_version=4;
      INSERT INTO users(id,login,password_hash,role,created_at) VALUES('owner','owner','stored-hash','admin',123);
      INSERT INTO vaults VALUES('vault','owner','opaque-header',0,NULL);
      INSERT INTO records VALUES('revision','vault','object',NULL,'opaque-ciphertext');`);
    const installation=db.prepare('SELECT * FROM installation').get(),users=db.prepare('SELECT * FROM users').all();
    const records=db.prepare('SELECT id,vault_id,object_id,parent_id,payload FROM records').all();
    migrate(db);migrate(db);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version,14);
    assert.deepEqual(db.prepare('SELECT * FROM installation').get(),installation);
    assert.deepEqual(db.prepare('SELECT * FROM users').all(),users);
    assert.deepEqual(db.prepare('SELECT id,vault_id,object_id,parent_id,payload FROM records').all(),records);
    const authorMeta=db.prepare('SELECT author_user_id,created_at FROM records').get();assert.equal(authorMeta.author_user_id,'owner');assert.equal(authorMeta.created_at,0);
    const v=db.prepare('SELECT * FROM vaults').get();
    assert.equal(v.header,'opaque-header');assert.equal(v.lock_epoch,0);assert.equal(v.access_pack,null);
  } finally { db.close(); }
});

test('schema 5 push migration preserves vault grants, sessions and ciphertext byte for byte', () => {
  const db=new DatabaseSync(':memory:');
  try{
    migrate(db);stripSchema13(db);
    db.exec('DROP TABLE webauthn_challenges; DROP TABLE webauthn_credentials;');
    db.exec(`DROP TABLE note_lifecycle; DROP TRIGGER reminder_record_changed; DROP TRIGGER reminder_vault_deleted; DROP TABLE reminder_occurrences; DROP TABLE reminder_deliveries; DROP TABLE reminders; DROP TABLE reminder_settings; DROP INDEX records_object; DROP TRIGGER push_revoke_session; DROP TABLE push_tests; DROP TABLE push_subscriptions; DROP TABLE push_test_limits; DROP TABLE push_config;
      PRAGMA user_version=5;
      INSERT INTO users(id,login,password_hash,role,created_at) VALUES('owner','owner','hash','admin',123);
      INSERT INTO sessions(id,user_id,access_hash,access_expires,refresh_hash,refresh_expires,absolute_expires,revoked) VALUES('session','owner','access',999,'refresh',999,999,0);
      INSERT INTO vaults VALUES('vault','owner','header',0,NULL,2,'encrypted-access');
      INSERT INTO records VALUES('record','vault','object',NULL,'ciphertext');
      INSERT INTO vault_grants VALUES('grant','vault','device',2);`);
    const tables=['users','sessions','vaults','installation'];
    const before=tables.map(table=>db.prepare('SELECT * FROM '+table).all());
    const beforeRecords=db.prepare('SELECT id,vault_id,object_id,parent_id,payload FROM records').all();
    const beforeGrants=db.prepare('SELECT token_hash,vault_id,device_id,epoch FROM vault_grants').all();
    migrate(db);migrate(db);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version,14);
    assert.deepEqual(tables.map(table=>db.prepare('SELECT * FROM '+table).all()),before);
    assert.deepEqual(db.prepare('SELECT id,vault_id,object_id,parent_id,payload FROM records').all(),beforeRecords);
    assert.deepEqual(db.prepare('SELECT token_hash,vault_id,device_id,epoch FROM vault_grants').all(),beforeGrants);
    assert.equal(db.prepare('SELECT user_id FROM vault_grants').get().user_id,'owner');
    assert.equal(db.prepare('SELECT count(*) n FROM push_subscriptions').get().n,0);
  }finally{db.close();}
});

test('schema 6 reminder migration preserves subscriptions, VAPID keys, sessions and ciphertext byte for byte',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    migrate(db);stripSchema13(db);
    db.exec('DROP TABLE webauthn_challenges; DROP TABLE webauthn_credentials;');
    db.exec(`DROP TABLE note_lifecycle; DROP TRIGGER reminder_record_changed; DROP TRIGGER reminder_vault_deleted; DROP TABLE reminder_occurrences; DROP TABLE reminder_deliveries; DROP TABLE reminders; DROP TABLE reminder_settings; DROP INDEX records_object; PRAGMA user_version=6;
      INSERT INTO users(id,login,password_hash,role,created_at) VALUES('owner','owner','hash','admin',123);
      INSERT INTO sessions(id,user_id,access_hash,access_expires,refresh_hash,refresh_expires,absolute_expires,revoked) VALUES('session','owner','access',999,'refresh',999,999,0);
      INSERT INTO vaults VALUES('vault','owner','opaque-header',0,NULL,0,NULL);
      INSERT INTO records VALUES('record','vault','object',NULL,'opaque-ciphertext');
      INSERT INTO push_config VALUES(1,'public-key','private-key');
      INSERT INTO push_subscriptions VALUES('subscription','owner','session','device','https://web.push.apple.com/id','p256dh','auth');
      INSERT INTO push_tests VALUES('test','subscription',500,600,'scheduled',0,0);`);
    const tables=['users','sessions','vaults','push_config','push_subscriptions','push_tests','installation'];
    const before=tables.map(table=>db.prepare('SELECT * FROM '+table).all()),beforeRecords=db.prepare('SELECT id,vault_id,object_id,parent_id,payload FROM records').all();migrate(db);migrate(db);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version,14);
    assert.deepEqual(tables.map(table=>db.prepare('SELECT * FROM '+table).all()),before);
    assert.deepEqual(db.prepare('SELECT id,vault_id,object_id,parent_id,payload FROM records').all(),beforeRecords);
    assert.deepEqual(db.prepare('SELECT name FROM sqlite_master WHERE type=\'table\' AND name LIKE \'reminder%\' ORDER BY name').all().map(x=>x.name),
      ['reminder_deliveries','reminder_occurrences','reminder_settings','reminders']);
  }finally{db.close();}
});

test('WAL backup preserves schema 1; migration preserves installation and administrative opens do not count boots', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tasks-migration-'));
  let db;
  try {
    const source = join(dir, 'tasks.sqlite');
    db = new DatabaseSync(source);
    db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE installation (id INTEGER PRIMARY KEY, installation_id TEXT, created_at TEXT, boot_count INTEGER);
      INSERT INTO installation VALUES (1, 'preserved-id', '2026-09-10', 7); PRAGMA user_version=1;`);
    const copy = join(dir, 'before.sqlite');
    assert.deepEqual(await createBackup(source, copy), { schemaVersion: 1 });
    const before = await readFile(copy);
    await assert.rejects(createBackup(source, copy), /EEXIST/);
    assert.deepEqual(await readFile(copy), before);
    const restored = join(dir, 'restored');
    assert.deepEqual(await prepareRestore(copy, restored), { schemaVersion: 1 });
    await assert.rejects(prepareRestore(copy, restored), /EEXIST/);
    const restoredDb = new DatabaseSync(join(restored, 'tasks.sqlite'), { readOnly: true });
    assert.equal(restoredDb.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(restoredDb.prepare('SELECT installation_id FROM installation').get().installation_id, 'preserved-id');
    restoredDb.close();
    db.close();
    db = openDatabase(dir, { countBoot: false });
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 14);
    assert.equal(db.prepare('SELECT boot_count FROM installation').get().boot_count, 7);
    assert.equal(db.prepare('SELECT installation_id FROM installation').get().installation_id, 'preserved-id');
    migrate(db);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
    db.close();
    db = openDatabase(dir);
    assert.equal(db.prepare('SELECT boot_count FROM installation').get().boot_count, 8);
    db.close();
    db = new DatabaseSync(copy);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(db.prepare('SELECT boot_count FROM installation').get().boot_count, 7);
    migrate(db); // Test restoration in the separate backup, never production data.
    assert.equal(db.prepare('SELECT installation_id FROM installation').get().installation_id, 'preserved-id');
  } finally { db?.close(); await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 }); }
});

test('schema 7 adds discoverable labels without changing encrypted records or account data',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    migrate(db);stripSchema13(db);db.exec('DROP TABLE webauthn_challenges; DROP TABLE webauthn_credentials;');db.exec(`DROP TABLE note_lifecycle; DROP TRIGGER vault_label_deleted; DROP TABLE vault_labels; DROP TABLE reminder_occurrences;
      ALTER TABLE reminder_deliveries DROP COLUMN occurrence_id; ALTER TABLE reminders DROP COLUMN schedule; ALTER TABLE reminder_settings DROP COLUMN all_day_time; PRAGMA user_version=7;
      INSERT INTO users(id,login,password_hash,role,created_at) VALUES('owner','owner','hash','admin',123);
      INSERT INTO vaults(id,user_id,header) VALUES('vault','owner','opaque-header');
      INSERT INTO records VALUES('record','vault','object',NULL,'opaque-payload');`);
    const tables=['users','vaults','installation'],before=tables.map(t=>db.prepare('SELECT * FROM '+t).all()),beforeRecords=db.prepare('SELECT id,vault_id,object_id,parent_id,payload FROM records').all();
    migrate(db);migrate(db);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version,14);
    assert.deepEqual(tables.map(t=>db.prepare('SELECT * FROM '+t).all()),before);
    assert.deepEqual(db.prepare('SELECT id,vault_id,object_id,parent_id,payload FROM records').all(),beforeRecords);
    assert.equal(db.prepare('SELECT count(*) n FROM vault_labels').get().n,0);
    db.prepare('INSERT INTO vault_labels VALUES(?,?)').run('vault','Название');
    db.exec("UPDATE vaults SET deleted=1 WHERE id='vault'");
    assert.equal(db.prepare('SELECT count(*) n FROM vault_labels').get().n,0);
  }finally{db.close();}
});

test('schema 10 adds device session metadata without changing authentication tokens',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    migrate(db);stripSchema13(db);db.exec('DROP TABLE webauthn_challenges; DROP TABLE webauthn_credentials;');db.exec(`DROP INDEX sessions_user_active;
      ALTER TABLE sessions DROP COLUMN last_seen; ALTER TABLE sessions DROP COLUMN created_at;
      ALTER TABLE sessions DROP COLUMN client_kind; ALTER TABLE sessions DROP COLUMN device_name; ALTER TABLE sessions DROP COLUMN device_id;
      PRAGMA user_version=10; INSERT INTO users(id,login,password_hash,role,created_at) VALUES('owner','owner','hash','admin',123);
      INSERT INTO sessions(id,user_id,access_hash,access_expires,refresh_hash,refresh_expires,absolute_expires,revoked) VALUES('session','owner','access',999,'refresh',999,999,0);`);
    const before=db.prepare('SELECT id,user_id,access_hash,access_expires,refresh_hash,refresh_expires,absolute_expires,revoked FROM sessions').get();
    migrate(db);migrate(db);assert.equal(db.prepare('PRAGMA user_version').get().user_version,14);
    const after=db.prepare('SELECT * FROM sessions').get();for(const [key,value] of Object.entries(before))assert.equal(after[key],value);
    assert.equal(after.device_id,null);assert.equal(after.device_name,null);assert.equal(after.client_kind,null);assert.equal(after.created_at,0);assert.equal(after.last_seen,0);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='sessions_user_active'").get());
  }finally{db.close();}
});

test('schema 11 adds WebAuthn credentials and one-time challenges without changing sessions',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    migrate(db);stripSchema13(db);
    const beforeSession=db.prepare('SELECT * FROM sessions').all();
    db.exec('DROP TABLE webauthn_challenges; DROP TABLE webauthn_credentials; PRAGMA user_version=11;');
    migrate(db);migrate(db);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version,14);
    assert.deepEqual(db.prepare('SELECT * FROM sessions').all(),beforeSession);
    const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'webauthn_%' ORDER BY name").all().map(row=>row.name);
    assert.deepEqual(tables,['webauthn_challenges','webauthn_credentials']);
    const credentialColumns=db.prepare('PRAGMA table_info(webauthn_credentials)').all().map(row=>row.name);
    assert.deepEqual(credentialColumns,['id','user_id','credential_id','public_key','counter','transports','device_type','backed_up','display_name','created_at','last_used']);
  }finally{db.close();}
});

test('schema 12 adds collaboration membership, author metadata and user-scoped grants without changing ciphertext',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    migrate(db);stripSchema13(db);db.exec(`PRAGMA user_version=12;
      INSERT INTO users(id,login,password_hash,role,created_at) VALUES('owner','owner','hash','admin',123);
      INSERT INTO vaults(id,user_id,header,deleted,replacement,lock_epoch,access_pack) VALUES('vault','owner','header',0,NULL,2,'access');
      INSERT INTO records(id,vault_id,object_id,parent_id,payload) VALUES('record','vault','object',NULL,'opaque-ciphertext');
      INSERT INTO vault_grants(token_hash,vault_id,device_id,epoch) VALUES('grant','vault','device',2);
      INSERT INTO vault_challenges(id,vault_id,device_id,epoch,nonce,expires) VALUES('challenge','vault','device',2,'nonce',999);
    `);
    const cipher=db.prepare('SELECT payload FROM records').get().payload;
    migrate(db);migrate(db);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version,14);
    assert.equal(db.prepare('SELECT payload FROM records').get().payload,cipher);
    const member=db.prepare('SELECT user_id,role FROM vault_members WHERE vault_id=?').get('vault');assert.equal(member.user_id,'owner');assert.equal(member.role,'owner');
    assert.equal(db.prepare('SELECT author_user_id FROM records WHERE id=?').get('record').author_user_id,'owner');
    assert.equal(db.prepare('SELECT user_id FROM vault_grants WHERE token_hash=?').get('grant').user_id,'owner');
    assert.equal(db.prepare('SELECT user_id FROM vault_challenges WHERE id=?').get('challenge').user_id,'owner');
    for(const table of ['collaboration_identities','contacts','vault_invites','vault_member_envelopes','comments','personal_reminder_configs'])assert.equal(db.prepare('SELECT count(*) n FROM '+table).get().n,0);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  }finally{db.close();}
});

test('schema 14 adds streaming attachment metadata without changing encrypted collaboration data',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    migrate(db);
    const recordBefore=JSON.stringify(db.prepare('SELECT * FROM records').all()),membersBefore=JSON.stringify(db.prepare('SELECT * FROM vault_members').all());
    db.exec('DROP TABLE record_attachments; DROP TABLE attachments; DROP TABLE file_uploads; PRAGMA user_version=13;');
    migrate(db);migrate(db);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version,14);
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM records').all()),recordBefore);
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM vault_members').all()),membersBefore);
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN('attachments','file_uploads','record_attachments') ORDER BY name").all().map(row=>row.name),['attachments','file_uploads','record_attachments']);
    assert.equal(db.prepare('SELECT count(*) n FROM attachments').get().n,0);
    assert.equal(db.prepare('SELECT count(*) n FROM file_uploads').get().n,0);
    assert.equal(db.prepare('SELECT count(*) n FROM record_attachments').get().n,0);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  }finally{db.close();}
});

test('failed and future migrations leave the previous schema intact', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE users (id TEXT); PRAGMA user_version=1;');
    assert.throws(() => migrate(db));
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='auth_state'").get(), undefined);
    db.exec('PRAGMA user_version=99;');
    assert.throws(() => migrate(db), /newer/);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 99);
  } finally { db.close(); }
});
