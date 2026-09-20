import test from 'node:test';
import assert from 'node:assert/strict';
import { composeOCRText, resolveReadingOrder } from '../src/ocr/layout.ts';

const line = (text, left, top, right, bottom) => ({
  text,
  engine: 'paddle',
  poly: [
    { x: left, y: top }, { x: right, y: top },
    { x: right, y: bottom }, { x: left, y: bottom },
  ],
});

test('OCR reading order keeps ordinary rows and paragraph gaps', () => {
  const lines = [
    line('третья', 10, 85, 120, 105),
    line('первая', 10, 10, 120, 30),
    line('вторая', 10, 35, 120, 55),
  ];
  assert.deepEqual(resolveReadingOrder(lines).map(({ text }) => text), [
    'первая', 'вторая', 'третья',
  ]);
  assert.equal(composeOCRText(lines), 'первая\nвторая\n\nтретья');
});

test('OCR reading order reads simple columns from top to bottom, left to right', () => {
  const lines = [
    line('право 2', 230, 45, 390, 65),
    line('лево 1', 10, 15, 170, 35),
    line('заголовок', 10, 0, 390, 10),
    line('право 1', 230, 15, 390, 35),
    line('лево 2', 10, 45, 170, 65),
  ];
  assert.deepEqual(resolveReadingOrder(lines).map(({ text }) => text), [
    'заголовок', 'лево 1', 'лево 2', 'право 1', 'право 2',
  ]);
});

test('OCR layout helpers do not mutate detector output', () => {
  const lines = [line('B', 10, 30, 50, 40), line('A', 10, 10, 50, 20)];
  const snapshot = structuredClone(lines);
  resolveReadingOrder(lines);
  assert.deepEqual(lines, snapshot);
});
