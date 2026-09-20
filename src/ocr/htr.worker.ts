import { RawImage } from "@huggingface/transformers";
import { LocalTrocr } from "./localTrocr.ts";
import type { OCRLanguage, OCRLine } from "./types.ts";

interface OCRInputLine {
  text: string;
  score: number;
  poly: Array<{ x: number; y: number }>;
}

interface HtrRequest {
  type: "recognize";
  id: string;
  image: { buffer: ArrayBuffer; mime: string };
  items: OCRInputLine[];
  indexes: number[];
  languages: OCRLanguage;
}

interface DisposeRequest {
  type: "dispose";
  port: MessagePort;
}

interface CancelRequest {
  type: "cancel";
  id: string;
}

type RequestMessage = HtrRequest | DisposeRequest | CancelRequest;
type HtrLanguage = "ru" | "en";
interface WorkerContext {
  postMessage(message: unknown): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<RequestMessage>) => void,
  ): void;
  close(): void;
}

const ctx = self as unknown as WorkerContext;
let activeLanguage: HtrLanguage | null = null;
let activeRuntime: Promise<LocalTrocr> | null = null;
const cancelledRequests = new Set<string>();
let workQueue = Promise.resolve();

function throwIfCancelled(id: string) {
  if (cancelledRequests.has(id)) {
    throw new DOMException("Распознавание отменено.", "AbortError");
  }
}

function postProgress(
  id: string,
  message: string,
  current?: number,
  total?: number,
) {
  ctx.postMessage({
    type: "progress",
    id,
    progress: {
      phase: "handwriting",
      message,
      current,
      total,
    },
  });
}
function languageFor(
  item: OCRInputLine,
  requested: OCRLanguage,
): HtrLanguage {
  if (requested === "ru" || requested === "en") return requested;
  const cyr = (item.text.match(/[А-Яа-яЁё]/g) ?? []).length;
  const lat = (item.text.match(/[A-Za-z]/g) ?? []).length;
  return cyr >= lat ? "ru" : "en";
}

async function getRuntime(
  language: HtrLanguage,
  requestId: string,
) {
  if (activeRuntime && activeLanguage === language) return activeRuntime;
  if (activeRuntime) {
    try {
      const previous = await activeRuntime;
      await previous.dispose();
    } catch {
      // Failed initialization has no reusable runtime to dispose.
    }
  }

  activeLanguage = language;
  postProgress(
    requestId,
    `Загружаем локальную HTR-модель ${language.toUpperCase()}…`,
  );
  activeRuntime = LocalTrocr.create(language);
  activeRuntime.catch(() => {
    activeRuntime = null;
    activeLanguage = null;
  });
  return activeRuntime;
}

function bounds(
  poly: Array<{ x: number; y: number }>,
  width: number,
  height: number,
) {
  if (!poly.length) return [0, 0, width, height] as const;
  const xs = poly.map((point) => point.x);
  const ys = poly.map((point) => point.y);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const x1 = Math.min(width, Math.ceil(Math.max(...xs)));
  const y1 = Math.min(height, Math.ceil(Math.max(...ys)));
  const padX = Math.max(4, Math.round((x1 - x0) * 0.08));
  const padY = Math.max(4, Math.round((y1 - y0) * 0.2));
  return [
    Math.max(0, x0 - padX),
    Math.max(0, y0 - padY),
    Math.min(width, x1 + padX),
    Math.min(height, y1 + padY),
  ] as const;
}
async function recognize(message: HtrRequest) {
  throwIfCancelled(message.id);
  const blob = new Blob([message.image.buffer], {
    type: message.image.mime,
  });
  const source = await RawImage.fromBlob(blob);
  try {
    throwIfCancelled(message.id);
    const recognized = new Map<number, OCRLine>();
    const groups: Record<HtrLanguage, number[]> = { ru: [], en: [] };

    for (const index of message.indexes) {
      const item = message.items[index];
      if (!item) continue;
      groups[languageFor(item, message.languages)].push(index);
    }

    let current = 0;
    const total = groups.ru.length + groups.en.length;
    for (const language of ["ru", "en"] as const) {
      throwIfCancelled(message.id);
      if (!groups[language].length) continue;
      const recognizer = await getRuntime(language, message.id);
      throwIfCancelled(message.id);
      for (const index of groups[language]) {
        throwIfCancelled(message.id);
        const item = message.items[index];
        if (!item) continue;
        current += 1;
        postProgress(
          message.id,
          `Распознаём рукописную строку ${current} из ${total}…`,
          current,
          total,
        );
        const [x0, y0, x1, y1] = bounds(
          item.poly,
          source.width,
          source.height,
        );
        const crop = await source.clone().crop([x0, y0, x1, y1]);
        try {
          const text = await recognizer.recognize(crop);
          throwIfCancelled(message.id);
          if (!text) continue;
          recognized.set(index, {
            text,
            engine: "trocr",
            language,
            poly: item.poly.map(({ x, y }) => ({ x, y })),
          });
        } finally {
          crop.data = new Uint8Array(0);
        }
      }
    }

    ctx.postMessage({
      type: "result",
      id: message.id,
      lines: [...recognized.entries()],
    });
  } finally {
    source.data = new Uint8Array(0);
  }
}

async function dispose() {
  if (activeRuntime) {
    try {
      const runtime = await activeRuntime;
      await runtime.dispose();
    } catch {
      // Nothing else to release.
    }
  }
  activeRuntime = null;
  activeLanguage = null;
}

ctx.addEventListener("message", (event: MessageEvent<RequestMessage>) => {
  const message = event.data;
  if (message.type === "cancel") {
    cancelledRequests.add(message.id);
    return;
  }

  if (message.type === "dispose") {
    workQueue = workQueue.finally(async () => {
      await dispose();
      message.port.postMessage({ type: "disposed" });
      message.port.close();
      ctx.close();
    });
    return;
  }

  workQueue = workQueue.finally(async () => {
    try {
      await recognize(message);
    } catch (caught) {
      ctx.postMessage({
        type: "error",
        id: message.id,
        code:
          caught instanceof DOMException && caught.name === "AbortError"
            ? "cancelled"
            : "worker-failed",
        message:
          caught instanceof Error
            ? caught.message
            : "Не удалось распознать рукописный текст.",
      });
    } finally {
      cancelledRequests.delete(message.id);
    }
  });
});
