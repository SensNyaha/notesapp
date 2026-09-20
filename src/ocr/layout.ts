import type { OCRLine } from "./types.ts";

export interface OCRLineBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export function ocrLineBounds(line: OCRLine): OCRLineBounds {
  const points = line.poly ?? [];
  if (!points.length)
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const right = Math.max(...xs);
  const bottom = Math.max(...ys);
  return {
    left,
    top,
    right,
    bottom,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

function median(values: number[]) {
  const filtered = values.filter((value) => Number.isFinite(value) && value > 0);
  if (!filtered.length) return 0;
  const sorted = [...filtered].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function rowOrder(lines: OCRLine[]) {
  return [...lines].sort((a, b) => {
    const ab = ocrLineBounds(a);
    const bb = ocrLineBounds(b);
    const tolerance = Math.max(8, Math.min(ab.height, bb.height) * 0.6);
    if (Math.abs(ab.top - bb.top) <= tolerance) return ab.left - bb.left;
    return ab.top - bb.top;
  });
}

interface ColumnSplit {
  left: OCRLine[];
  right: OCRLine[];
  spanning: OCRLine[];
  score: number;
}

function bestColumnSplit(lines: OCRLine[]): ColumnSplit | null {
  if (lines.length < 4) return null;
  const bounds = lines.map((line) => ({ line, bounds: ocrLineBounds(line) }));
  const medianHeight = median(bounds.map((item) => item.bounds.height));
  const candidates = new Set<number>();
  for (const a of bounds) for (const b of bounds) {
    if (a.bounds.right < b.bounds.left)
      candidates.add((a.bounds.right + b.bounds.left) / 2);
  }

  let best: ColumnSplit | null = null;
  for (const split of candidates) {
    const left = bounds.filter((item) => item.bounds.right < split);
    const right = bounds.filter((item) => item.bounds.left > split);
    if (left.length < 2 || right.length < 2) continue;
    const leftRight = Math.max(...left.map((item) => item.bounds.right));
    const rightLeft = Math.min(...right.map((item) => item.bounds.left));
    const gutter = rightLeft - leftRight;
    if (gutter < Math.max(16, medianHeight * 1.25)) continue;
    const leftTop = Math.min(...left.map((item) => item.bounds.top));
    const leftBottom = Math.max(...left.map((item) => item.bounds.bottom));
    const rightTop = Math.min(...right.map((item) => item.bounds.top));
    const rightBottom = Math.max(...right.map((item) => item.bounds.bottom));
    const overlap = Math.min(leftBottom, rightBottom) - Math.max(leftTop, rightTop);
    if (overlap <= medianHeight) continue;
    const score = gutter * Math.min(left.length, right.length);
    if (!best || score > best.score) {
      const leftLines = new Set(left.map((item) => item.line));
      const rightLines = new Set(right.map((item) => item.line));
      best = {
        left: lines.filter((line) => leftLines.has(line)),
        right: lines.filter((line) => rightLines.has(line)),
        spanning: lines.filter((line) => !leftLines.has(line) && !rightLines.has(line)),
        score,
      };
    }
  }
  return best;
}

export function resolveReadingOrder(lines: OCRLine[]): OCRLine[] {
  const split = bestColumnSplit(lines);
  if (!split) return rowOrder(lines);
  const columnTop = Math.min(
    ...[...split.left, ...split.right].map((line) => ocrLineBounds(line).top),
  );
  const before = split.spanning.filter(
    (line) => ocrLineBounds(line).top < columnTop,
  );
  const after = split.spanning.filter((line) => !before.includes(line));
  return [
    ...rowOrder(before),
    ...resolveReadingOrder(split.left),
    ...resolveReadingOrder(split.right),
    ...rowOrder(after),
  ];
}

export function composeOCRText(lines: OCRLine[]) {
  const ordered = resolveReadingOrder(lines).filter((line) => line.text.trim());
  if (!ordered.length) return "";
  const medianHeight = median(ordered.map((line) => ocrLineBounds(line).height));
  let result = "";
  for (let index = 0; index < ordered.length; index++) {
    const current = ordered[index];
    if (index > 0) {
      const previous = ordered[index - 1];
      const gap = ocrLineBounds(current).top - ocrLineBounds(previous).bottom;
      result += medianHeight > 0 && gap > medianHeight * 1.15 ? "\n\n" : "\n";
    }
    result += current.text.trimEnd();
  }
  return result.trim();
}
