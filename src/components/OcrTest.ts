import { h as e } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { LocalOCRService } from "../ocr/LocalOCRService.ts";
import { detectOCRCapabilities } from "../ocr/capabilities.ts";
import {
  OCRModelManager,
  formatModelBytes,
  type OCRModelPackageId,
  type OCRModelProgress,
  type OCRModelState,
} from "../ocr/OCRModelManager.ts";
import type {
  OCRLanguage,
  OCRMode,
  OCRProgress,
  OCRResult,
} from "../ocr/types.ts";
import { RichTextEditor } from "./RichTextEditor.ts";
import { UiIcon } from "./ui.ts";

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function normalizeOcrText(value: string) {
  return value.replace(/\r\n?/g, "\n").trim();
}

function ocrFragment(text: string) {
  return normalizeOcrText(text)
    .split("\n")
    .map((line) =>
      line.trim().length
        ? `<p>${escapeHtml(line.trimEnd())}</p>`
        : "<p><br></p>",
    )
    .join("");
}

const OCR_MODEL_PACKAGES: Array<{
  id: OCRModelPackageId;
  label: string;
  detail: string;
}> = [
  {
    id: "printed-ru-en-v1",
    label: "Печатный OCR RU + EN",
    detail: "PP-OCRv5 · базовая модель, обязательна для любого режима OCR",
  },
  {
    id: "handwriting-ru-v1",
    label: "Рукописный русский",
    detail: "TrOCR RU · рукописный русский; для детекции строк также требуется базовая PP-OCRv5",
  },
  {
    id: "handwriting-en-v1",
    label: "Рукописный English",
    detail: "TrOCR EN · рукописный English; для детекции строк также требуется базовая PP-OCRv5",
  },
];

type OCRModelInstallChoice = OCRModelPackageId | "all";

