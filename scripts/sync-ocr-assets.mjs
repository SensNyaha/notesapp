import {
  copyFile,
  mkdir,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tessRoot = resolve(root, 'public/ocr-tesseract');
const runtimeRoot = resolve(root, 'public/ocr-runtime');
const modelsRoot = resolve(root, 'public/ocr-models');

async function copy(source, target) {
  await mkdir(dirname(resolve(root, target)), { recursive: true });
  await copyFile(resolve(root, source), resolve(root, target));
}

async function listFiles(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(full));
    else result.push(full);
  }
  return result.sort();
}

await rm(tessRoot, { recursive: true, force: true });

await rm(runtimeRoot, { recursive: true, force: true });
await mkdir(runtimeRoot, { recursive: true });

async function copyOrtRuntime(packageName, targetDir) {
  const sourceDir = resolve(root, 'node_modules', packageName, 'dist');
  for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!/^ort-wasm.*\.(?:mjs|wasm)$/.test(entry.name)) continue;
    await copy(
      `node_modules/${packageName}/dist/${entry.name}`,
      `public/ocr-runtime/${targetDir}/${entry.name}`,
    );
  }
}

await copyOrtRuntime('onnxruntime-web-paddle', 'paddle');
await copyOrtRuntime('onnxruntime-web', 'htr');

const paddleDet = resolve(modelsRoot, 'paddle/det');
const paddleRec = resolve(modelsRoot, 'paddle/rec');

// Paddle model.tar files are committed runtime artifacts.
// Raw inference.onnx/inference.yml sources are intentionally not required here.
await Promise.all([
  stat(resolve(paddleDet, 'model.tar')),
  stat(resolve(paddleRec, 'model.tar')),
]);

const packageDefinitions = {
  'printed-ru-en-v1': {
    kind: 'printed',
    required: true,
    assets: [
      resolve(paddleDet, 'model.tar'),
      resolve(paddleRec, 'model.tar'),
    ],
  },
  'handwriting-ru-v1': {
    kind: 'handwriting',
    language: 'ru',
    required: false,
    assets: (await listFiles(resolve(modelsRoot, 'htr/ru')))
      .filter((file) => !file.endsWith('quantize_config.json')),
  },
  'handwriting-en-v1': {
    kind: 'handwriting',
    language: 'en',
    required: false,
    assets: (await listFiles(resolve(modelsRoot, 'htr/en')))
      .filter((file) => !file.endsWith('quantize_config.json')),
  },
};

const manifest = { version: 1, packages: {} };
for (const [id, definition] of Object.entries(packageDefinitions)) {
  const assets = [];
  for (const file of definition.assets) {
    const info = await stat(file);
    assets.push({
      url: '/' + relative(resolve(root, 'public'), file).replaceAll('\\', '/'),
      bytes: info.size,
    });
  }
  manifest.packages[id] = {
    kind: definition.kind,
    ...(definition.language ? { language: definition.language } : {}),
    required: definition.required,
    bytes: assets.reduce((sum, asset) => sum + asset.bytes, 0),
    assets,
  };
}

await writeFile(
  resolve(modelsRoot, 'manifest.json'),
  JSON.stringify(manifest, null, 2) + '\n',
);

console.log('OCR offline assets synchronized.');
