import test from 'node:test';
import assert from 'node:assert/strict';
import { asOCRError, OCRError, throwIfOCRAborted } from '../src/ocr/errors.ts';

test('OCR cancellation has a stable machine-readable error code', () => {
  const controller = new AbortController();
  controller.abort('user request');

  assert.throws(
    () => throwIfOCRAborted(controller.signal),
    (error) => error instanceof OCRError
      && error.code === 'cancelled'
      && error.userMessage === 'Распознавание отменено.',
  );
});

test('OCR errors preserve known errors and normalize unknown failures', () => {
  const known = new OCRError('invalid-image', 'Неверный файл.');
  assert.equal(asOCRError(known), known);

  const normalized = asOCRError(new Error('runtime failed'), 'backend-failed');
  assert.equal(normalized.code, 'backend-failed');
  assert.equal(normalized.userMessage, 'runtime failed');
});
