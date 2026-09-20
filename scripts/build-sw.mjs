import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative } from 'node:path';

const root = resolve('dist');
async function list(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) result.push(...await list(full));
    else if (entry.name !== 'sw.js') result.push(full);
  }
  return result.sort();
}
const paths = await list(root);
const hash = createHash('sha256');
for (const path of paths) { hash.update(relative(root, path)); hash.update(await readFile(path)); }
const version = hash.digest('hex').slice(0, 16);
const shellPaths = [];
for (const path of paths) {
  const rel = relative(root, path).replaceAll('\\', '/');
  const size = (await stat(path)).size;
  const deferredOcrModel =
    rel.startsWith('ocr-models/') &&
    rel !== 'ocr-models/manifest.json';
  const deferredOcrBundle =
    /(?:htr\.worker-|worker-entry-|ort\.bundle\.min-)/.test(rel) ||
    (rel.startsWith('assets/dist-') && size > 5_000_000);
  if (!deferredOcrModel && !deferredOcrBundle)
    shellPaths.push(path);
}
const assets = shellPaths.map(path => '/' + relative(root, path).replaceAll('\\', '/'));
const template = await readFile('scripts/sw-template.js', 'utf8');
await writeFile(resolve(root, 'sw.js'), template.replace('__CACHE__', JSON.stringify(`tasks-shell-${version}`)).replace('__ASSETS__', JSON.stringify(assets)));
console.log(`Service Worker: ${assets.length} public assets, version ${version}`);
