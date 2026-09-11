import { DatabaseSync, backup } from 'node:sqlite';
import { resolve } from 'node:path';
import { open, unlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// No application DB import: this tool must not migrate an old database or count a boot.
export async function createBackup(source, destination) {
  const from = resolve(source);
  const to = resolve(destination);
  if (from === to) throw new Error('Backup destination must differ from source');
  const db = new DatabaseSync(from, { readOnly: true });
  let reserved = false;
  try {
    const file = await open(to, 'wx', 0o600);
    reserved = true;
    await file.close();
    const version = db.prepare('PRAGMA user_version').get().user_version;
    await backup(db, to);
    const copy = new DatabaseSync(to, { readOnly: true });
    try {
      const integrity = copy.prepare('PRAGMA integrity_check').all();
      if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error('Backup integrity check failed');
      if (copy.prepare('PRAGMA user_version').get().user_version !== version) throw new Error('Backup schema changed');
    } finally { copy.close(); }
    return { schemaVersion: version };
  } catch (error) {
    if (reserved) await unlink(to).catch(() => {}); // Only our newly reserved, incomplete backup.
    throw error;
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [source, destination] = process.argv.slice(2);
  if (!source || !destination) {
    console.error('Usage: node server/cli/backup.mjs SOURCE.sqlite DESTINATION.sqlite');
    process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(await createBackup(source, destination))); }
    catch { console.error('Backup failed. Check source, destination, permissions and available space. Existing backups are not overwritten.'); process.exitCode = 1; }
  }
}
