import type { OcrResultItem } from "@paddleocr/paddleocr-js";
import {
  PADDLE_DETECTION_ASSET,
  PADDLE_RECOGNITION_ASSET,
} from "./modelAssets.ts";
import { OCRModelManager } from "./OCRModelManager.ts";
import type {
  OCRLanguage,
  OCRLine,
  OCRProgress,
  OCRRecognizeOptions,
  OCRResult,
} from "./types.ts";

type PaddleInstance = Awaited<
  ReturnType<typeof import("@paddleocr/paddleocr-js")["PaddleOCR"]["create"]>
>;

interface HtrPending {
  resolve: (value: Map<number, OCRLine>) => void;
  reject: (reason: Error) => void;
  onProgress?: (progress: OCRProgress) => void;
}

interface HtrResponse {
  type: "progress" | "result" | "error";
  id: string;
  progress?: OCRProgress;
  lines?: Array<[number, OCRLine]>;
  message?: string;
}

function lineBounds(line: OCRLine) {
  const points = line.poly ?? [];
  if (!points.length)
    return { left: 0, top: 0, right: 0, bottom: 0, height: 0 };

  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  return {
    left: Math.min(...xs),
    top,
    right: Math.max(...xs),
    bottom,
    height: Math.max(1, bottom - top),
  };
}

function readingOrder(lines: OCRLine[]) {
  return [...lines].sort((a, b) => {
    const ab = lineBounds(a);
    const bb = lineBounds(b);
    const tolerance = Math.max(8, Math.min(ab.height, bb.height) * 0.6);
    if (Math.abs(ab.top - bb.top) <= tolerance)
      return ab.left - bb.left;
    return ab.top - bb.top;
  });
}

