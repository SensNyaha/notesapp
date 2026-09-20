import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  hasEnoughOCRStorage,
  validateOCRModelManifest,
} from '../src/ocr/OCRModelManager.ts';

const packageIds = [
  'printed-ru-en-v1',
  'handwriting-ru-v1',
  'handwriting-en-v1',
];

function manifestFixture() {
  const packages = {};
  for (const [index, id] of packageIds.entries()) {
    const assets = [{
      url: `/ocr-models/test/${index}.bin`,
      bytes: index + 1,
      sha256: 'a'.repeat(64),
    }];
    packages[id] = {
      kind: index === 0 ? 'printed' : 'handwriting',
      ...(index === 1 ? { language: 'ru' } : {}),
      ...(index === 2 ? { language: 'en' } : {}),
      required: index === 0,
      version: '1',
      bytes: index + 1,
      assets,
      integrity: bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(assets)))),
    };
  }
  return { version: 3, runtimeComplete: true, packages };
}

test('OCR model manifest validates versions, sizes and package integrity', () => {
  const manifest = manifestFixture();
  assert.equal(validateOCRModelManifest(manifest), manifest);

  const tampered = structuredClone(manifest);
  tampered.packages['handwriting-ru-v1'].assets[0].bytes += 1;
  assert.throws(
    () => validateOCRModelManifest(tampered),
    (error) => error.code === 'model-integrity-failed',
  );
});

test('built OCR model manifest contains valid hashes for every runtime asset', async () => {
  const manifest = JSON.parse(
    await readFile('dist/ocr-models/manifest.json', 'utf8'),
  );
  validateOCRModelManifest(manifest);
  for (const modelPackage of Object.values(manifest.packages)) {
    assert.ok(modelPackage.assets.every(
      (asset) => /^[a-f0-9]{64}$/.test(asset.sha256),
    ));
  }
});

test('OCR model manifest rejects external and duplicate asset locations', () => {
  const manifest = manifestFixture();
  const model = manifest.packages['printed-ru-en-v1'];
  model.assets[0].url = '//external.example/model.bin';
  model.integrity = bytesToHex(
    sha256(new TextEncoder().encode(JSON.stringify(model.assets))),
  );
  assert.throws(() => validateOCRModelManifest(manifest));
});

test('OCR storage check preserves a safety reserve', () => {
  const mib = 1024 * 1024;
  assert.equal(hasEnoughOCRStorage(100 * mib, {
    quota: 500 * mib,
    usage: 300 * mib,
  }), true);
  assert.equal(hasEnoughOCRStorage(100 * mib, {
    quota: 500 * mib,
    usage: 395 * mib,
  }), false);
  assert.equal(hasEnoughOCRStorage(100 * mib, {}), true);
});
