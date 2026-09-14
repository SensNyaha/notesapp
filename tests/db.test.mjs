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

test('schema 3 upgrades atomically to current version without changing installation or account credentials', () => {
  const db = new DatabaseSync(':memory:');
  try {
    migrate(db);
    db.exec("DROP TABLE note_lifecycle; DROP TRIGGER reminder_record_changed; DROP TRIGGER reminder_vault_deleted; DROP TABLE reminder_occurrences; DROP TABLE reminder_deliveries; DROP TABLE reminders; DROP TABLE reminder_settings; DROP INDEX records_object; DROP TRIGGER push_revoke_session; DROP TABLE push_tests; DROP TABLE push_subscriptions; DROP TABLE push_test_limits; DROP TABLE push_config; DROP TABLE vault_grants; DROP TABLE vault_challenges; DROP TABLE vault_closures; DROP TABLE records; DROP TABLE vaults; PRAGMA user_version=3; INSERT INTO users(id,login,password_hash,role,created_at) VALUES('owner','owner','stored-hash','admin',123);");
    const installation = db.prepare('SELECT * FROM installation').get(), user = db.prepare('SELECT * FROM users').get();
    migrate(db); migrate(db);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version,10);
    assert.deepEqual(db.prepare('SELECT * FROM installation').get(),installation);
    assert.deepEqual(db.prepare('SELECT * FROM users').get(),user);
    assert.equal(db.prepare('SELECT count(*) n FROM vaults').get().n,0);
  } finally { db.close(); }
});

test('schema 4 vault headers and immutable ciphertext survive the access migration', () => {
  const db = new DatabaseSync(':memory:');
  try {
    migrate(db);
    db.exec(`DROP TABLE note_lifecycle; DROP TRIGGER reminder_record_changed; DROP TRIGGER reminder_vault_deleted; DROP TABLE reminder_occurrences; DROP TABLE reminder_deliveries; DROP TABLE reminders; DROP TABLE reminder_settings; DROP INDEX records_object; DROP TRIGGER push_revoke_session; DROP TABLE push_tests; DROP TABLE push_subscriptions; DROP TABLE push_test_limits; DROP TABLE push_config; DROP TABLE vault_grants; DROP TABLE vault_challenges; DROP TABLE vault_closures;
      ALTER TABLE vaults DROP COLUMN access_pack; ALTER TABLE vaults DROP COLUMN lock_epoch;
      PRAGMA user_version=4;
      INSERT INTO users(id,login,password_hash,role,created_at) VALUES('owner','owner','stored-hash','admin',123);
      INSERT INTO vaults VALUES('vault','owner','opaque-header',0,NULL);
      INSERT INTO records VALUES('revision','vault','object',NULL,'opaque-ciphertext');`);
    const installation=db.prepare('SELECT * FROM installation').get(),users=db.prepare('SELECT * FROM users').all();
    const records=db.prepare('SELECT * FROM records').all();
    migrate(db);migrate(db);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version,10);
    assert.deepEqual(db.prepare('SELECT * FROM installation').get(),installation);
    assert.deepEqual(db.prepare('SELECT * FROM users').all(),users);
    assert.deepEqual(db.prepare('SELECT * FROM records').all(),records);
    const v=db.prepare('SELECT * FROM vaults').get();
    assert.equal(v.header,'opaque-header');assert.equal(v.lock_epoch,0);assert.equal(v.access_pack,null);
  } finally { db.close(); }
});