function median(values: number[]) {
  const filtered = values.filter((value) => Number.isFinite(value) && value > 0);
  if (!filtered.length) return 0;
  const sorted = filtered.sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function composeText(lines: OCRLine[]) {
  const ordered = readingOrder(lines).filter((line) => line.text.trim());
  if (!ordered.length) return "";

  const medianHeight = median(
    ordered.map((line) => lineBounds(line).height),
  );

  let result = "";
  for (let index = 0; index < ordered.length; index++) {
    const current = ordered[index];
    if (index > 0) {
      const previous = ordered[index - 1];
      const gap = lineBounds(current).top - lineBounds(previous).bottom;
      result += medianHeight > 0 && gap > medianHeight * 1.15
        ? "\n\n"
        : "\n";
    }
    result += current.text.trimEnd();
  }
  return result.trim();
}

function paddleLine(item: OcrResultItem): OCRLine {
  return {
    text: item.text,
    score: item.score,
    engine: "paddle",
    poly: item.poly.map(([x, y]) => ({ x, y })),
  };
}

function resultLanguages(language: OCRLanguage) {
  return language === "ru+en"
    ? (["ru", "en"] as const)
    : ([language] as const);
}

function suspiciousLine(line: OCRLine) {
  const text = line.text.trim();
  if (!text) return true;
  if ((line.score ?? 0) < 0.78) return true;
  if (/[�□]/.test(text)) return true;
  const strange = (text.match(/[^\p{L}\p{N}\p{P}\p{Z}\s]/gu) ?? []).length;
  return strange > Math.max(1, Math.floor(text.length * 0.15));
}

function averageConfidence(lines: OCRLine[]) {
  const values = lines
    .map((line) => line.score)
    .filter((score): score is number => typeof score === "number");
  if (!values.length) return undefined;
  return values.reduce((sum, score) => sum + score, 0) / values.length;
}

export class LocalOCRService {
  private paddlePromise: Promise<PaddleInstance> | null = null;
  private htrWorker: Worker | null = null;
  private htrPending = new Map<string, HtrPending>();
  private modelManager = new OCRModelManager();

  private async getPaddle(
    onProgress?: (progress: OCRProgress) => void,
  ) {
    if (!this.paddlePromise) {
      this.paddlePromise = (async () => {
        onProgress?.({
          phase: "loading-models",
          message: "Загружаем локальные модели PP-OCRv5…",
        });
        const { PaddleOCR } = await import("@paddleocr/paddleocr-js");
        return await PaddleOCR.create({
          worker: true,
          textDetectionModelName: "PP-OCRv5_mobile_det",
          textDetectionModelAsset: { url: PADDLE_DETECTION_ASSET },
          textRecognitionModelName: "eslav_PP-OCRv5_mobile_rec",
          textRecognitionModelAsset: { url: PADDLE_RECOGNITION_ASSET },
          textDetectionBatchSize: 1,
          textRecognitionBatchSize: 1,
          textDetMaxSideLimit: 2048,
          ortOptions: {
            backend: "auto",
            wasmPaths: "/ocr-runtime/paddle/",
            numThreads: 1,
            simd: true,
          },
        });
      })();
      this.paddlePromise.catch(() => {
        this.paddlePromise = null;
      });
    }
    return this.paddlePromise;
  }

  private getHtrWorker() {
    if (this.htrWorker) return this.htrWorker;
    const worker = new Worker(new URL("./htr.worker.ts", import.meta.url), {
      type: "module",
    });

    worker.addEventListener("message", (event: MessageEvent<HtrResponse>) => {
      const message = event.data;
      const pending = this.htrPending.get(message.id);
      if (!pending) return;

      if (message.type === "progress" && message.progress) {
        pending.onProgress?.(message.progress);
        return;
      }

      this.htrPending.delete(message.id);
      if (message.type === "result") {
        pending.resolve(new Map(message.lines ?? []));
      } else {
        pending.reject(
          new Error(message.message || "Не удалось выполнить локальный TrOCR."),
        );
      }
    });

    worker.addEventListener("error", () => {
      const error = new Error("Локальный TrOCR worker завершился с ошибкой.");
      for (const request of this.htrPending.values()) request.reject(error);
      this.htrPending.clear();
      this.htrWorker?.terminate();
      this.htrWorker = null;
    });

    this.htrWorker = worker;
    return worker;
  }

  private async htrAvailable(language: OCRLanguage) {
    if (language === "ru+en") {
      const [ru, en] = await Promise.all([
        this.modelManager.isHandwritingInstalled("ru"),
        this.modelManager.isHandwritingInstalled("en"),
      ]);
      return ru && en;
    }
    return this.modelManager.isHandwritingInstalled(language);
  }

  private async runHtr(
    file: File,
    lines: OCRLine[],
    indexes: number[],
    options: OCRRecognizeOptions,
    onProgress?: (progress: OCRProgress) => void,
  ) {
    if (!indexes.length) return new Map<number, OCRLine>();
    const worker = this.getHtrWorker();
    const id = crypto.randomUUID();
    const buffer = await file.arrayBuffer();

    return new Promise<Map<number, OCRLine>>((resolve, reject) => {
      this.htrPending.set(id, { resolve, reject, onProgress });
      worker.postMessage(
        {
          type: "recognize",
          id,
          image: {
            buffer,
            mime: file.type || "image/jpeg",
          },
          items: lines.map((line) => ({
            text: line.text,
            score: line.score ?? 0,
            poly: line.poly ?? [],
          })),
          indexes,
          languages: options.languages,
        },
        [buffer],
      );
    });
  }

  async recognize(
    file: File,
    options: OCRRecognizeOptions,
    onProgress?: (progress: OCRProgress) => void,
  ): Promise<OCRResult> {
    if (!file.type.startsWith("image/"))
      throw new Error("Для OCR выберите изображение.");

    const started = performance.now();
    onProgress?.({
      phase: "preparing",
      message: "Подготавливаем изображение…",
    });

    if (!(await this.modelManager.isPrintedInstalled())) {
      throw new Error(
        "Сначала скачайте базовую модель печатного OCR (PP-OCRv5) на это устройство.",
      );
    }

    const paddle = await this.getPaddle(onProgress);
    onProgress?.({
      phase: "detecting",
      message: "Ищем строки текста…",
    });

    const raw = await paddle.predict(file);
    const page = raw[0];
    if (!page) throw new Error("PP-OCRv5 не смог прочитать изображение.");

    let lines = readingOrder(page.items.map(paddleLine));
    let usedHtr = false;

    if (options.mode === "handwriting") {
      if (!(await this.htrAvailable(options.languages))) {
        throw new Error(
          "Для рукописного OCR сначала установите выбранную локальную TrOCR-модель.",
        );
      }

      const indexes = lines.flatMap((line, index) =>
        line.poly?.length ? [index] : [],
      );
      const replacements = await this.runHtr(
        file,
        lines,
        indexes,
        options,
        onProgress,
      );
      lines = lines.map((line, index) => replacements.get(index) ?? line);
      usedHtr = replacements.size > 0;
    } else if (
      options.mode === "auto" &&
      (await this.htrAvailable(options.languages))
    ) {
      const indexes = lines.flatMap((line, index) =>
        line.poly?.length && suspiciousLine(line) ? [index] : [],
      );
      if (indexes.length) {
        const replacements = await this.runHtr(
          file,
          lines,
          indexes,
          options,
          onProgress,
        );
        lines = lines.map((line, index) => replacements.get(index) ?? line);
        usedHtr = replacements.size > 0;
      }
    }

    lines = readingOrder(lines).filter((line) => line.text.trim().length > 0);
    const text = composeText(lines);
    const provider = page.runtime.recProvider || page.runtime.detProvider;

    onProgress?.({
      phase: "done",
      message: "Распознавание завершено.",
    });

    return {
      text,
      lines,
      modeUsed:
        options.mode === "handwriting"
          ? "handwriting"
          : usedHtr
            ? "mixed"
            : "printed",
      languages: [...resultLanguages(options.languages)],
      backend: usedHtr
        ? `PP-OCRv5 ${provider} + локальный TrOCR`
        : `PP-OCRv5 ${provider}`,
      confidence: usedHtr ? undefined : averageConfidence(lines),
      durationMs: Math.round(performance.now() - started),
    };
  }

  async dispose() {
    const paddlePromise = this.paddlePromise;
    this.paddlePromise = null;
    if (paddlePromise) {
      try {
        const paddle = await paddlePromise;
        await paddle.dispose();
      } catch {
        // Failed initialization leaves nothing reusable.
      }
    }

    if (this.htrWorker) {
      this.htrWorker.postMessage({ type: "dispose" });
      this.htrWorker.terminate();
      this.htrWorker = null;
    }

    const error = new Error("OCR остановлен.");
    for (const request of this.htrPending.values()) request.reject(error);
    this.htrPending.clear();
  }
}
