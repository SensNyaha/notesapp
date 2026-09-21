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
  OCRSelectionMask,
} from "../ocr/types.ts";
import { RichTextEditor } from "./RichTextEditor.ts";
import { OCRRegionSelector } from "./OCRRegionSelector.ts";
import { UiIcon } from "./ui.ts";
import { appConfirm } from "./AppDialog.ts";

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

export function OcrTestScreen({
  onBack,
  onNavigationGuardChange,
}: {
  onBack: () => void;
  onNavigationGuardChange?: (
    guard: (() => Promise<boolean>) | null,
  ) => void;
}) {
  const service = useRef<LocalOCRService | null>(null);
  const ocrAbort = useRef<AbortController | null>(null);
  const modelAbort = useRef<AbortController | null>(null);
  const modelManager = useRef(new OCRModelManager()).current;
  const fileInput = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [html, setHtml] = useState("");
  const [text, setText] = useState("");
  const [editorKey, setEditorKey] = useState(0);
  const [ocrExpanded, setOcrExpanded] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [selection, setSelection] = useState<OCRSelectionMask>({ strokes: [] });
  const [mode, setMode] = useState<OCRMode>("auto");
  const [language, setLanguage] = useState<OCRLanguage>("ru+en");
  const [progress, setProgress] = useState<OCRProgress | null>(null);
  const [lastResult, setLastResult] = useState<OCRResult | null>(null);
  const [ocrDraft, setOcrDraft] = useState("");
  const [ocrDraftHtml, setOcrDraftHtml] = useState("");
  const [ocrDraftEditorKey, setOcrDraftEditorKey] = useState(0);
  const [resultOpen, setResultOpen] = useState(false);
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
      ocrAbort.current?.abort();
      modelAbort.current?.abort();
      void service.current?.dispose();
    };
  }, []);

  useEffect(() => {
    const pending = busy || Boolean(lastResult);
    const guard = async () => {
      if (!pending) return true;
      const discard = await appConfirm(
        busy
          ? "Распознавание ещё не завершено. При выходе текущий прогресс OCR будет сброшен."
          : "Распознанный текст ещё не принят и не добавлен в заметку. При выходе он будет сброшен.",
        {
          title: "Сбросить прогресс OCR?",
          confirmLabel: "Сбросить прогресс",
          cancelLabel: "Отмена",
          danger: true,
        },
      );
      if (discard) {
        ocrAbort.current?.abort();
        void service.current?.dispose();
        service.current = null;
      }
      return discard;
    };
    onNavigationGuardChange?.(guard);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!pending) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      onNavigationGuardChange?.(null);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [busy, lastResult, onNavigationGuardChange]);

  useEffect(() => {
    if (!resultOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [resultOpen]);
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
    setSelection({ strokes: [] });
    setError("");
    setProgress(null);
    setLastResult(null);
    setOcrDraft("");
    setOcrDraftHtml("");
    setResultOpen(false);
  };

  const openImagePicker = (capture: boolean) => {
    const input = fileInput.current;
    if (!input) return;
    if (capture) input.setAttribute("capture", "environment");
    else input.removeAttribute("capture");
    input.click();
  };

  const insertOcrDraft = () => {
    const normalized = normalizeOcrText(ocrDraft);
    const fragment = ocrDraftHtml.trim() || ocrFragment(normalized);
    if (!fragment) return;
    setHtml((current) => current + fragment);
    setText((current) =>
      [current.trimEnd(), normalized].filter(Boolean).join("\n"),
    );
    setEditorKey((value) => value + 1);
    setLastResult(null);
    setOcrDraft("");
    setOcrDraftHtml("");
    setResultOpen(false);
    setFile(null);
    setSelection({ strokes: [] });
  };

  const cancelOcrDraft = () => {
    setLastResult(null);
    setOcrDraft("");
    setOcrDraftHtml("");
    setResultOpen(false);
    setFile(null);
    setSelection({ strokes: [] });
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
    const controller = new AbortController();
    modelAbort.current = controller;
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
        await modelManager.install(id, setModelProgress, controller.signal);
        await refreshModelStates();
      }
    } catch (caught) {
      if (!controller.signal.aborted) {
        setError(
          caught instanceof Error
            ? caught.message
            : "Не удалось установить OCR-модель.",
        );
      }
    } finally {
      if (modelAbort.current === controller) modelAbort.current = null;
      setModelBusy(null);
      setModelProgress(null);
      await refreshModelStates();
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

  const cancelModelInstall = () => modelAbort.current?.abort();

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
    setOcrExpanded(false);
    setError("");
    setLastResult(null);
    setOcrDraft("");
    setProgress({ phase: "preparing", message: "Подготавливаем OCR…" });
    try {
      const controller = new AbortController();
      ocrAbort.current = controller;
      const ocr = service.current ?? new LocalOCRService();
      service.current = ocr;
      const result = await ocr.recognize(
        file,
        {
          mode,
          languages: language,
          selection: selection.strokes.length ? selection : undefined,
        },
        setProgress,
        controller.signal,
      );
      if (!result.text.trim()) {
        setError("Текст на изображении не распознан.");
        return;
      }
      setLastResult(result);
      const recognized = normalizeOcrText(result.text);
      setOcrDraft(recognized);
      setOcrDraftHtml(ocrFragment(recognized));
      setOcrDraftEditorKey((value) => value + 1);
    } catch (caught) {
      setOcrExpanded(true);
      setError(
        caught instanceof Error
          ? caught.message
          : "Не удалось выполнить локальный OCR.",
      );
    } finally {
      ocrAbort.current = null;
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

  const canChooseImage = !busy && !modelBusy;
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
    { class: "note-editor ocr-test-screen" },
    e(
      "div",
      { class: "note-editor-header" },
      e(
        "button",
        {
          class: "ui-back",
          onClick: onBack,
          "aria-label": "Назад",
          title: "Назад",
        },
        e(UiIcon, { name: "back", size: 18 }),
      ),
      e(
        "span",
        { class: "note-editor-state" },
        busy ? "OCR выполняется" : "OCR · тестовый экран",
      ),
      e(
        "button",
        { class: "primary", onClick: onBack },
        "Готово",
      ),
    ),
    e("h1", { class: "note-editor-title" }, "Тестовая заметка"),
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
      { class: `reminder-card ocr-workbench${ocrExpanded ? " is-open" : ""}` },
      e(
        "div",
        { class: "ocr-launch-row" },
        e(
          "button",
          {
            type: "button",
            class: ocrExpanded ? "primary ocr-launch-button" : "secondary-button ocr-launch-button",
            disabled: busy,
            onClick: () => setOcrExpanded((current) => !current),
            "aria-expanded": ocrExpanded,
          },
          e(UiIcon, { name: "image", size: 18 }),
          "Добавить текст с картинки",
        ),
        e(
          "details",
          { class: "ocr-settings-menu" },
          e(
            "summary",
            {
              class: "icon-button",
              "aria-label": "Настройки распознавания",
              title: "Настройки распознавания",
            },
            e(UiIcon, { name: "settings", size: 19 }),
          ),
          e(
            "div",
            { class: "ocr-settings-menu-panel" },
            e(
              "p",
              {
                class: `${printedInstalled ? "hint" : "error"} ocr-access-status`,
                role: "status",
                "aria-live": "polite",
              },
              accessStatus,
            ),
            e(
              "details",
              {
                class: "ocr-model-manager",
                open: !printedInstalled || Boolean(modelBusy),
              },
              e(
                "summary",
                { class: "ocr-model-summary" },
                e("span", null, "Модели OCR"),
                e("small", null, allModelsInstalled ? "Все установлены" : "Настроить"),
              ),
        e(
          "p",
          { class: "hint ocr-model-intro" },
          "Модели загружаются один раз и после проверки доступны без интернета.",
        ),
        e(
          "label",
          { class: "editor-label ocr-model-choice" },
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
          { class: "onboarding-actions ocr-model-actions" },
          e(
            "button",
            {
              type: "button",
              class: modelBusy ? "secondary-button" : "primary",
              disabled:
                busy ||
                (!modelBusy && (
                  !modelsChecked ||
                  allModelsInstalled ||
                  selectedChoiceInstalled
                )),
              onClick: modelBusy ? cancelModelInstall : installSelectedModels,
            },
            modelBusy
              ? "Отменить загрузку"
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
                : state.updateAvailable
                  ? `Доступно обновление · версия ${state.version}`
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
      e("h3", { class: "ocr-step-title ocr-options-title" }, "Параметры"),
      e(
        "label",
        { class: "editor-label ocr-setting" },
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
        { class: "editor-label ocr-setting" },
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
          ),
        ),
      ),
      ocrExpanded && e(
        "div",
        { class: "ocr-tool-body" },
        e(
          "p",
          { class: "hint ocr-privacy-note" },
          "Изображение и распознанный текст обрабатываются только на этом устройстве.",
        ),
      e("input", {
        ref: fileInput,
        type: "file",
        accept: "image/*",
        hidden: true,
        onChange: selectFile,
      }),
      e("h3", { class: "ocr-step-title ocr-source-title" }, "Изображение"),
      e(
        "div",
        { class: "onboarding-actions ocr-source-actions" },
        capabilities.touch && e(
          "button",
          {
            type: "button",
            class: "secondary-button",
            disabled: !canChooseImage,
            onClick: () => openImagePicker(true),
          },
          e(UiIcon, { name: "image", size: 17 }),
          "Снять фото",
        ),
        e(
          "button",
          {
            type: "button",
            class: "secondary-button",
            disabled: !canChooseImage,
            onClick: () => openImagePicker(false),
          },
          e(UiIcon, { name: "upload", size: 17 }),
          capabilities.touch ? "Из галереи" : "Выбрать изображение",
        ),
      ),
      file &&
        e(
          "div",
          { class: "ocr-selected-file" },
          e("span", { class: "ocr-selected-icon" }, e(UiIcon, { name: "image", size: 18 })),
          e("span", { class: "ocr-selected-copy" },
            e("strong", null, file.name),
            e("small", null, `${formatModelBytes(file.size)} · ${file.type || "image"}`),
          ),
          e("button", {
            type: "button",
            class: "icon-button",
            disabled: busy,
            onClick: () => {
              setFile(null);
              setSelection({ strokes: [] });
              setLastResult(null);
              setOcrDraft("");
            },
            "aria-label": "Убрать изображение",
            title: "Убрать изображение",
          }, e(UiIcon, { name: "trash", size: 16 })),
        ),
      file && e(OCRRegionSelector, {
        file,
        value: selection,
        disabled: busy,
        canRecognize: canRunOCR,
        onRecognize: () => void recognize(),
        onChange: (next: OCRSelectionMask) => {
          setSelection(next);
          setLastResult(null);
          setOcrDraft("");
          setOcrDraftHtml("");
        },
      }),
      error && e("p", { class: "error", role: "alert" }, error),
      !capabilities.worker &&
        e("p", { class: "error" }, "Web Worker недоступен в этом браузере."),
      ),
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
    busy && e(
      "div",
      {
        class: "ocr-floating-status is-busy",
        role: "status",
        "aria-live": "polite",
        title: progress?.message ?? "Распознаём текст",
      },
      e("span", { class: "sync-spinner" }),
      e("span", { class: "sr-only" }, progress?.message ?? "Распознаём текст"),
    ),
    !busy && lastResult && e(
      "button",
      {
        type: "button",
        class: "ocr-floating-status is-ready",
        onClick: () => setResultOpen(true),
        "aria-label": "Открыть распознанный текст",
        title: "Распознавание завершено — проверить текст",
      },
      e(UiIcon, { name: "check", size: 23 }),
    ),
    resultOpen && lastResult && e(
      "div",
      { class: "ocr-result-backdrop", role: "presentation" },
      e(
        "section",
        {
          class: "ocr-result-dialog",
          role: "dialog",
          "aria-modal": "true",
          "aria-labelledby": "ocr-result-title",
          "data-swipe-lock": "true",
        },
        e(
          "div",
          { class: "ocr-result-dialog-heading" },
          e("div", null,
            e("h2", { id: "ocr-result-title" }, "Проверьте распознанный текст"),
            e("p", { class: "hint" }, `${lastResult.modeUsed} · ${lastResult.durationMs} мс · строк: ${lastResult.lines.length}`)),
        ),
        e(RichTextEditor, {
          key: ocrDraftEditorKey,
          html: ocrDraftHtml,
          text: ocrDraft,
          variant: "comment",
          onChange: (nextHtml: string, nextText: string) => {
            setOcrDraftHtml(nextHtml);
            setOcrDraft(nextText);
          },
          onError: setError,
        }),
        e(
          "div",
          { class: "ocr-result-actions" },
          e("button", {
            type: "button",
            class: "secondary-button",
            onClick: cancelOcrDraft,
          }, "Отмена"),
          e("button", {
            type: "button",
            class: "primary",
            disabled: !ocrDraft.trim(),
            onClick: insertOcrDraft,
          }, "Добавить в заметку"),
        ),
      ),
    ),
  );
}
