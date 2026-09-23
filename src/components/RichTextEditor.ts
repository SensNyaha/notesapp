import { h as e } from "preact";
import { createPortal } from "preact/compat";
import { useEffect, useRef, useState } from "preact/hooks";
import type { NoteAttachment } from "../planner";
import { UiIcon } from "./ui.ts";
import { LoadingImage } from "./LoadingImage.ts";

const allowedTags = new Set([
  "A",
  "B",
  "BLOCKQUOTE",
  "BR",
  "CODE",
  "DIV",
  "EM",
  "FONT",
  "H1",
  "H2",
  "H3",
  "I",
  "LI",
  "OL",
  "P",
  "PRE",
  "S",
  "SPAN",
  "STRONG",
  "TABLE",
  "TBODY",
  "TD",
  "TH",
  "THEAD",
  "TR",
  "U",
  "UL",
]);
const allowedStyles = new Set([
  "color",
  "background-color",
  "font-family",
  "font-size",
  "text-align",
]);
const attachmentIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function plainToHtml(value: string) {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML.replaceAll("\n", "<br>");
}

export function sanitizeNoteHtml(value: string) {
  const template = document.createElement("template");
  template.innerHTML = value;
  const clean = (parent: ParentNode) => {
    for (const node of [...parent.childNodes]) {
      if (node.nodeType === Node.COMMENT_NODE) {
        node.remove();
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const element = node as HTMLElement;
      if (!allowedTags.has(element.tagName)) {
        const fragment = document.createDocumentFragment();
        while (element.firstChild) fragment.append(element.firstChild);
        element.replaceWith(fragment);
        clean(parent);
        continue;
      }
      for (const attribute of [...element.attributes]) {
        const name = attribute.name.toLowerCase();
        if (name === "style") {
          const declarations = [...element.style].filter((property) =>
            allowedStyles.has(property),
          );
          const values = declarations
            .map(
              (property) =>
                property + ":" + element.style.getPropertyValue(property),
            )
            .join(";");
          if (values) element.setAttribute("style", values);
          else element.removeAttribute("style");
        } else if (
          element.tagName === "A" &&
          name === "data-attachment-id"
        ) {
          if (!attachmentIdPattern.test(attribute.value))
            element.removeAttribute(attribute.name);
        } else if (element.tagName === "A" && name === "href") {
          try {
            const url = new URL(attribute.value, location.origin);
            if (!["http:", "https:", "mailto:"].includes(url.protocol))
              element.removeAttribute(attribute.name);
          } catch {
            element.removeAttribute(attribute.name);
          }
        } else if (
          element.tagName === "A" &&
          ["target", "rel"].includes(name)
        ) {
          element.removeAttribute(attribute.name);
        } else if (
          element.tagName === "FONT" &&
          ["face", "size", "color"].includes(name)
        ) {
          // document.execCommand uses these legacy attributes; they are presentation-only.
        } else element.removeAttribute(attribute.name);
      }
      if (element.tagName === "A") {
        const attachmentId = element.getAttribute("data-attachment-id"),
          href = element.getAttribute("href"),
          attachmentLink = Boolean(
            attachmentId &&
              attachmentIdPattern.test(attachmentId) &&
              href === "#attachment-" + attachmentId,
          );
        if (attachmentLink) {
          element.removeAttribute("target");
          element.removeAttribute("rel");
        } else if (href) {
          element.removeAttribute("data-attachment-id");
          if (href?.startsWith("#attachment-")) element.removeAttribute("href");
          else {
            element.setAttribute("target", "_blank");
            element.setAttribute("rel", "noopener noreferrer");
          }
        } else element.removeAttribute("data-attachment-id");
      }
      clean(element);
    }
  };
  clean(template.content);
  return template.innerHTML;
}

function htmlText(value: string) {
  const element = document.createElement("div");
  element.style.cssText =
    "position:fixed;left:-100000px;top:0;width:800px;visibility:hidden;white-space:pre-wrap";
  element.innerHTML = value;
  document.body.append(element);
  const text = element.innerText.replace(/\u00a0/g, " ");
  element.remove();
  return text;
}

export function removeAttachmentReferences(
  html: string | undefined,
  text: string,
  attachmentId: string,
) {
  if (!html) return { html, text };
  const template = document.createElement("template");
  template.innerHTML = sanitizeNoteHtml(html);
  let changed = false;
  for (const link of [
    ...template.content.querySelectorAll<HTMLAnchorElement>(
      "a[data-attachment-id], a[href^='#attachment-']",
    ),
  ]) {
    if (
      link.dataset.attachmentId === attachmentId ||
      link.getAttribute("href") === "#attachment-" + attachmentId
    ) {
      link.remove();
      changed = true;
    }
  }
  if (!changed) return { html, text };
  const nextHtml = sanitizeNoteHtml(template.innerHTML);
  return { html: nextHtml, text: htmlText(nextHtml) };
}

export function renameAttachmentReferences(
  html: string | undefined,
  text: string,
  attachmentId: string,
  name: string,
) {
  if (!html) return { html, text };
  const template = document.createElement("template");
  template.innerHTML = sanitizeNoteHtml(html);
  let changed = false;
  for (const link of [
    ...template.content.querySelectorAll<HTMLAnchorElement>(
      `a[data-attachment-id="${attachmentId}"]`,
    ),
  ]) {
    link.textContent = name;
    changed = true;
  }
  if (!changed) return { html, text };
  const nextHtml = sanitizeNoteHtml(template.innerHTML);
  return { html: nextHtml, text: htmlText(nextHtml) };
}

function command(name: string, value?: string) {
  document.execCommand(name, false, value);
}
function readFile(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
function attachmentUrl(item: NoteAttachment) {
  return item.data &&
    /^data:[^;,]{1,100};base64,[A-Za-z0-9+/=]+$/.test(item.data)
    ? item.data
    : "";
}
function imageUrl(item: NoteAttachment) {
  return item.data &&
    /^image\/(png|jpeg|gif|webp|avif)$/i.test(item.type) &&
    /^data:image\/(png|jpeg|gif|webp|avif);base64,/i.test(item.data)
    ? item.data
    : "";
}

function AsyncPreview({
  item,
  load,
}: {
  item: NoteAttachment;
  load?: (item: NoteAttachment) => Promise<Blob | null>;
}) {
  const inline = imageUrl(item);
  return e(LoadingImage, {
    src: inline,
    load: !inline && load ? () => load(item) : undefined,
    cacheKey: item.id,
    alt: item.name,
    frameClassName: "attachment-preview-image-frame",
  });
}

function ImageGallery({
  items,
  activeId,
  load,
  onSelect,
  onClose,
}: {
  items: NoteAttachment[];
  activeId: string;
  load?: (item: NoteAttachment) => Promise<Blob | null>;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const item = items.find((current) => current.id === activeId) ?? items[0];
  const index = Math.max(
    0,
    items.findIndex((current) => current.id === item.id),
  );
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  const selectOffset = (offset: number) => {
    const next = (index + offset + items.length) % items.length;
    onSelect(items[next].id);
  };

  useEffect(() => {
    let active = true;
    let current = "";
    const inline = imageUrl(item);
    setUrl(inline);
    setLoading(!inline);
    setFailed(false);
    if (!inline) {
      if (!load) {
        setLoading(false);
        setFailed(true);
      } else {
        void load(item)
          .then((blob) => {
            if (!active) return;
            if (!blob) {
              setFailed(true);
              return;
            }
            current = URL.createObjectURL(blob);
            setUrl(current);
          })
          .catch(() => active && setFailed(true))
          .finally(() => active && setLoading(false));
      }
    }
    return () => {
      active = false;
      if (current) URL.revokeObjectURL(current);
    };
  }, [item.id]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      else if (items.length > 1 && event.key === "ArrowLeft") {
        event.preventDefault();
        selectOffset(-1);
      } else if (items.length > 1 && event.key === "ArrowRight") {
        event.preventDefault();
        selectOffset(1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [index, items.length]);

  return e(
    "div",
    {
      class: "image-gallery-backdrop",
      role: "presentation",
      onMouseDown: (event: MouseEvent) => {
        if (event.target === event.currentTarget) onClose();
      },
    },
    e(
      "section",
      {
        class: "image-gallery",
        role: "dialog",
        "aria-modal": "true",
        "aria-label": "Просмотр изображения " + item.name,
      },
      e(
        "div",
        { class: "image-gallery-header" },
        e("strong", { title: item.name }, item.name),
        e("span", null, index + 1 + " / " + items.length),
        e(
          "button",
          {
            ref: closeButton,
            type: "button",
            class: "image-gallery-close",
            onClick: onClose,
            "aria-label": "Закрыть галерею",
            title: "Закрыть",
          },
          "×",
        ),
      ),
      e(
        "div",
        {
          class: "image-gallery-stage",
          onMouseDown: (event: MouseEvent) => {
            if (event.target === event.currentTarget) onClose();
          },
        },
        loading && e("div", {
          class: "image-gallery-loading image-loading-skeleton",
          role: "status",
          "aria-label": "Изображение загружается",
        }, e("span", { class: "sync-spinner" })),
        failed &&
          e(
            "p",
            { class: "image-gallery-message error" },
            "Не удалось открыть изображение.",
          ),
        url &&
          !failed &&
          e("img", {
            src: url,
            alt: item.name,
            draggable: false,
            onLoad: () => setLoading(false),
            onError: () => {
              setLoading(false);
              setFailed(true);
            },
          }),
        items.length > 1 &&
          e(
            "button",
            {
              type: "button",
              class: "image-gallery-nav previous",
              onClick: () => selectOffset(-1),
              "aria-label": "Предыдущее изображение",
              title: "Предыдущее изображение",
            },
            e(UiIcon, { name: "back", size: 24 }),
          ),
        items.length > 1 &&
          e(
            "button",
            {
              type: "button",
              class: "image-gallery-nav next",
              onClick: () => selectOffset(1),
              "aria-label": "Следующее изображение",
              title: "Следующее изображение",
            },
            e(UiIcon, { name: "chevron-right", size: 24 }),
          ),
      ),
    ),
  );
}

export function Attachments({
  items,
  onRemove,
  onDownload,
  onRename,
  onSetCover,
  onInsertLink,
  onMove,
  coverId,
  loadPreview,
  loadFullImage,
  moveTargets = [],
  viewMode = false,
}: {
  items: NoteAttachment[];
  onRemove?: (item: NoteAttachment) => void;
  onDownload?: (item: NoteAttachment) => void;
  onRename?: (item: NoteAttachment) => void;
  onSetCover?: (item: NoteAttachment) => void;
  onInsertLink?: (item: NoteAttachment) => void;
  onMove?: (item: NoteAttachment, objectId: string) => void;
  coverId?: string;
  loadPreview?: (item: NoteAttachment) => Promise<Blob | null>;
  loadFullImage?: (item: NoteAttachment) => Promise<Blob | null>;
  moveTargets?: { id: string; title: string }[];
  viewMode?: boolean;
}) {
  const [galleryId, setGalleryId] = useState<string | null>(null);
  const galleryItems = items.filter((item) => item.type.startsWith("image/"));
  const galleryItem = galleryId
    ? galleryItems.find((item) => item.id === galleryId)
    : undefined;
  if (!items.length) return null;
  return e(
    "section",
    { class: "note-attachments", "aria-label": "Вложения" },
    e(
      "div",
      { class: "section-heading" },
      e("h2", null, "Файлы"),
      e(
        "p",
        { class: "muted" },
        items.length + " " + (items.length === 1 ? "файл" : "файлов"),
      ),
    ),
    e(
      "div",
      { class: "attachment-list" },
      items.map((item) => {
        const image = item.type.startsWith("image/"),
          cover = coverId === item.id;
        return e(
          "article",
          {
            id: "attachment-" + item.id,
            class:
              "attachment-card" +
              (cover ? " is-cover" : "") +
              (image ? " is-image" : "") +
              (viewMode ? " is-view-mode" : ""),
            key: item.id,
          },
          e(
            viewMode && image ? "button" : "div",
            {
              class:
                "attachment-preview" +
                (viewMode && image ? " attachment-preview-button" : ""),
              ...(viewMode && image
                ? {
                    type: "button",
                    onClick: () => setGalleryId(item.id),
                    "aria-label": "Открыть изображение " + item.name,
                    title: "Открыть изображение",
                  }
                : {}),
            },
            image
              ? e(AsyncPreview, { item, load: loadPreview })
              : e(
                  "span",
                  { class: "attachment-extension" },
                  fileExtension(item.name),
                ),
          ),
          e(
            "div",
            { class: "attachment-copy" },
            e(
              "div",
              { class: "attachment-title-row" },
              e("strong", null, item.name),
              cover &&
                !viewMode &&
                e("span", { class: "badge accent" }, "Обложка"),
            ),
            e(
              "small",
              null,
              formatBytes(item.size) + " · " + (item.type || "Файл"),
            ),
          ),
          e(
            "div",
            { class: "attachment-actions" },
            viewMode &&
              cover &&
              e(
                "span",
                { class: "badge accent attachment-cover-badge" },
                "Обложка",
              ),
            item.data && !onDownload
              ? e(
                  "a",
                  {
                    class:
                      "attachment-action" +
                      (viewMode
                        ? " attachment-icon-button attachment-action-control attachment-download-action"
                        : ""),
                    href: attachmentUrl(item),
                    download: item.name,
                    "aria-label": "Скачать " + item.name,
                    title: "Скачать",
                  },
                  e(UiIcon, { name: "download", size: 17 }),
                  !viewMode && "Скачать",
                )
              : onDownload &&
                  e(
                    "button",
                    {
                      type: "button",
                      class:
                        "tertiary-button" +
                        (viewMode
                          ? " attachment-icon-button attachment-action-control attachment-download-action"
                          : ""),
                      onClick: () => onDownload(item),
                      "aria-label": "Скачать " + item.name,
                      title: "Скачать",
                    },
                    e(UiIcon, { name: "download", size: 17 }),
                    !viewMode && "Скачать",
                  ),
            onRename &&
              e(
                "button",
                {
                  type: "button",
                  class: "tertiary-button",
                  onClick: () => onRename(item),
                },
                e(UiIcon, { name: "edit", size: 17 }),
                "Переименовать",
              ),
            onInsertLink &&
              e(
                "button",
                {
                  type: "button",
                  class: "tertiary-button",
                  onClick: () => onInsertLink(item),
                  "aria-label": "Вставить ссылку на " + item.name,
                  title: "Вставить ссылку в текст заметки",
                },
                e(UiIcon, { name: "paperclip", size: 17 }),
                "Вставить ссылку",
              ),
            onSetCover &&
              image &&
              (!viewMode || !cover) &&
              e(
                "button",
                {
                  type: "button",
                  class:
                    (cover ? "secondary-button" : "tertiary-button") +
                    (viewMode
                      ? " attachment-icon-button attachment-action-control attachment-cover-action"
                      : ""),
                  onClick: () => onSetCover(item),
                  "aria-label": cover
                    ? "Обложка"
                    : "Сделать обложкой " + item.name,
                  title: cover ? "Обложка" : "Сделать обложкой",
                },
                e(UiIcon, { name: "image", size: 17 }),
                !viewMode && (cover ? "Обложка" : "На обложку"),
              ),
            onMove &&
              moveTargets.length > 0 &&
              e(
                "select",
                {
                  class:
                    "attachment-move" +
                    (viewMode ? " attachment-action-control" : ""),
                  value: "",
                  "aria-label": "Переместить вложение " + item.name,
                  onChange: (ev: Event) => {
                    const value = (ev.target as HTMLSelectElement).value;
                    if (value) onMove(item, value);
                  },
                },
                e("option", { value: "" }, "Переместить…"),
                moveTargets.map((target) =>
                  e(
                    "option",
                    { value: target.id, key: target.id },
                    target.title || "Без заголовка",
                  ),
                ),
              ),
            onRemove &&
              e(
                "button",
                {
                  type: "button",
                  class: "text-danger-button",
                  onClick: () => onRemove(item),
                  "aria-label": "Удалить вложение " + item.name,
                },
                e(UiIcon, { name: "trash", size: 17 }),
                "Удалить",
              ),
          ),
        );
      }),
    ),
    viewMode &&
      galleryItem &&
      e(ImageGallery, {
        items: galleryItems,
        activeId: galleryItem.id,
        load: loadFullImage ?? loadPreview,
        onSelect: setGalleryId,
        onClose: () => setGalleryId(null),
      }),
  );
}
function formatBytes(value: number) {
  if (value < 1024) return value + " Б";
  if (value < 1024 * 1024)
    return (value / 1024).toFixed(value < 10 * 1024 ? 1 : 0) + " КБ";
  if (value < 1024 * 1024 * 1024)
    return (
      (value / 1024 / 1024).toFixed(value < 10 * 1024 * 1024 ? 1 : 0) + " МБ"
    );
  return (value / 1024 / 1024 / 1024).toFixed(1) + " ГБ";
}
function fileExtension(name: string) {
  const match = /\.([a-z0-9]{1,10})$/i.exec(name.trim());
  return match ? "." + match[1].toLocaleLowerCase("en-US") : "file";
}

type EditorMenuKind = "block" | "font" | "size";
type EditorMenuPosition = {
  left: number;
  top?: number;
  bottom?: number;
  width: number;
  maxHeight: number;
};

const editorFormatMenus: Record<
  EditorMenuKind,
  { command: string; items: { value: string; label: string }[] }
> = {
  block: {
    command: "formatBlock",
    items: [
      { value: "p", label: "Обычный" },
      { value: "h1", label: "Заголовок 1" },
      { value: "h2", label: "Заголовок 2" },
      { value: "blockquote", label: "Цитата" },
      { value: "pre", label: "Код" },
    ],
  },
  font: {
    command: "fontName",
    items: [
      { value: "-apple-system", label: "Системный" },
      { value: "Arial", label: "Arial" },
      { value: "Georgia", label: "Georgia" },
      { value: "monospace", label: "Моноширинный" },
    ],
  },
  size: {
    command: "fontSize",
    items: [
      { value: "3", label: "Обычный" },
      { value: "2", label: "Мелкий" },
      { value: "4", label: "Крупный" },
      { value: "5", label: "Очень крупный" },
    ],
  },
};

export function RichTextEditor({
  html,
  text,
  attachments = [],
  onChange,
  onAttachmentsChange,
  onFilesSelected,
  onRemoveAttachment,
  onDownloadAttachment,
  onRenameAttachment,
  onSetCover,
  coverId,
  loadPreview,
  onError,
  variant = "note",
}: {
  html?: string;
  text: string;
  attachments?: NoteAttachment[];
  onChange: (html: string, text: string) => void;
  onAttachmentsChange?: (items: NoteAttachment[]) => void;
  onFilesSelected?: (
    files: File[],
    options?: { asCover?: boolean },
  ) => Promise<void> | void;
  onRemoveAttachment?: (item: NoteAttachment) => void;
  onDownloadAttachment?: (item: NoteAttachment) => void;
  onRenameAttachment?: (item: NoteAttachment) => void;
  onSetCover?: (item: NoteAttachment) => void;
  coverId?: string;
  loadPreview?: (item: NoteAttachment) => Promise<Blob | null>;
  onError: (message: string) => void;
  variant?: "note" | "comment";
}) {
  const editor = useRef<HTMLDivElement>(null),
    toolbar = useRef<HTMLDivElement>(null),
    formatMenuRoot = useRef<HTMLDivElement>(null),
    formatMenuTrigger = useRef<HTMLButtonElement>(null),
    activeCell = useRef<HTMLTableCellElement | null>(null),
    files = useRef<HTMLInputElement>(null),
    cover = useRef<HTMLInputElement>(null),
    selection = useRef<Range | null>(null);
  const [editing, setEditing] = useState(false);
  const [tableEditing, setTableEditing] = useState(false);
  const [formatMenu, setFormatMenu] = useState<EditorMenuKind | null>(null);
  const [formatMenuPosition, setFormatMenuPosition] =
    useState<EditorMenuPosition | null>(null);
  const initial = useRef(sanitizeNoteHtml(html ?? plainToHtml(text)));
  const reported = useRef(initial.current);
  useEffect(() => {
    if (editor.current) editor.current.innerHTML = initial.current;
  }, []);
  useEffect(() => {
    const root = editor.current,
      incoming = sanitizeNoteHtml(html ?? plainToHtml(text));
    if (!root || incoming === reported.current) return;
    if (sanitizeNoteHtml(root.innerHTML) !== incoming) root.innerHTML = incoming;
    reported.current = incoming;
    activeCell.current?.removeAttribute("data-editor-active-cell");
    activeCell.current = null;
    setTableEditing(false);
  }, [html, text]);
  useEffect(() => {
    if (!formatMenu) return;
    formatMenuRoot.current
      ?.querySelector<HTMLButtonElement>("button[role='menuitem']")
      ?.focus({ preventScroll: true });
    const closeOutside = (event: Event) => {
      const target = event.target as Node | null;
      if (
        target &&
        (formatMenuRoot.current?.contains(target) ||
          formatMenuTrigger.current?.contains(target))
      )
        return;
      setFormatMenu(null);
    };
    const closeOnViewportChange = () => setFormatMenu(null);
    document.addEventListener("pointerdown", closeOutside, true);
    window.addEventListener("resize", closeOnViewportChange);
    window.addEventListener("scroll", closeOnViewportChange, true);
    window.visualViewport?.addEventListener("resize", closeOnViewportChange);
    return () => {
      document.removeEventListener("pointerdown", closeOutside, true);
      window.removeEventListener("resize", closeOnViewportChange);
      window.removeEventListener("scroll", closeOnViewportChange, true);
      window.visualViewport?.removeEventListener(
        "resize",
        closeOnViewportChange,
      );
    };
  }, [formatMenu]);
  const remember = () => {
    const selected = document.getSelection(),
      root = editor.current;
    if (selected?.rangeCount && root?.contains(selected.anchorNode))
      selection.current = selected.getRangeAt(0).cloneRange();
  };
  const updateTableContext = () => {
    const selected = document.getSelection(),
      root = editor.current,
      anchor = selected?.anchorNode,
      element =
        anchor?.nodeType === Node.ELEMENT_NODE
          ? (anchor as Element)
          : anchor?.parentElement,
      cell = element?.closest<HTMLTableCellElement>("td, th") ?? null,
      nextCell = cell && root?.contains(cell) ? cell : null;
    if (activeCell.current !== nextCell)
      activeCell.current?.removeAttribute("data-editor-active-cell");
    activeCell.current = nextCell;
    nextCell?.setAttribute("data-editor-active-cell", "true");
    setTableEditing(Boolean(nextCell));
  };
  const restore = () => {
    const selected = document.getSelection();
    if (selection.current && selected) {
      selected.removeAllRanges();
      selected.addRange(selection.current);
    }
    editor.current?.focus();
  };
  const changed = () => {
    const root = editor.current;
    if (root) {
      remember();
      const nextHtml = sanitizeNoteHtml(root.innerHTML);
      reported.current = nextHtml;
      onChange(nextHtml, root.innerText.replace(/\u00a0/g, " "));
      updateTableContext();
    }
  };
  const apply = (name: string, value?: string) => {
    restore();
    command(name, value);
    changed();
  };
  const keepSelection = (event: MouseEvent) => event.preventDefault();
  const focusNodeStart = (node: HTMLElement) => {
    const selected = document.getSelection(),
      range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(true);
    selected?.removeAllRanges();
    selected?.addRange(range);
    selection.current = range.cloneRange();
    editor.current?.focus({ preventScroll: true });
    setEditing(true);
    updateTableContext();
  };
  const tableContext = () => {
    const cell = activeCell.current,
      table = cell?.closest<HTMLTableElement>("table"),
      row = cell?.parentElement;
    if (
      !cell ||
      !table ||
      !(row instanceof HTMLTableRowElement) ||
      !editor.current?.contains(table)
    )
      return null;
    return { cell, table, row };
  };
  const addTableRow = (before: boolean) => {
    const context = tableContext();
    if (!context) return;
    const row = document.createElement("tr");
    for (const source of [...context.row.cells]) {
      const cell = document.createElement(
        source.tagName === "TH" ? "th" : "td",
      );
      cell.append(document.createElement("br"));
      row.append(cell);
    }
    if (!row.cells.length) {
      const cell = document.createElement("td");
      cell.append(document.createElement("br"));
      row.append(cell);
    }
    if (before) context.row.before(row);
    else context.row.after(row);
    focusNodeStart(row.cells[0]);
    changed();
  };
  const addTableColumn = (before: boolean) => {
    const context = tableContext();
    if (!context) return;
    const index = context.cell.cellIndex + (before ? 0 : 1);
    let target: HTMLTableCellElement | null = null;
    for (const row of [...context.table.rows]) {
      const reference = row.cells[Math.min(index, row.cells.length - 1)],
        header =
          reference?.tagName === "TH" ||
          (row.cells.length > 0 &&
            [...row.cells].every((cell) => cell.tagName === "TH")),
        cell = document.createElement(header ? "th" : "td"),
        insertionPoint = row.cells[index] ?? null;
      cell.append(document.createElement("br"));
      row.insertBefore(cell, insertionPoint);
      if (row === context.row) target = cell;
    }
    if (target) focusNodeStart(target);
    changed();
  };
  const removeTable = () => {
    const context = tableContext();
    if (!context) return;
    const paragraph = document.createElement("p");
    paragraph.append(document.createElement("br"));
    context.table.after(paragraph);
    context.table.remove();
    activeCell.current = null;
    setTableEditing(false);
    focusNodeStart(paragraph);
    changed();
  };
  const removeTableRow = () => {
    const context = tableContext();
    if (!context) return;
    if (context.table.rows.length <= 1) {
      removeTable();
      return;
    }
    const rows = [...context.table.rows],
      index = rows.indexOf(context.row),
      next = rows[index + 1] ?? rows[index - 1],
      cellIndex = context.cell.cellIndex;
    context.row.remove();
    const target = next?.cells[Math.min(cellIndex, next.cells.length - 1)];
    if (target) focusNodeStart(target);
    changed();
  };
  const removeTableColumn = () => {
    const context = tableContext();
    if (!context) return;
    const index = context.cell.cellIndex;
    if ([...context.table.rows].every((row) => row.cells.length <= 1)) {
      removeTable();
      return;
    }
    for (const row of [...context.table.rows])
      if (row.cells[index]) row.deleteCell(index);
    const target =
      context.row.cells[Math.min(index, context.row.cells.length - 1)] ??
      context.table.querySelector<HTMLTableCellElement>("th, td");
    if (target) focusNodeStart(target);
    changed();
  };
  const moveThroughTable = (backward: boolean) => {
    const context = tableContext();
    if (!context) return false;
    const cells = [
        ...context.table.querySelectorAll<HTMLTableCellElement>("th, td"),
      ],
      index = cells.indexOf(context.cell),
      target = cells[index + (backward ? -1 : 1)];
    if (target) {
      focusNodeStart(target);
      return true;
    }
    if (!backward) {
      addTableRow(false);
      return true;
    }
    return false;
  };
  const removeEmptyTableRowAtCaret = () => {
    const selected = document.getSelection();
    if (!selected?.rangeCount || !selected.isCollapsed) return false;
    const anchor = selected.anchorNode,
      element =
        anchor?.nodeType === Node.ELEMENT_NODE
          ? (anchor as Element)
          : anchor?.parentElement,
      cell = element?.closest<HTMLTableCellElement>("td, th"),
      row = cell?.parentElement;
    if (
      !cell ||
      !(row instanceof HTMLTableRowElement) ||
      cell.cellIndex !== 0 ||
      !editor.current?.contains(row) ||
      [...row.cells].some(
        (item) =>
          (item.textContent ?? "")
            .replace(/[\u00a0\u200b\ufeff]/g, "")
            .trim().length > 0,
      )
    )
      return false;
    activeCell.current?.removeAttribute("data-editor-active-cell");
    activeCell.current = cell;
    cell.setAttribute("data-editor-active-cell", "true");
    removeTableRow();
    return true;
  };
  const rangeCoversNodeText = (range: Range, node: Node) => {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let first: Text | null = null,
      last: Text | null = null,
      current = walker.nextNode();
    while (current) {
      const textNode = current as Text;
      if (textNode.data.length) {
        first ??= textNode;
        last = textNode;
      }
      current = walker.nextNode();
    }
    const contents = document.createRange();
    if (first && last) {
      contents.setStart(first, 0);
      contents.setEnd(last, last.data.length);
    } else contents.selectNodeContents(node);
    return (
      range.compareBoundaryPoints(Range.START_TO_START, contents) <= 0 &&
      range.compareBoundaryPoints(Range.END_TO_END, contents) >= 0
    );
  };
  const replaceBlockWithParagraph = (block: HTMLElement) => {
    if (
      !block.isConnected ||
      !["H1", "H2", "H3", "BLOCKQUOTE", "PRE"].includes(block.tagName)
    )
      return;
    if (block.tagName === "BLOCKQUOTE") {
      const fragment = document.createDocumentFragment();
      while (block.firstChild) fragment.append(block.firstChild);
      block.replaceWith(fragment);
      return;
    }
    const paragraph = document.createElement("p");
    if (block.tagName === "PRE")
      paragraph.innerHTML = plainToHtml(block.innerText || block.textContent || "");
    else while (block.firstChild) paragraph.append(block.firstChild);
    block.replaceWith(paragraph);
  };
  const placeCaretAtTextOffset = (container: HTMLElement, offset: number) => {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let remaining = offset,
      current = walker.nextNode(),
      last: Text | null = null;
    while (current) {
      const textNode = current as Text;
      last = textNode;
      if (remaining <= textNode.data.length) {
        const range = document.createRange(),
          selected = document.getSelection();
        range.setStart(textNode, remaining);
        range.collapse(true);
        selected?.removeAllRanges();
        selected?.addRange(range);
        selection.current = range.cloneRange();
        return;
      }
      remaining -= textNode.data.length;
      current = walker.nextNode();
    }
    const range = document.createRange(),
      selected = document.getSelection();
    if (last) range.setStart(last, last.data.length);
    else {
      range.selectNodeContents(container);
      range.collapse(true);
    }
    range.collapse(true);
    selected?.removeAllRanges();
    selected?.addRange(range);
    selection.current = range.cloneRange();
  };
  const flattenTable = (table: HTMLTableElement) => {
    if (!table.isConnected) return;
    const fragment = document.createDocumentFragment(),
      rows = [...table.rows];
    rows.forEach((row, rowIndex) => {
      const value = [...row.cells]
        .map((cell) =>
          (cell.innerText || cell.textContent || "")
            .replace(/\s*\n\s*/g, " ")
            .trim(),
        )
        .join("\t");
      fragment.append(document.createTextNode(value));
      if (rowIndex < rows.length - 1) fragment.append(document.createElement("br"));
    });
    table.replaceWith(fragment);
  };
  const clearFormatting = () => {
    restore();
    const selected = document.getSelection(),
      root = editor.current;
    if (!selected?.rangeCount || !root) return;
    const range = selected.getRangeAt(0);
    if (range.collapsed) {
      const anchor = range.startContainer,
        element =
          anchor.nodeType === Node.ELEMENT_NODE
            ? (anchor as Element)
            : anchor.parentElement,
        candidate = element?.closest<HTMLElement>(
          "p, div, h1, h2, h3, blockquote, pre, li, td, th",
        ),
        block = candidate === root ? null : candidate,
        prefix = document.createRange(),
        lineRange = document.createRange();
      if (block && root.contains(block)) lineRange.selectNodeContents(block);
      else {
        const children = [...root.childNodes];
        let top: Node | null = anchor;
        while (top?.parentNode && top.parentNode !== root) top = top.parentNode;
        const childIndex =
            range.startContainer === root
              ? range.startOffset
              : Math.max(
                  0,
                  children.findIndex((child) => child === top),
                ),
          boundary = (node: Node | undefined) =>
            node?.nodeName === "BR" ||
            (node instanceof HTMLElement &&
              ["P", "DIV", "H1", "H2", "H3", "BLOCKQUOTE", "PRE", "LI", "TABLE"].includes(
                node.tagName,
              ));
        let start = childIndex,
          end = range.startContainer === root ? childIndex : childIndex + 1;
        while (start > 0 && !boundary(children[start - 1])) start -= 1;
        while (end < children.length && !boundary(children[end])) end += 1;
        lineRange.setStart(root, start);
        lineRange.setEnd(root, end);
      }
      prefix.selectNodeContents(root);
      prefix.setEnd(range.startContainer, range.startOffset);
      const caretOffset = prefix.toString().length;
      selected.removeAllRanges();
      selected.addRange(lineRange);
      command("removeFormat");
      command("unlink");
      if (block) replaceBlockWithParagraph(block);
      placeCaretAtTextOffset(root, caretOffset);
      changed();
      return;
    }
    const original = range.cloneRange(),
      tables = [...root.querySelectorAll<HTMLTableElement>("table")].filter(
        (table) =>
          original.intersectsNode(table) &&
          rangeCoversNodeText(original, table) &&
          [...table.querySelectorAll("th, td")].every((cell) =>
            original.intersectsNode(cell),
          ),
      ),
      blocks = [
        ...root.querySelectorAll<HTMLElement>("h1, h2, h3, blockquote, pre"),
      ].filter(
        (block) =>
          original.intersectsNode(block) && rangeCoversNodeText(original, block),
      );
    command("removeFormat");
    command("unlink");
    blocks.forEach(replaceBlockWithParagraph);
    tables.forEach(flattenTable);
    editor.current?.focus({ preventScroll: true });
    changed();
  };
  const unwrapListItemAtCaret = () => {
    const selected = document.getSelection();
    if (!selected?.rangeCount || !selected.isCollapsed) return false;
    const range = selected.getRangeAt(0),
      anchor = range.startContainer,
      element =
        anchor.nodeType === Node.ELEMENT_NODE
          ? (anchor as Element)
          : anchor.parentElement,
      item = element?.closest<HTMLLIElement>("li"),
      root = editor.current;
    if (!item || !root?.contains(item)) return false;
    const beforeCaret = range.cloneRange();
    beforeCaret.selectNodeContents(item);
    beforeCaret.setEnd(range.startContainer, range.startOffset);
    if (beforeCaret.toString().replace(/[\u200b\ufeff]/g, "").length)
      return false;
    const list = item.parentElement;
    if (!list || !["UL", "OL"].includes(list.tagName)) return false;
    if (list.parentElement?.closest("li")) {
      command("outdent");
      changed();
      return true;
    }
    const parent = list.parentNode;
    if (!parent) return false;
    const afterList = list.cloneNode(false) as HTMLElement;
    while (item.nextSibling) afterList.append(item.nextSibling);
    const paragraph = document.createElement("p");
    while (item.firstChild) paragraph.append(item.firstChild);
    if (!paragraph.childNodes.length)
      paragraph.append(document.createElement("br"));
    parent.insertBefore(paragraph, list.nextSibling);
    if (afterList.childNodes.length)
      parent.insertBefore(afterList, paragraph.nextSibling);
    item.remove();
    if (!list.children.length) list.remove();
    focusNodeStart(paragraph);
    changed();
    return true;
  };
  const openFormatMenu = (kind: EditorMenuKind, event: MouseEvent) => {
    remember();
    const trigger = event.currentTarget as HTMLButtonElement,
      rect = trigger.getBoundingClientRect(),
      viewportHeight = window.visualViewport?.height ?? window.innerHeight,
      viewportWidth = window.visualViewport?.width ?? window.innerWidth,
      width = Math.max(1, Math.min(228, viewportWidth - 16)),
      left = Math.max(8, Math.min(rect.left, viewportWidth - width - 8)),
      itemCount = editorFormatMenus[kind].items.length,
      desiredHeight = Math.min(itemCount * 46 + 12, 260),
      above = Math.max(0, rect.top - 8),
      below = Math.max(0, viewportHeight - rect.bottom - 8),
      openAbove = above >= Math.min(desiredHeight, 144) || above > below;
    formatMenuTrigger.current = trigger;
    setFormatMenuPosition(
      openAbove
        ? {
            left,
            bottom: viewportHeight - rect.top + 6,
            width,
            maxHeight: Math.max(1, above - 6),
          }
        : {
            left,
            top: rect.bottom + 6,
            width,
            maxHeight: Math.max(1, below - 6),
          },
    );
    setFormatMenu((current) => (current === kind ? null : kind));
  };
  const formatMenuButton = (
    kind: EditorMenuKind,
    label: string,
    ariaLabel: string,
  ) =>
    e(
      "button",
      {
        type: "button",
        class: "editor-format-menu-trigger",
        onMouseDown: keepSelection,
        onClick: (event: MouseEvent) => openFormatMenu(kind, event),
        "aria-label": ariaLabel,
        "aria-haspopup": "menu",
        "aria-expanded": formatMenu === kind,
      },
      label,
      e(
        "span",
        { class: "editor-format-chevron", "aria-hidden": "true" },
        e(UiIcon, { name: "chevron-right", size: 16 }),
      ),
    );
  const addTable = () => {
    restore();
    const marker = crypto.randomUUID();
    command(
      "insertHTML",
      `<table data-new-editor-table="${marker}"><tbody><tr><th>Заголовок</th><th>Заголовок</th></tr><tr><td>Ячейка</td><td>Ячейка</td></tr></tbody></table><p><br></p>`,
    );
    const table = editor.current?.querySelector<HTMLTableElement>(
      `table[data-new-editor-table="${marker}"]`,
    );
    table?.removeAttribute("data-new-editor-table");
    const firstCell = table?.rows[1]?.cells[0] ?? table?.rows[0]?.cells[0];
    if (firstCell) focusNodeStart(firstCell);
    changed();
  };
  const insertAttachmentLink = (item: NoteAttachment) => {
    apply(
      "insertHTML",
      `<a href="#attachment-${item.id}" data-attachment-id="${item.id}">${plainToHtml(item.name)}</a>`,
    );
  };
  const addFiles = async (event: Event, asCover = false) => {
    const input = event.target as HTMLInputElement;
    const selected = [...(input.files ?? [])];
    input.value = "";
    if (!selected.length) return;
    if (asCover && !selected[0].type.startsWith("image/")) {
      onError("Для обложки выберите изображение.");
      return;
    }
    if (attachments.length + selected.length > 500) {
      onError("В одной заметке допускается до 500 вложений.");
      return;
    }
    if (onFilesSelected) {
      try {
        await onFilesSelected(selected, { asCover });
      } catch (caught) {
        onError(
          caught instanceof Error
            ? caught.message
            : "Не удалось загрузить выбранный файл.",
        );
      }
      return;
    }
    try {
      const legacy = selected.filter((file) => file.size <= 512 * 1024);
      if (legacy.length !== selected.length)
        throw Error("Для больших файлов нужен потоковый загрузчик.");
      const added = await Promise.all(
        legacy.map(async (file) => ({
          id: crypto.randomUUID(),
          name: file.name.slice(0, 200) || "Файл",
          type: file.type.slice(0, 100) || "application/octet-stream",
          size: file.size,
          data: await readFile(file),
        })),
      );
      onAttachmentsChange?.([...attachments, ...added]);
      if (asCover && added[0]) onSetCover?.(added[0]);
    } catch (caught) {
      onError(
        caught instanceof Error
          ? caught.message
          : "Не удалось прочитать выбранный файл.",
      );
    }
  };
  const paste = (event: ClipboardEvent) => {
    event.preventDefault();
    const source = event.clipboardData?.getData("text/html");
    apply(
      source ? "insertHTML" : "insertText",
      source
        ? sanitizeNoteHtml(source)
        : (event.clipboardData?.getData("text/plain") ?? ""),
    );
  };
  const comment = variant === "comment";
  return e(
    "div",
    { class: "rich-editor" + (comment ? " comment-rich-editor" : "") },
    e(
      "div",
      {
        ref: toolbar,
        class: "editor-toolbar" + (editing ? " is-editing" : ""),
        role: "toolbar",
        "aria-label": comment
          ? "Форматирование комментария"
          : "Форматирование заметки",
        onBlur: (event: FocusEvent) => {
          const next = event.relatedTarget as Node | null;
          if (
            !formatMenu &&
            (!next ||
              (!toolbar.current?.contains(next) &&
                !editor.current?.contains(next)))
          )
            setEditing(false);
        },
      },
      e(
        "button",
        {
          type: "button",
          onMouseDown: keepSelection,
          onClick: () => apply("bold"),
          "aria-label": "Полужирный",
          title: "Полужирный (Ctrl+B)",
        },
        "B",
      ),
      e(
        "button",
        {
          type: "button",
          onMouseDown: keepSelection,
          onClick: () => apply("italic"),
          "aria-label": "Курсив",
          title: "Курсив (Ctrl+I)",
        },
        "I",
      ),
      e(
        "button",
        {
          type: "button",
          onMouseDown: keepSelection,
          onClick: () => apply("underline"),
          "aria-label": "Подчёркивание",
          title: "Подчёркивание (Ctrl+U)",
        },
        "U",
      ),
      e(
        "button",
        {
          type: "button",
          onMouseDown: keepSelection,
          onClick: () => apply("strikeThrough"),
          "aria-label": "Зачёркивание",
        },
        "S",
      ),
      formatMenuButton("block", "Абзац", "Стиль абзаца"),
      formatMenuButton("font", "Шрифт", "Шрифт"),
      formatMenuButton("size", "Размер", "Размер текста"),
      e(
        "button",
        {
          type: "button",
          onMouseDown: keepSelection,
          onClick: () => apply("insertUnorderedList"),
          "aria-label": "Маркированный список",
        },
        "• Список",
      ),
      e(
        "button",
        {
          type: "button",
          onMouseDown: keepSelection,
          onClick: () => apply("insertOrderedList"),
          "aria-label": "Нумерованный список",
        },
        "1. Список",
      ),
      e(
        "button",
        { type: "button", onMouseDown: keepSelection, onClick: addTable },
        "Таблица",
      ),
      e(
        "button",
        {
          type: "button",
          class: "editor-clear-format",
          onMouseDown: keepSelection,
          onClick: clearFormatting,
        },
        "Очистить формат",
      ),
    ),
    e(
      "div",
      {
        class:
          "editor-table-tools" +
          (editing && tableEditing ? " is-active" : ""),
        role: "toolbar",
        "aria-label": "Редактирование таблицы",
      },
      e("span", { class: "editor-table-tools-label" }, "Таблица"),
      e(
        "button",
        {
          type: "button",
          onMouseDown: keepSelection,
          onClick: () => addTableRow(true),
        },
        "↑ Строка",
      ),
      e(
        "button",
        {
          type: "button",
          onMouseDown: keepSelection,
          onClick: () => addTableRow(false),
        },
        "↓ Строка",
      ),
      e(
        "button",
        {
          type: "button",
          onMouseDown: keepSelection,
          onClick: () => addTableColumn(true),
        },
        "← Столбец",
      ),
      e(
        "button",
        {
          type: "button",
          onMouseDown: keepSelection,
          onClick: () => addTableColumn(false),
        },
        "Столбец →",
      ),
      e(
        "button",
        {
          type: "button",
          class: "danger",
          onMouseDown: keepSelection,
          onClick: removeTableRow,
        },
        "Удалить строку",
      ),
      e(
        "button",
        {
          type: "button",
          class: "danger",
          onMouseDown: keepSelection,
          onClick: removeTableColumn,
        },
        "Удалить столбец",
      ),
      e(
        "button",
        {
          type: "button",
          class: "danger",
          onMouseDown: keepSelection,
          onClick: removeTable,
        },
        "Удалить таблицу",
      ),
    ),
    e("div", {
      ref: editor,
      class: "rich-editor-area",
      contentEditable: true,
      role: "textbox",
      "aria-multiline": "true",
      "aria-label": comment ? "Текст комментария" : "Текст заметки",
      "data-placeholder": comment ? "Напишите комментарий…" : undefined,
      onFocus: () => setEditing(true),
      onInput: changed,
      onKeyUp: () => {
        remember();
        updateTableContext();
      },
      onMouseUp: () => {
        remember();
        updateTableContext();
      },
      onClick: (event: MouseEvent) => {
        const target = event.target as Element | null;
        if (target?.closest("a[data-attachment-id]")) event.preventDefault();
        updateTableContext();
      },
      onBlur: (event: FocusEvent) => {
        remember();
        const next = event.relatedTarget as Node | null;
        if (
          !formatMenu &&
          (!next || !toolbar.current?.contains(next))
        )
          setEditing(false);
      },
      onPaste: paste,
      onDrop: (event: DragEvent) => {
        event.preventDefault();
        onError(
          comment
            ? "Вставка файлов в комментарии не поддерживается."
            : "Добавляйте вложения кнопками под полем заметки.",
        );
      },
      onKeyDown: (ev: KeyboardEvent) => {
        if (ev.key === "Backspace" && removeEmptyTableRowAtCaret()) {
          ev.preventDefault();
        } else if (ev.key === "Backspace" && unwrapListItemAtCaret()) {
          ev.preventDefault();
        } else if (ev.key === "Tab" && moveThroughTable(ev.shiftKey)) {
          ev.preventDefault();
        } else if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && ev.key === "7") {
          ev.preventDefault();
          apply("insertOrderedList");
        } else if (
          (ev.ctrlKey || ev.metaKey) &&
          ev.shiftKey &&
          ev.key === "8"
        ) {
          ev.preventDefault();
          apply("insertUnorderedList");
        }
      },
    }),
    formatMenu &&
      formatMenuPosition &&
      createPortal(
        e(
          "div",
          {
            ref: formatMenuRoot,
            class: "editor-format-menu",
            role: "menu",
            "aria-label":
              formatMenu === "block"
                ? "Стиль абзаца"
                : formatMenu === "font"
                  ? "Шрифт"
                  : "Размер текста",
            style: formatMenuPosition,
            onBlur: (event: FocusEvent) => {
              const next = event.relatedTarget as Node | null;
              if (!next || !formatMenuRoot.current?.contains(next))
                setFormatMenu(null);
            },
            onKeyDown: (event: KeyboardEvent) => {
              const buttons = [
                  ...(event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>(
                    "button[role='menuitem']",
                  ),
                ],
                current = buttons.indexOf(
                  document.activeElement as HTMLButtonElement,
                );
              if (event.key === "Escape") {
                event.preventDefault();
                setFormatMenu(null);
                formatMenuTrigger.current?.focus({ preventScroll: true });
              } else if (
                event.key === "ArrowDown" ||
                event.key === "ArrowUp"
              ) {
                event.preventDefault();
                const offset = event.key === "ArrowDown" ? 1 : -1,
                  next =
                    (Math.max(0, current) + offset + buttons.length) %
                    buttons.length;
                buttons[next]?.focus({ preventScroll: true });
              } else if (event.key === "Home" || event.key === "End") {
                event.preventDefault();
                buttons[event.key === "Home" ? 0 : buttons.length - 1]?.focus({
                  preventScroll: true,
                });
              }
            },
          },
          editorFormatMenus[formatMenu].items.map((item) =>
            e(
              "button",
              {
                key: item.value,
                type: "button",
                role: "menuitem",
                onMouseDown: keepSelection,
                onClick: () => {
                  const menu = editorFormatMenus[formatMenu];
                  setFormatMenu(null);
                  apply(menu.command, item.value);
                },
              },
              item.label,
            ),
          ),
        ),
        document.body,
      ),
    !comment &&
      e(
        "p",
        { class: "hint" },
        "Поддерживаются стандартные сочетания Ctrl/⌘+B, I, U; списки — Ctrl/⌘+Shift+7 или 8.",
      ),
    !comment &&
      e(
        "div",
        { class: "editor-attachment-controls" },
        e(
          "button",
          {
            type: "button",
            class: "secondary-button",
            onClick: () => cover.current?.click(),
          },
          e(UiIcon, { name: "image", size: 18 }),
          "Добавить обложку",
        ),
        e(
          "button",
          {
            type: "button",
            class: "secondary-button",
            onClick: () => files.current?.click(),
          },
          e(UiIcon, { name: "paperclip", size: 18 }),
          "Добавить файлы",
        ),
      ),

    !comment &&
      e("input", {
        ref: cover,
        class: "file-picker",
        type: "file",
        accept: "image/*",
        onChange: (event: Event) => void addFiles(event, true),
      }),
    !comment &&
      e("input", {
        ref: files,
        class: "file-picker",
        type: "file",
        multiple: true,
        onChange: (event: Event) => void addFiles(event),
      }),
    !comment &&
      e(Attachments, {
        items: attachments,
        coverId,
        loadPreview,
        onDownload: onDownloadAttachment,
        onRename: onRenameAttachment,
        onSetCover,
        onInsertLink: insertAttachmentLink,
        onRemove:
          onRemoveAttachment ??
          ((item) =>
            onAttachmentsChange?.(
              attachments.filter((current) => current.id !== item.id),
            )),
      }),
  );
}
