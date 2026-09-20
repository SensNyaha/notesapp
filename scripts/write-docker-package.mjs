import { readFile, writeFile } from 'node:fs/promises';

const source = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const dependencyManifest = {
  name: 'tasks-docker-dependencies',
  version: '0.0.0',
  private: true,
};

for (const field of [
  'allowScripts',
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'bundledDependencies',
  'bundleDependencies',
  'overrides',
  'workspaces',
]) {
  if (source[field] !== undefined) dependencyManifest[field] = source[field];
}

const target = new URL('../package.docker.json', import.meta.url);
const next = `${JSON.stringify(dependencyManifest, null, 2)}\n`;
let current = '';
try {
  current = await readFile(target, 'utf8');
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
if (current !== next) await writeFile(target, next);