export function OcrTestScreen({ onBack }: { onBack: () => void }) {
  const service = useRef<LocalOCRService | null>(null);
  const modelManager = useRef(new OCRModelManager()).current;
  const cameraInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [html, setHtml] = useState("");
  const [text, setText] = useState("");
  const [editorKey, setEditorKey] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<OCRMode>("auto");
  const [language, setLanguage] = useState<OCRLanguage>("ru+en");
  const [progress, setProgress] = useState<OCRProgress | null>(null);
  const [lastResult, setLastResult] = useState<OCRResult | null>(null);
  const [ocrDraft, setOcrDraft] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [modelStates, setModelStates] = useState<OCRModelState[]>([]);
  const [modelChoice, setModelChoice] =
    useState<OCRModelInstallChoice>("printed-ru-en-v1");
  const [modelBusy, setModelBusy] = useState<OCRModelPackageId | null>(null);
  const [modelProgress, setModelProgress] = useState<OCRModelProgress | null>(null);
  const capabilities = useRef(detectOCRCapabilities()).current;

  const refreshModelStates = async () => {
    try {
      setModelStates(await modelManager.states());
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Не удалось проверить локальные OCR-модели.",
      );
    }
  };

  useEffect(() => {
    void refreshModelStates();
    return () => {
      void service.current?.dispose();
    };
  }, []);
  const selectFile = (event: Event) => {
    const input = event.target as HTMLInputElement;
    const selected = input.files?.[0] ?? null;
    input.value = "";
    if (!selected) return;
    if (!selected.type.startsWith("image/")) {
      setError("Выберите изображение.");
      return;
    }
    setFile(selected);
    setError("");
    setProgress(null);
    setLastResult(null);
    setOcrDraft("");
  };

  const insertOcrDraft = () => {
    const normalized = normalizeOcrText(ocrDraft);
    const fragment = ocrFragment(normalized);
    if (!fragment) return;
    setHtml((current) => current + fragment);
    setText((current) =>
      [current.trimEnd(), normalized].filter(Boolean).join("\n"),
    );
    setEditorKey((value) => value + 1);
    setLastResult(null);
    setOcrDraft("");
  };

  const replaceWithOcrDraft = () => {
    const normalized = normalizeOcrText(ocrDraft);
    if (!normalized) return;
    setHtml(ocrFragment(normalized));
    setText(normalized);
    setEditorKey((value) => value + 1);
    setLastResult(null);
    setOcrDraft("");
  };

  const cancelOcrDraft = () => {
    setLastResult(null);
    setOcrDraft("");
  };

  const modelState = (id: OCRModelPackageId) =>
    modelStates.find((state) => state.id === id);

  const printedState = modelState("printed-ru-en-v1");
  const ruHandwritingState = modelState("handwriting-ru-v1");
  const enHandwritingState = modelState("handwriting-en-v1");
  const modelsChecked = modelStates.length === OCR_MODEL_PACKAGES.length;
  const printedInstalled = Boolean(printedState?.installed);
  const ruHandwritingInstalled = Boolean(ruHandwritingState?.installed);
  const enHandwritingInstalled = Boolean(enHandwritingState?.installed);
  const anyModelInstalled =
    printedInstalled || ruHandwritingInstalled || enHandwritingInstalled;
  const allModelsInstalled =
    printedInstalled && ruHandwritingInstalled && enHandwritingInstalled;
  const handwritingAvailable =
    printedInstalled && (ruHandwritingInstalled || enHandwritingInstalled);

  const selectedModeAvailable =
    printedInstalled &&
    (mode !== "handwriting" ||
      (language === "ru"
        ? ruHandwritingInstalled
        : language === "en"
          ? enHandwritingInstalled
          : ruHandwritingInstalled && enHandwritingInstalled));

  useEffect(() => {
    if (!modelsChecked || !printedInstalled) return;
    if (mode !== "handwriting") return;

    if (!ruHandwritingInstalled && !enHandwritingInstalled) {
      setMode("printed");
      return;
    }
    if (language === "ru+en" &&
        !(ruHandwritingInstalled && enHandwritingInstalled)) {
      setLanguage(ruHandwritingInstalled ? "ru" : "en");
      return;
    }
    if (language === "ru" && !ruHandwritingInstalled)
      setLanguage("en");
    else if (language === "en" && !enHandwritingInstalled)
      setLanguage("ru");
  }, [
    modelsChecked,
    printedInstalled,
    ruHandwritingInstalled,
    enHandwritingInstalled,
    mode,
    language,
  ]);

  useEffect(() => {
    if (!modelsChecked || modelChoice === "all") return;
    if (!modelState(modelChoice)?.installed) return;
    const nextMissing = OCR_MODEL_PACKAGES.find(
      ({ id }) => !modelState(id)?.installed,
    );
    setModelChoice(nextMissing?.id ?? "all");
  }, [modelStates, modelChoice, modelsChecked]);

  const installModels = async (ids: OCRModelPackageId[]) => {
    if (modelBusy) return;
    setError("");
    setProgress(null);
    try {
      for (const id of ids) {
        const state = modelState(id);
        if (state?.installed) continue;
        setModelBusy(id);
        setModelProgress(
          state
            ? {
                packageId: id,
                loaded: state.cachedBytes,
                total: state.bytes,
              }
            : null,
        );
        await modelManager.install(id, setModelProgress);
        await refreshModelStates();
      }
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Не удалось установить OCR-модель.",
      );
    } finally {
      setModelBusy(null);
      setModelProgress(null);
    }
  };

  const installSelectedModels = () => {
    const ids: OCRModelPackageId[] =
      modelChoice === "all"
        ? OCR_MODEL_PACKAGES.map(({ id }) => id)
        : modelChoice === "printed-ru-en-v1"
          ? ["printed-ru-en-v1"]
          : ["printed-ru-en-v1", modelChoice];
    void installModels(ids);
  };

  const removeModel = async (id: OCRModelPackageId) => {
    if (modelBusy) return;
    setModelBusy(id);
    setError("");
    try {
      await service.current?.dispose();
      service.current = null;
      await modelManager.remove(id);
      await refreshModelStates();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Не удалось удалить OCR-модель.",
      );
    } finally {
      setModelBusy(null);
      setModelProgress(null);
    }
  };

  const recognize = async () => {
    if (busy) return;
    if (!modelsChecked) {
      setError("Подождите, пока проверяется состояние OCR-моделей.");
      return;
    }
    if (!printedInstalled) {
      setError(
        "OCR недоступен: сначала скачайте базовую модель печатного OCR (PP-OCRv5).",
      );
      return;
    }
    if (!selectedModeAvailable) {
      setError(
        "Выбранный режим OCR недоступен: скачайте необходимую TrOCR-модель для выбранного языка.",
      );
      return;
    }
    if (!file) {
      setError("Сначала сфотографируйте или выберите изображение.");
      return;
    }
    setBusy(true);
    setError("");
    setLastResult(null);
    setOcrDraft("");
    setProgress({ phase: "preparing", message: "Подготавливаем OCR…" });
    try {
      const ocr = service.current ?? new LocalOCRService();
      service.current = ocr;
      const result = await ocr.recognize(
        file,
        { mode, languages: language },
        setProgress,
      );
      if (!result.text.trim()) {
        setError("Текст на изображении не распознан.");
        return;
      }
      setLastResult(result);
      setOcrDraft(normalizeOcrText(result.text));
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Не удалось выполнить локальный OCR.",
      );
    } finally {
      setBusy(false);
    }
  };

  const accessStatus = !modelsChecked
    ? "Проверяем модели OCR на этом устройстве…"
    : !anyModelInstalled
      ? "OCR недоступен: на этом устройстве ещё не загружено ни одной модели."
      : !printedInstalled
        ? "OCR недоступен: базовая PP-OCRv5 не установлена. TrOCR-модели без неё не могут находить строки текста."
        : allModelsInstalled
          ? "Полный доступ: печатный, автоматический и рукописный OCR RU + EN доступны."
          : handwritingAvailable
            ? `Частичный доступ: печатный OCR доступен; рукописный — ${[
                ruHandwritingInstalled ? "RU" : "",
                enHandwritingInstalled ? "EN" : "",
              ].filter(Boolean).join(" + ")}.`
            : "Частичный доступ: доступны печатный OCR и Auto без TrOCR. Для рукописного текста скачайте HTR-модель.";

  const canChooseImage =
    modelsChecked && printedInstalled && !busy && !modelBusy;
  const canRunOCR =
    Boolean(file) &&
    modelsChecked &&
    selectedModeAvailable &&
    !busy &&
    !modelBusy;
  const selectedChoiceInstalled =
    modelChoice === "all"
      ? allModelsInstalled
      : modelChoice === "printed-ru-en-v1"
        ? printedInstalled
        : printedInstalled && Boolean(modelState(modelChoice)?.installed);

  return e(
    "section",
    { class: "note-editor" },
    e(
      "div",
      { class: "note-editor-header" },
      e(
        "button",
        {
          class: "ui-back",
          disabled: busy,
          onClick: onBack,
          "aria-label": "Назад",
          title: "Назад",
        },
        e(UiIcon, { name: "back", size: 18 }),
      ),
      e(
        "span",
        { class: "note-editor-state" },
        busy ? "OCR выполняется" : "Тестовая заметка · не сохраняется",
      ),
      e(
        "button",
        { class: "primary", disabled: busy, onClick: onBack },
        "Готово",
      ),
    ),
    e("h1", { class: "note-editor-title" }, "Создание новой заметки"),
    e(
      "label",
      { class: "note-title-field" },
      e("span", { class: "sr-only" }, "Заголовок"),
      e("input", {
        value: title,
        maxLength: 500,
        placeholder: "Название заметки",
        onInput: (event: Event) =>
          setTitle((event.target as HTMLInputElement).value),
      }),
    ),
    e(
      "section",
      { class: "reminder-card" },
      e(
        "div",
        { class: "section-heading" },
        e("h2", null, "Локальный OCR"),
      ),
      e(
        "p",
        { class: "hint" },
        "OCR выполняется только локально на этом устройстве. На сервер отправляются только запросы на скачивание статических моделей; изображения и распознанный текст с устройства не уходят.",
      ),
      e(
        "p",
        {
          class: printedInstalled ? "hint" : "error",
          role: "status",
          "aria-live": "polite",
        },
        accessStatus,
      ),
      e(
        "div",
        { class: "editor-label" },
        e("span", null, "Модели OCR на этом устройстве"),
        e(
          "p",
          { class: "hint" },
          "Выберите пакет и скачайте его с сервера в локальный Cache Storage. После загрузки соответствующие режимы станут доступны офлайн.",
        ),
        e(
          "label",
          { class: "editor-label" },
          "Что загрузить",
          e(
            "select",
            {
              value: modelChoice,
              disabled: busy || Boolean(modelBusy) || !modelsChecked,
              onChange: (event: Event) =>
                setModelChoice(
                  (event.target as HTMLSelectElement)
                    .value as OCRModelInstallChoice,
                ),
            },
            ...OCR_MODEL_PACKAGES.map(({ id, label }) => {
              const state = modelState(id);
              return e(
                "option",
                {
                  key: id,
                  value: id,
                  disabled: Boolean(state?.installed),
                },
                state
                  ? `${label} · ${formatModelBytes(state.bytes)}${state.installed ? " · установлена" : ""}`
                  : `${label} · проверяем…`,
              );
            }),
            e(
              "option",
              { value: "all", disabled: allModelsInstalled },
              allModelsInstalled
                ? "Все модели установлены"
                : "Все недостающие модели",
            ),
          ),
        ),
        e(
          "div",
          { class: "onboarding-actions" },
          e(
            "button",
            {
              type: "button",
              class: "primary",
              disabled:
                busy ||
                Boolean(modelBusy) ||
                !modelsChecked ||
                allModelsInstalled ||
                selectedChoiceInstalled,
              onClick: installSelectedModels,
            },
            modelBusy
              ? "Загружаем модель…"
              : allModelsInstalled
                ? "Все модели установлены"
                : "Скачать на устройство",
          ),
        ),
        ...OCR_MODEL_PACKAGES.map(({ id, label, detail }) => {
          const state = modelState(id);
          const activeProgress =
            modelProgress?.packageId === id ? modelProgress : null;
          const loaded = activeProgress?.loaded ?? state?.cachedBytes ?? 0;
          const total = activeProgress?.total ?? state?.bytes ?? 0;
          const percent = total > 0
            ? Math.min(100, Math.round((loaded / total) * 100))
            : 0;
          return e(
            "div",
            { class: "ocr-model-row", key: id },
            e("strong", null, label),
            e("p", { class: "hint" }, detail),
            state &&
              e("progress", {
                class: "ocr-model-progress",
                max: state.bytes,
                value: state.installed ? state.bytes : loaded,
                "aria-label": `Состояние загрузки: ${label}`,
              }),
            e(
              "p",
              {
                class: "hint",
                role: activeProgress ? "status" : undefined,
                "aria-live": activeProgress ? "polite" : undefined,
              },
              !state
                ? "Проверяем состояние…"
                : state.installed
                  ? `Установлена · ${formatModelBytes(state.bytes)}`
                  : activeProgress
                    ? `Загрузка ${percent}% · ${formatModelBytes(loaded)} / ${formatModelBytes(total)}`
                    : state.cachedBytes > 0
                      ? `Частично загружено · ${formatModelBytes(state.cachedBytes)} / ${formatModelBytes(state.bytes)}`
                      : `Не установлена · ${formatModelBytes(state.bytes)}`,
            ),
            state?.installed &&
              e(
                "button",
                {
                  type: "button",
                  class: "secondary-button",
                  disabled: busy || Boolean(modelBusy),
                  onClick: () => void removeModel(id),
                },
                modelBusy === id ? "Подождите…" : "Удалить с устройства",
              ),
          );
        }),
      ),
      e(
        "label",
        { class: "editor-label" },
        "Режим",
        e(
          "select",
          {
            value: mode,
            disabled: busy || Boolean(modelBusy) || !printedInstalled,
            onChange: (event: Event) =>
              setMode((event.target as HTMLSelectElement).value as OCRMode),
          },
          e(
            "option",
            { value: "auto", disabled: !printedInstalled },
            "Авто",
          ),
          e(
            "option",
            { value: "printed", disabled: !printedInstalled },
            "Печатный",
          ),
          e(
            "option",
            { value: "handwriting", disabled: !handwritingAvailable },
            handwritingAvailable
              ? "Рукописный"
              : "Рукописный · требуется TrOCR",
          ),
        ),
      ),
      e(
        "label",
        { class: "editor-label" },
        "Язык",
        e(
          "select",
          {
            value: language,
            disabled:
              busy ||
              Boolean(modelBusy) ||
              !printedInstalled ||
              (mode === "handwriting" && !handwritingAvailable),
            onChange: (event: Event) =>
              setLanguage(
                (event.target as HTMLSelectElement).value as OCRLanguage,
              ),
          },
          e(
            "option",
            {
              value: "ru+en",
              disabled:
                mode === "handwriting" &&
                !(ruHandwritingInstalled && enHandwritingInstalled),
            },
            "Русский + English",
          ),
          e(
            "option",
            {
              value: "ru",
              disabled: mode === "handwriting" && !ruHandwritingInstalled,
            },
            "Русский",
          ),
          e(
            "option",
            {
              value: "en",
              disabled: mode === "handwriting" && !enHandwritingInstalled,
            },
            "English",
          ),
        ),
      ),
      e("input", {
        ref: cameraInput,
        type: "file",
        accept: "image/*",
        capture: "environment",
        hidden: true,
        onChange: selectFile,
      }),
      e("input", {
        ref: fileInput,
        type: "file",
        accept: "image/*",
        hidden: true,
        onChange: selectFile,
      }),
      e(
        "div",
        { class: "onboarding-actions" },
        e(
          "button",
          {
            type: "button",
            class: "secondary-button",
            disabled: !canChooseImage,
            onClick: () => cameraInput.current?.click(),
          },
          e(UiIcon, { name: "image", size: 17 }),
          "Сфотографировать",
        ),
        e(
          "button",
          {
            type: "button",
            class: "secondary-button",
            disabled: !canChooseImage,
            onClick: () => fileInput.current?.click(),
          },
          e(UiIcon, { name: "upload", size: 17 }),
          "Выбрать изображение",
        ),
        e(
          "button",
          {
            type: "button",
            class: "primary",
            disabled: !canRunOCR,
            onClick: () => void recognize(),
          },
          busy ? "Распознаём…" : "Распознать",
        ),
      ),
      file &&
        e(
          "p",
          { class: "hint" },
          "Выбрано: ",
          e("strong", null, file.name),
        ),
      progress &&
        e(
          "p",
          { class: "hint", role: "status", "aria-live": "polite" },
          progress.message,
        ),
      error && e("p", { class: "error", role: "alert" }, error),
      lastResult &&
        e(
          "p",
          { class: "hint" },
          `${lastResult.modeUsed} · ${lastResult.backend} · ${lastResult.durationMs} мс · строк: ${lastResult.lines.length}`,
        ),
      lastResult &&
        e(
          "div",
          { class: "editor-label" },
          e("span", null, "Распознанный текст"),
          e("textarea", {
            value: ocrDraft,
            disabled: busy,
            rows: 8,
            onInput: (event: Event) =>
              setOcrDraft((event.target as HTMLTextAreaElement).value),
          }),
          e(
            "div",
            { class: "onboarding-actions" },
            e(
              "button",
              {
                type: "button",
                class: "secondary-button",
                disabled: busy,
                onClick: cancelOcrDraft,
              },
              "Отмена",
            ),
            e(
              "button",
              {
                type: "button",
                class: "secondary-button",
                disabled: busy || !ocrDraft.trim(),
                onClick: insertOcrDraft,
              },
              "Вставить",
            ),
            e(
              "button",
              {
                type: "button",
                class: "primary",
                disabled: busy || !ocrDraft.trim(),
                onClick: replaceWithOcrDraft,
              },
              "Заменить",
            ),
          ),
        ),
      !capabilities.worker &&
        e("p", { class: "error" }, "Web Worker недоступен в этом браузере."),
    ),
    e("label", { class: "editor-label sr-only" }, "Текст заметки"),
    e(RichTextEditor, {
      key: editorKey,
      html,
      text,
      onChange: (nextHtml: string, nextText: string) => {
        setHtml(nextHtml);
        setText(nextText);
      },
      onError: setError,
    }),
  );
}
