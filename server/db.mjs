import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { migrate } from './migrations.mjs';

export function openDatabase(dataDir, { countBoot = true } = {}) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'tasks.sqlite'), {
    timeout: 5000,
    enableForeignKeyConstraints: true,
  });
  try {
    db.exec('PRAGMA journal_mode = WAL');
    migrate(db);
    if (countBoot) {
      db.prepare('UPDATE installation SET boot_count = boot_count + 1 WHERE id = 1').run();
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
