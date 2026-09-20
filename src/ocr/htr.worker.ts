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
}

type RequestMessage = HtrRequest | DisposeRequest;
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
  const blob = new Blob([message.image.buffer], {
    type: message.image.mime,
  });
  const source = await RawImage.fromBlob(blob);
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
    if (!groups[language].length) continue;
    const recognizer = await getRuntime(language, message.id);
    for (const index of groups[language]) {
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
      const text = await recognizer.recognize(crop);
      if (!text) continue;
      recognized.set(index, {
        text,
        engine: "trocr",
        language,
        poly: item.poly.map(({ x, y }) => ({ x, y })),
      });
    }
  }

  ctx.postMessage({
    type: "result",
    id: message.id,
    lines: [...recognized.entries()],
  });
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
  if (message.type === "dispose") {
    void dispose().finally(() => ctx.close());
    return;
  }

  void recognize(message).catch((caught) => {
    ctx.postMessage({
      type: "error",
      id: message.id,
      message:
        caught instanceof Error
          ? caught.message
          : "Не удалось распознать рукописный текст.",
    });
  });
});
