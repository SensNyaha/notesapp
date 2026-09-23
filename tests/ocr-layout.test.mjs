import test from 'node:test';
import assert from 'node:assert/strict';
import { composeOCRText, normalizeOCRTechnicalText, resolveReadingOrder } from '../src/ocr/layout.ts';

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

test('OCR reading order does not treat inline technical badges as a second column', () => {
  const lines = [
    line('заголовок', 10, 0, 390, 18),
    line('обычный абзац', 10, 24, 280, 44),
    line('notesapp.sensnyaha.ru', 300, 24, 390, 44),
    line('пункт один', 30, 60, 245, 80),
    line('пункт два', 30, 86, 245, 106),
    line('пункт три', 30, 112, 245, 132),
    line('5.183.189.127', 300, 112, 390, 132),
    line('следующий широкий абзац', 10, 150, 390, 170),
    line('последняя строка', 10, 186, 280, 206),
    line('traceroute/mtr', 300, 186, 390, 206),
  ];
  assert.deepEqual(resolveReadingOrder(lines).map(({ text }) => text), [
    'заголовок',
    'обычный абзац', 'notesapp.sensnyaha.ru',
    'пункт один', 'пункт два',
    'пункт три', '5.183.189.127',
    'следующий широкий абзац',
    'последняя строка', 'traceroute/mtr',
  ]);
});

test('OCR technical text normalizes mixed-script domains and known acronyms', () => {
  assert.equal(
    normalizeOCRTechnicalText('поtеsарр.sепsпуаhа.ru работает через VР№'),
    'notesapp.sensnyaha.ru работает через VPN',
  );
  assert.equal(normalizeOCRTechnicalText('обычный РОМАН и домен.рф'), 'обычный РОМАН и домен.рф');
});

test('OCR text joins fragments detected on the same visual row', () => {
  const lines = [
    line('Доступ к', 10, 10, 90, 30),
    line('поtеsарр.sепsпуаhа.ru', 100, 10, 250, 30),
    line('нормальный', 260, 10, 360, 30),
    line('Следующая строка', 10, 36, 180, 56),
  ];
  assert.equal(
    composeOCRText(lines),
    'Доступ к notesapp.sensnyaha.ru нормальный\nСледующая строка',
  );
});

test('OCR layout helpers do not mutate detector output', () => {
  const lines = [line('B', 10, 30, 50, 40), line('A', 10, 10, 50, 20)];
  const snapshot = structuredClone(lines);
  resolveReadingOrder(lines);
  assert.deepEqual(lines, snapshot);
});
