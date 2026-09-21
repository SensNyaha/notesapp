import type { OcrResultItem } from "@paddleocr/paddleocr-js";
import {
  PADDLE_DETECTION_ASSET,
  PADDLE_RECOGNITION_ASSET,
} from "./modelAssets.ts";
import { OCRModelManager } from "./OCRModelManager.ts";
import { composeOCRText, resolveReadingOrder } from "./layout.ts";
import { asOCRError, OCRError, throwIfOCRAborted } from "./errors.ts";
import type { OCRErrorCode } from "./errors.ts";
import { detectOCRDeviceProfile } from "./deviceProfile.ts";
import { prepareOCRImage } from "./imagePreprocessing.ts";
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
  cleanup?: () => void;
}

interface HtrResponse {
  type: "progress" | "result" | "error";
  id: string;
  progress?: OCRProgress;
  lines?: Array<[number, OCRLine]>;
  message?: string;
  code?: OCRErrorCode;
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
      pending.cleanup?.();
      if (message.type === "result") {
        pending.resolve(new Map(message.lines ?? []));
      } else {
        pending.reject(new OCRError(
          message.code ?? "worker-failed",
          message.message || "Не удалось выполнить локальный TrOCR.",
        ));
      }
    });

    worker.addEventListener("error", () => {
      const error = new OCRError(
        "worker-failed",
        "Локальный TrOCR worker завершился с ошибкой.",
      );
      for (const request of this.htrPending.values()) {
        request.cleanup?.();
        request.reject(error);
      }
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
    signal?: AbortSignal,
  ) {
    if (!indexes.length) return new Map<number, OCRLine>();
    throwIfOCRAborted(signal);
    const worker = this.getHtrWorker();
    const id = crypto.randomUUID();
    const buffer = await file.arrayBuffer();
    throwIfOCRAborted(signal);

    return new Promise<Map<number, OCRLine>>((resolve, reject) => {
      const abort = () => {
        const pending = this.htrPending.get(id);
        if (!pending) return;
        this.htrPending.delete(id);
        pending.cleanup?.();
        worker.postMessage({ type: "cancel", id });
        reject(new OCRError("cancelled", "Распознавание отменено.", {
          cause: signal?.reason,
        }));
      };
      const cleanup = signal
        ? () => signal.removeEventListener("abort", abort)
        : undefined;
      signal?.addEventListener("abort", abort, { once: true });
      this.htrPending.set(id, { resolve, reject, onProgress, cleanup });
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
    signal?: AbortSignal,
  ): Promise<OCRResult> {
    try {
      return await this.recognizeInternal(file, options, onProgress, signal);
    } catch (caught) {
      throw asOCRError(
        caught,
        "backend-failed",
        "Не удалось выполнить локальное распознавание.",
      );
    }
  }

  private async recognizeInternal(
    file: File,
    options: OCRRecognizeOptions,
    onProgress?: (progress: OCRProgress) => void,
    signal?: AbortSignal,
  ): Promise<OCRResult> {
    throwIfOCRAborted(signal);
    if (!file.type.startsWith("image/"))
      throw new OCRError("invalid-image", "Для OCR выберите изображение.");

    const started = performance.now();
    onProgress?.({
      phase: "preparing",
      message: "Подготавливаем изображение…",
    });

    if (!(await this.modelManager.isPrintedInstalled())) {
      throw new OCRError(
        "model-not-installed",
        "Сначала скачайте базовую модель печатного OCR (PP-OCRv5) на это устройство.",
      );
    }

    throwIfOCRAborted(signal);
    const paddle = await this.getPaddle(onProgress);
    throwIfOCRAborted(signal);
    onProgress?.({
      phase: "preparing",
      message: "Подготавливаем изображение…",
    });
    const prepared = await prepareOCRImage(file, {
      profile: detectOCRDeviceProfile(),
      grayscale: options.preprocessing?.grayscale,
      normalizeContrast: options.preprocessing?.normalizeContrast,
      selection: options.selection,
      signal,
    });
    onProgress?.({
      phase: "detecting",
      message: "Ищем строки текста…",
    });

    const raw = await paddle.predict(prepared.file);
    throwIfOCRAborted(signal);
    const page = raw[0];
    if (!page) {
      throw new OCRError("no-result", "PP-OCRv5 не смог прочитать изображение.");
    }

    let lines = resolveReadingOrder(page.items.map(paddleLine));
    let usedHtr = false;

    if (options.mode === "handwriting") {
      if (!(await this.htrAvailable(options.languages))) {
        throw new OCRError(
          "model-not-installed",
          "Для рукописного OCR сначала установите выбранную локальную TrOCR-модель.",
        );
      }

      const indexes = lines.flatMap((line, index) =>
        line.poly?.length ? [index] : [],
      );
      const replacements = await this.runHtr(
        prepared.file,
        lines,
        indexes,
        options,
        onProgress,
        signal,
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
          prepared.file,
          lines,
          indexes,
          options,
          onProgress,
          signal,
        );
        lines = lines.map((line, index) => replacements.get(index) ?? line);
        usedHtr = replacements.size > 0;
      }
    }

    lines = resolveReadingOrder(lines).filter((line) => line.text.trim().length > 0);
    throwIfOCRAborted(signal);
    const text = composeOCRText(lines);
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
    let htrDispose: Promise<void> | undefined;
    if (this.htrWorker) {
      const worker = this.htrWorker;
      this.htrWorker = null;
      const error = new OCRError("cancelled", "OCR остановлен.");
      for (const [id, request] of this.htrPending) {
        request.cleanup?.();
        request.reject(error);
        worker.postMessage({ type: "cancel", id });
      }
      this.htrPending.clear();
      const channel = new MessageChannel();
      const acknowledged = new Promise<void>((resolve) => {
        const timer = globalThis.setTimeout(resolve, 2_000);
        channel.port1.addEventListener("message", () => {
          globalThis.clearTimeout(timer);
          resolve();
        }, { once: true });
        channel.port1.start();
      });
      worker.postMessage({ type: "dispose", port: channel.port2 }, [channel.port2]);
      htrDispose = acknowledged.finally(() => {
        channel.port1.close();
        worker.terminate();
      });
    }

    if (paddlePromise) {
      try {
        const paddle = await paddlePromise;
        await paddle.dispose();
      } catch {
        // Failed initialization leaves nothing reusable.
      }
    }
    await htrDispose;
  }
}
