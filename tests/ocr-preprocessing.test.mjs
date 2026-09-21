import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveOCRDeviceProfile } from '../src/ocr/deviceProfile.ts';
import {
  fitOCRImageSize,
  normalizeOCRPixels,
  validOCRSelectionStrokes,
} from '../src/ocr/imagePreprocessing.ts';

test('OCR device profile limits weak devices without disabling OCR', () => {
  const profile = resolveOCRDeviceProfile({
    deviceMemory: 2,
    hardwareConcurrency: 2,
    webgpu: false,
    offscreenCanvas: false,
    createImageBitmap: false,
    mobile: true,
  });
  assert.deepEqual(profile, {
    level: 'low',
    maxImageSide: 1280,
    maxImagePixels: 1_500_000,
    htrConcurrency: 1,
    preferredBackend: 'wasm',
  });
});

test('OCR device profile uses the high profile only with complete acceleration', () => {
  const high = resolveOCRDeviceProfile({
    deviceMemory: 8,
    hardwareConcurrency: 12,
    webgpu: true,
    offscreenCanvas: true,
    createImageBitmap: true,
    mobile: false,
  });
  assert.equal(high.level, 'high');
  assert.equal(high.preferredBackend, 'webgpu');

  const mobile = resolveOCRDeviceProfile({
    deviceMemory: 8,
    hardwareConcurrency: 12,
    webgpu: true,
    offscreenCanvas: true,
    createImageBitmap: true,
    mobile: true,
  });
  assert.equal(mobile.level, 'medium');
});

test('OCR resize preserves aspect ratio and respects side and pixel limits', () => {
  assert.deepEqual(fitOCRImageSize(4000, 3000, 1800, 2_800_000), {
    width: 1800,
    height: 1350,
  });
  assert.deepEqual(fitOCRImageSize(2000, 2000, 2048, 1_000_000), {
    width: 1000,
    height: 1000,
  });
  assert.deepEqual(fitOCRImageSize(800, 600, 1800, 2_800_000), {
    width: 800,
    height: 600,
  });
});

test('OCR grayscale keeps alpha and contrast expands the useful range', () => {
  const pixels = new Uint8ClampedArray([
    100, 110, 120, 70,
    140, 150, 160, 255,
  ]);
  normalizeOCRPixels(pixels, true, true);
  assert.equal(pixels[0], pixels[1]);
  assert.equal(pixels[1], pixels[2]);
  assert.equal(pixels[4], pixels[5]);
  assert.equal(pixels[5], pixels[6]);
  assert.equal(pixels[3], 70);
  assert.equal(pixels[7], 255);
  assert.ok(pixels[0] < pixels[4]);
});

test('OCR selection keeps valid marker strokes and ignores malformed ones', () => {
  const valid = { width: 0.12, points: [{ x: 0.2, y: 0.3 }] };
  const result = validOCRSelectionStrokes({
    strokes: [
      valid,
      { width: 0, points: [{ x: 0.2, y: 0.3 }] },
      { width: 0.1, points: [{ x: Number.NaN, y: 0.3 }] },
      { width: 0.1, points: [] },
    ],
  });
  assert.deepEqual(result, [valid]);
  assert.deepEqual(validOCRSelectionStrokes(), []);
});