test('schema 5 push migration preserves vault grants, sessions and ciphertext byte for byte', () => {
  const db=new DatabaseSync(':memory:');
  try{
    migrate(db);
    db.exec(`DROP TABLE note_lifecycle; DROP TRIGGER reminder_record_changed; DROP TRIGGER reminder_vault_deleted; DROP TABLE reminder_occurrences; DROP TABLE reminder_deliveries; DROP TABLE reminders; DROP TABLE reminder_settings; DROP INDEX records_object; DROP TRIGGER push_revoke_session; DROP TABLE push_tests; DROP TABLE push_subscriptions; DROP TABLE push_test_limits; DROP TABLE push_config;
      PRAGMA user_version=5;
      INSERT INTO users(id,login,password_hash,role,created_at) VALUES('owner','owner','hash','admin',123);
      INSERT INTO sessions VALUES('session','owner','access',999,'refresh',999,999,0);
      INSERT INTO vaults VALUES('vault','owner','header',0,NULL,2,'encrypted-access');
      INSERT INTO records VALUES('record','vault','object',NULL,'ciphertext');
      INSERT INTO vault_grants VALUES('grant','vault','device',2);`);
    const tables=['users','sessions','vaults','records','vault_grants','installation'];
    const before=tables.map(table=>db.prepare('SELECT * FROM '+table).all());
    migrate(db);migrate(db);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version,10);
    assert.deepEqual(tables.map(table=>db.prepare('SELECT * FROM '+table).all()),before);
    assert.equal(db.prepare('SELECT count(*) n FROM push_subscriptions').get().n,0);
  }finally{db.close();}
});

test('schema 6 reminder migration preserves subscriptions, VAPID keys, sessions and ciphertext byte for byte',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    migrate(db);
    db.exec(`DROP TABLE note_lifecycle; DROP TRIGGER reminder_record_changed; DROP TRIGGER reminder_vault_deleted; DROP TABLE reminder_occurrences; DROP TABLE reminder_deliveries; DROP TABLE reminders; DROP TABLE reminder_settings; DROP INDEX records_object; PRAGMA user_version=6;
      INSERT INTO users(id,login,password_hash,role,created_at) VALUES('owner','owner','hash','admin',123);
      INSERT INTO sessions VALUES('session','owner','access',999,'refresh',999,999,0);
      INSERT INTO vaults VALUES('vault','owner','opaque-header',0,NULL,0,NULL);
      INSERT INTO records VALUES('record','vault','object',NULL,'opaque-ciphertext');
      INSERT INTO push_config VALUES(1,'public-key','private-key');
      INSERT INTO push_subscriptions VALUES('subscription','owner','session','device','https://web.push.apple.com/id','p256dh','auth');
      INSERT INTO push_tests VALUES('test','subscription',500,600,'scheduled',0,0);`);
    const tables=['users','sessions','vaults','records','push_config','push_subscriptions','push_tests','installation'];
    const before=tables.map(table=>db.prepare('SELECT * FROM '+table).all());migrate(db);migrate(db);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version,10);
    assert.deepEqual(tables.map(table=>db.prepare('SELECT * FROM '+table).all()),before);
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
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 10);
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
  } finally { db?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('schema 7 adds discoverable labels without changing encrypted records or account data',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    migrate(db);db.exec(`DROP TABLE note_lifecycle; DROP TRIGGER vault_label_deleted; DROP TABLE vault_labels; DROP TABLE reminder_occurrences;
      ALTER TABLE reminder_deliveries DROP COLUMN occurrence_id; ALTER TABLE reminders DROP COLUMN schedule; ALTER TABLE reminder_settings DROP COLUMN all_day_time; PRAGMA user_version=7;
      INSERT INTO users(id,login,password_hash,role,created_at) VALUES('owner','owner','hash','admin',123);
      INSERT INTO vaults(id,user_id,header) VALUES('vault','owner','opaque-header');
      INSERT INTO records VALUES('record','vault','object',NULL,'opaque-payload');`);
    const tables=['users','vaults','records','installation'],before=tables.map(t=>db.prepare('SELECT * FROM '+t).all());
    migrate(db);migrate(db);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version,10);
    assert.deepEqual(tables.map(t=>db.prepare('SELECT * FROM '+t).all()),before);
    assert.equal(db.prepare('SELECT count(*) n FROM vault_labels').get().n,0);
    db.prepare('INSERT INTO vault_labels VALUES(?,?)').run('vault','Название');
    db.exec("UPDATE vaults SET deleted=1 WHERE id='vault'");
    assert.equal(db.prepare('SELECT count(*) n FROM vault_labels').get().n,0);
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
