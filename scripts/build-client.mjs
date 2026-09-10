import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist/vendor', { recursive: true });
await cp('public', 'dist', { recursive: true });
await cp('index.html', 'dist/index.html');
await cp('src/style.css', 'dist/style.css');
await cp('src/main.js', 'dist/app.js');
await cp('node_modules/preact/dist/preact.module.js', 'dist/vendor/preact.js');

const hooksSource = await readFile('node_modules/preact/hooks/dist/hooks.module.js', 'utf8');
const hooks = hooksSource.replace('from"preact"', 'from"/vendor/preact.js"');
if (hooks === hooksSource) throw new Error('Unexpected Preact hooks module: import was not rewritten');
await writeFile('dist/vendor/hooks.js', hooks);

console.log('Client: copied public shell and pinned Preact browser modules');
