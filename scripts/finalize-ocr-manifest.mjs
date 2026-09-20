import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const distRoot = resolve('dist');
const assetsRoot = resolve(distRoot, 'assets');
const manifestPath = resolve(distRoot, 'ocr-models/manifest.json');

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const assetFiles = (await readdir(assetsRoot, { withFileTypes: true }))
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
  .sort();

async function distAsset(name) {
  const path = resolve(assetsRoot, name);
  const info = await stat(path);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return {
    url: '/assets/' + name,
    bytes: info.size,
    sha256: hash.digest('hex'),
  };
}

async function matchingAssets(patterns) {
  const names = assetFiles.filter((name) => patterns.some((pattern) => pattern.test(name)));
  return await Promise.all(names.map(distAsset));
}

function mergeAssets(modelPackage, additions) {
  const byUrl = new Map(modelPackage.assets.map((asset) => [asset.url, asset]));
  for (const asset of additions) byUrl.set(asset.url, asset);
  modelPackage.assets = [...byUrl.values()].sort((a, b) => a.url.localeCompare(b.url));
  modelPackage.bytes = modelPackage.assets.reduce((sum, asset) => sum + asset.bytes, 0);
  modelPackage.integrity = createHash('sha256')
    .update(JSON.stringify(modelPackage.assets))
    .digest('hex');
}

const sharedOrtBundles = await matchingAssets([
  /^ort\.bundle\.min-.*\.js$/,
  /^ort-wasm-simd-threaded\.(?:asyncify|jsep)-.*\.wasm$/,
]);

const printedBundles = await matchingAssets([
  /^dist-.*\.js$/,
  /^worker-entry-.*\.js$/,
]);

const handwritingBundles = await matchingAssets([
  /^htr\.worker-.*\.js$/,
]);

mergeAssets(
  manifest.packages['printed-ru-en-v1'],
  [...sharedOrtBundles, ...printedBundles],
);
mergeAssets(
  manifest.packages['handwriting-ru-v1'],
  [...sharedOrtBundles, ...handwritingBundles],
);
mergeAssets(
  manifest.packages['handwriting-en-v1'],
  [...sharedOrtBundles, ...handwritingBundles],
);

manifest.version = 3;
manifest.runtimeComplete = true;

await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log('OCR runtime manifest finalized.');
