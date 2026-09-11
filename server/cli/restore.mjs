import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBackup } from './backup.mjs';

// Restore into a NEW directory only. Never overwrite a live DB or its WAL files.
export async function prepareRestore(source, directory) {
  const destination = resolve(directory);
  await mkdir(destination, { mode: 0o700 }); // EEXIST is intentional, including empty directories.
  return createBackup(source, join(destination, 'tasks.sqlite'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [source, directory] = process.argv.slice(2);
  if (!source || !directory) {
    console.error('Usage: node server/cli/restore.mjs SOURCE.sqlite NEW_DIRECTORY');
    process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(await prepareRestore(source, directory))); }
    catch { console.error('Restore failed. Destination must be a new directory with a writable parent. Original data was not replaced.'); process.exitCode = 1; }
  }
}
