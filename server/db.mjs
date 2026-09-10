import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function openDatabase(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'tasks.sqlite'), {
    timeout: 5000,
    enableForeignKeyConstraints: true,
  });
  try {
    db.exec('PRAGMA journal_mode = WAL');
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version > 1) throw new Error('Database schema is newer than this application');
    db.exec('BEGIN IMMEDIATE');
    try {
      if (version === 0) {
        db.exec(`CREATE TABLE installation (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          installation_id TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          boot_count INTEGER NOT NULL DEFAULT 0
        ) STRICT`);
        db.prepare('INSERT INTO installation (id, installation_id, created_at) VALUES (1, ?, ?)')
          .run(randomUUID(), new Date().toISOString());
        db.exec('PRAGMA user_version = 1');
      }
      db.prepare('UPDATE installation SET boot_count = boot_count + 1 WHERE id = 1').run();
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
