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
    db.exec("DROP TABLE vault_grants; DROP TABLE vault_challenges; DROP TABLE vault_closures; DROP TABLE records; DROP TABLE vaults; PRAGMA user_version=3; INSERT INTO users(id,login,password_hash,role,created_at) VALUES('owner','owner','stored-hash','admin',123);");
    const installation = db.prepare('SELECT * FROM installation').get(), user = db.prepare('SELECT * FROM users').get();
    migrate(db); migrate(db);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version,5);
    assert.deepEqual(db.prepare('SELECT * FROM installation').get(),installation);
    assert.deepEqual(db.prepare('SELECT * FROM users').get(),user);
    assert.equal(db.prepare('SELECT count(*) n FROM vaults').get().n,0);
  } finally { db.close(); }
});

test('schema 4 vault headers and immutable ciphertext survive the access migration', () => {
  const db = new DatabaseSync(':memory:');
  try {
    migrate(db);
    db.exec(`DROP TABLE vault_grants; DROP TABLE vault_challenges; DROP TABLE vault_closures;
      ALTER TABLE vaults DROP COLUMN access_pack; ALTER TABLE vaults DROP COLUMN lock_epoch;
      PRAGMA user_version=4;
      INSERT INTO users(id,login,password_hash,role,created_at) VALUES('owner','owner','stored-hash','admin',123);
      INSERT INTO vaults VALUES('vault','owner','opaque-header',0,NULL);
      INSERT INTO records VALUES('revision','vault','object',NULL,'opaque-ciphertext');`);
    const installation=db.prepare('SELECT * FROM installation').get(),users=db.prepare('SELECT * FROM users').all();
    const records=db.prepare('SELECT * FROM records').all();
    migrate(db);migrate(db);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version,5);
    assert.deepEqual(db.prepare('SELECT * FROM installation').get(),installation);
    assert.deepEqual(db.prepare('SELECT * FROM users').all(),users);
    assert.deepEqual(db.prepare('SELECT * FROM records').all(),records);
    const v=db.prepare('SELECT * FROM vaults').get();
    assert.equal(v.header,'opaque-header');assert.equal(v.lock_epoch,0);assert.equal(v.access_pack,null);
  } finally { db.close(); }
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
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5);
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
