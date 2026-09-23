import { h as e } from "preact";
import { createPortal } from "preact/compat";
import { useEffect, useRef, useState } from "preact/hooks";
import type { TagDefinition } from "../planner.ts";
import { UiIcon } from "./ui.ts";

type TagPanelPosition = {
  left: number;
  top?: number;
  bottom?: number;
  width: number;
  maxHeight: number;
};

export function TagPicker({
  tags,
  selectedIds,
  onChange,
  onManage,
  mode = "popover",
  placement = "below",
  label = "По тегам",
  showIcon = false,
  heading,
  layout = "default",
  untagged,
}: {
  tags: TagDefinition[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  onManage: () => void;
  mode?: "inline" | "popover";
  placement?: "above" | "below";
  label?: string;
  showIcon?: boolean;
  heading?: string;
  layout?: "default" | "editor";
  untagged?: { selected: boolean; onChange: (selected: boolean) => void };
}) {
  const picker = useRef<HTMLDetailsElement>(null),
    trigger = useRef<HTMLElement>(null),
    panel = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState(""),
    [open, setOpen] = useState(false),
    [position, setPosition] = useState<TagPanelPosition | null>(null);
  const normalized = query.trim().toLocaleLowerCase("ru"),
    visible = tags.filter((tag) =>
      tag.name.toLocaleLowerCase("ru").includes(normalized),
    ),
    selected = selectedIds
      .map((id) => tags.find((tag) => tag.id === id))
      .filter((tag): tag is TagDefinition => Boolean(tag)),
    selectedCount = selected.length + (untagged?.selected ? 1 : 0);
  const toggle = (id: string, checked: boolean) =>
    onChange(
      checked
        ? [...selectedIds, id]
        : selectedIds.filter((current) => current !== id),
    );
  const close = () => {
    setOpen(false);
    setQuery("");
  };
  const openPanel = () => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const viewportWidth = window.visualViewport?.width ?? window.innerWidth,
      viewportHeight = window.visualViewport?.height ?? window.innerHeight,
      left = Math.max(0, rect.left),
      width = Math.max(1, Math.min(320, viewportWidth - left - 8)),
      gap = 6;
    setPosition(
      placement === "above"
        ? {
            left,
            bottom: viewportHeight - rect.top + gap,
            width,
            maxHeight: Math.max(1, rect.top - gap - 8),
          }
        : {
            left,
            top: rect.bottom + gap,
            width,
            maxHeight: Math.max(1, viewportHeight - rect.bottom - gap - 8),
          },
    );
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: Event) => {
        const target = event.target as Node | null;
        if (
          target &&
          (picker.current?.contains(target) || panel.current?.contains(target))
        )
          return;
        close();
      },
      repositionOnViewportChange = () => openPanel(),
      closeOnEscape = (event: KeyboardEvent) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        close();
        trigger.current?.focus({ preventScroll: true });
      };
    document.addEventListener("pointerdown", closeOutside, true);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", repositionOnViewportChange);
    window.visualViewport?.addEventListener(
      "resize",
      repositionOnViewportChange,
    );
    return () => {
      document.removeEventListener("pointerdown", closeOutside, true);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", repositionOnViewportChange);
      window.visualViewport?.removeEventListener(
        "resize",
        repositionOnViewportChange,
      );
    };
  }, [open]);

  const tagPanel =
    open &&
    position &&
    createPortal(
      e(
        "div",
        {
          ref: panel,
          class: "unified-tag-panel unified-tag-floating-panel",
          style: position,
          role: "dialog",
          "aria-label": "Выбор тегов",
        },
        e(
          "label",
          { class: "unified-tag-search" },
          e("span", { class: "sr-only" }, "Найти тег"),
          e(
            "span",
            { class: "search-input-wrap" },
            e(UiIcon, { name: "search", size: 16 }),
            e("input", {
              type: "search",
              value: query,
              placeholder: "Найти тег",
              onInput: (event: Event) =>
                setQuery((event.target as HTMLInputElement).value),
            }),
          ),
        ),
        e(
          "div",
          { class: "unified-tag-options" },
          untagged &&
            e(
              "label",
              { class: "unified-tag-option unified-untagged-option" },
              e("input", {
                type: "checkbox",
                checked: untagged.selected,
                onChange: (event: Event) =>
                  untagged.onChange(
                    (event.target as HTMLInputElement).checked,
                  ),
              }),
              e("span", null, "Без тегов"),
            ),
          visible.map((tag) =>
            e(
              "label",
              { class: "unified-tag-option", key: tag.id },
              e("input", {
                type: "checkbox",
                checked: selectedIds.includes(tag.id),
                onChange: (event: Event) =>
                  toggle(tag.id, (event.target as HTMLInputElement).checked),
              }),
              e(
                "span",
                { class: "tag-chip", style: { "--tag-color": tag.color } },
                tag.name,
              ),
            ),
          ),
          !visible.length &&
            e("p", { class: "empty-mini" }, "Подходящих тегов нет."),
        ),
        e(
          "button",
          {
            type: "button",
            class: "tertiary-button unified-manage-tags",
            onClick: () => {
              close();
              onManage();
            },
          },
          e(UiIcon, { name: "settings", size: 17 }),
          "Редактировать список",
        ),
      ),
      document.body,
    );

  return e(
    "div",
    {
      class:
        "unified-tag-control " +
        mode +
        (layout === "editor" ? " note-edit-tags" : ""),
    },
    heading && e("h2", null, heading),
    e(
      "details",
      {
        ref: picker,
        open,
        class: `unified-tag-picker ${mode} ${placement}`,
      },
      e(
        "summary",
        {
          ref: trigger,
          class:
            layout === "editor"
              ? "secondary-button"
              : "filter-chip unified-tag-trigger" +
                (selectedCount ? " selected" : ""),
          onClick: (event: MouseEvent) => {
            event.preventDefault();
            if (open) close();
            else openPanel();
          },
          "aria-haspopup": "dialog",
          "aria-expanded": open,
        },
        showIcon && e(UiIcon, { name: "tag", size: 17 }),
        e("span", null, label),
        selectedCount > 0 &&
          e("span", { class: "filter-count" }, String(selectedCount)),
      ),
    ),
    tagPanel,
    selected.length > 0 &&
      e(
        "div",
        { class: "unified-selected-tags", "aria-label": "Выбранные теги" },
        selected.map((tag) =>
          e(
            "button",
            {
              type: "button",
              class: "tag-chip selected",
              style: { "--tag-color": tag.color },
              key: tag.id,
              onClick: () => toggle(tag.id, false),
              "aria-label": "Убрать тег " + tag.name,
              title: "Убрать тег",
            },
            tag.name,
          ),
        ),
      ),
  );
}
