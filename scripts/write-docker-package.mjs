import { readFile, writeFile } from 'node:fs/promises';

const source = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const sourceLock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
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

const dependencyLock = structuredClone(sourceLock);
dependencyLock.name = dependencyManifest.name;
dependencyLock.version = dependencyManifest.version;
if (dependencyLock.packages?.['']) {
  dependencyLock.packages[''].name = dependencyManifest.name;
  dependencyLock.packages[''].version = dependencyManifest.version;
}

async function writeIfChanged(relativePath, value) {
  const target = new URL(relativePath, import.meta.url);
  const next = `${JSON.stringify(value, null, 2)}\n`;
  let current = '';
  try {
    current = await readFile(target, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (current !== next) await writeFile(target, next);
}

await writeIfChanged('../package.docker.json', dependencyManifest);
await writeIfChanged('../package-lock.docker.json', dependencyLock);
