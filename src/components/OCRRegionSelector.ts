import { h as e } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type {
  OCRSelectionMask,
  OCRSelectionPoint,
  OCRSelectionStroke,
} from "../ocr/types.ts";
import { UiIcon } from "./ui.ts";

interface ImageSize {
  width: number;
  height: number;
}

interface Position {
  x: number;
  y: number;
}

type ViewerTool = "marker" | "pan";

function clamp(value: number, minimum = 0, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, value));
}

function strokePath(stroke: OCRSelectionStroke, size: ImageSize) {
  if (!stroke.points.length) return "";
  const commands = stroke.points.map((point, index) =>
    `${index ? "L" : "M"} ${point.x * size.width} ${point.y * size.height}`
  );
  if (stroke.points.length === 1)
    commands.push(`l ${Math.max(0.1, size.width / 10000)} 0`);
  return commands.join(" ");
}

export function OCRRegionSelector({
  file,
  value,
  onChange,
  onRecognize,
  canRecognize,
  disabled = false,
}: {
  file: File;
  value: OCRSelectionMask;
  onChange: (value: OCRSelectionMask) => void;
  onRecognize: () => void;
  canRecognize: boolean;
  disabled?: boolean;
}) {
  const [url, setUrl] = useState("");
  const [imageReady, setImageReady] = useState(false);
  const [size, setSize] = useState<ImageSize>({ width: 1, height: 1 });
  const [viewerOpen, setViewerOpen] = useState(true);
  const [tool, setTool] = useState<ViewerTool>("marker");
  const [widthPercent, setWidthPercent] = useState(6);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Position>({ x: 0, y: 0 });
  const [viewportSize, setViewportSize] = useState<ImageSize>({ width: 1, height: 1 });
  const svgRef = useRef<SVGSVGElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const activePointer = useRef<number | null>(null);
  const activeStrokeStart = useRef<number | null>(null);
  const touchPointers = useRef(new Map<number, Position>());
  const pinchGesture = useRef<{
    pointerIds: [number, number];
    distance: number;
    zoom: number;
    pan: Position;
    midpoint: Position;
  } | null>(null);
  const panGesture = useRef<{
    pointerId: number;
    clientX: number;
    clientY: number;
    origin: Position;
  } | null>(null);

  useEffect(() => {
    const next = URL.createObjectURL(file);
    setUrl(next);
    setImageReady(false);
    setSize({ width: 1, height: 1 });
    setViewerOpen(true);
    setZoom(1);
    setPan({ x: 0, y: 0 });
    return () => URL.revokeObjectURL(next);
  }, [file]);

  useEffect(() => {
    if (!viewerOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setViewerOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [viewerOpen]);

  useEffect(() => {
    if (!viewerOpen || !viewportRef.current) return;
    const viewport = viewportRef.current;
    const updateSize = () => {
      const bounds = viewport.getBoundingClientRect();
      setViewportSize({
        width: Math.max(1, bounds.width),
        height: Math.max(1, bounds.height),
      });
    };
    updateSize();
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(updateSize);
    observer?.observe(viewport);
    window.addEventListener("resize", updateSize);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updateSize);
    };
  }, [viewerOpen]);

  const fitScale = Math.min(
    viewportSize.width / size.width,
    viewportSize.height / size.height,
  );
  const fittedSize = {
    width: Math.max(1, size.width * fitScale),
    height: Math.max(1, size.height * fitScale),
  };
  const clampPan = (position: Position, nextZoom = zoom): Position => {
    const maximumX = Math.max(0, (fittedSize.width * nextZoom - viewportSize.width) / 2);
    const maximumY = Math.max(0, (fittedSize.height * nextZoom - viewportSize.height) / 2);
    return {
      x: clamp(position.x, -maximumX, maximumX),
      y: clamp(position.y, -maximumY, maximumY),
    };
  };
  const changeZoom = (value: number) => {
    const nextZoom = clamp(value, 1, 4);
    setZoom(nextZoom);
    setPan((current) => clampPan(current, nextZoom));
  };

  const pointFromEvent = (event: PointerEvent): OCRSelectionPoint | null => {
    const bounds = svgRef.current?.getBoundingClientRect();
    if (!bounds?.width || !bounds.height) return null;
    return {
      x: clamp((event.clientX - bounds.left) / bounds.width),
      y: clamp((event.clientY - bounds.top) / bounds.height),
    };
  };

  const startStroke = (event: PointerEvent) => {
    if (tool !== "marker" || disabled) return;
    const point = pointFromEvent(event);
    if (!point) return;
    event.preventDefault();
    activePointer.current = event.pointerId;
    activeStrokeStart.current = value.strokes.length;
    svgRef.current?.setPointerCapture(event.pointerId);
    onChange({ strokes: [...value.strokes, { points: [point], width: widthPercent / 100 }] });
  };

  const continueStroke = (event: PointerEvent) => {
    if (activePointer.current !== event.pointerId || disabled) return;
    const point = pointFromEvent(event);
    if (!point) return;
    event.preventDefault();
    const strokes = [...value.strokes];
    const current = strokes.at(-1);
    if (!current) return;
    const previous = current.points.at(-1);
    if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) < 0.001) return;
    strokes[strokes.length - 1] = { ...current, points: [...current.points, point] };
    onChange({ strokes });
  };

  const finishStroke = (event: PointerEvent) => {
    if (activePointer.current !== event.pointerId) return;
    activePointer.current = null;
    activeStrokeStart.current = null;
    if (svgRef.current?.hasPointerCapture(event.pointerId))
      svgRef.current.releasePointerCapture(event.pointerId);
  };

  const startPan = (event: PointerEvent) => {
    if (tool !== "pan" || zoom <= 1 || disabled) return;
    event.preventDefault();
    panGesture.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      origin: pan,
    };
    viewportRef.current?.setPointerCapture(event.pointerId);
  };
  const continuePan = (event: PointerEvent) => {
    const gesture = panGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    setPan(clampPan({
      x: gesture.origin.x + event.clientX - gesture.clientX,
      y: gesture.origin.y + event.clientY - gesture.clientY,
    }));
  };
  const finishPan = (event: PointerEvent) => {
    if (panGesture.current?.pointerId !== event.pointerId) return;
    panGesture.current = null;
    if (viewportRef.current?.hasPointerCapture(event.pointerId))
      viewportRef.current.releasePointerCapture(event.pointerId);
  };

  const touchDistance = (first: Position, second: Position) =>
    Math.hypot(second.x - first.x, second.y - first.y);
  const touchMidpoint = (first: Position, second: Position): Position => ({
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2,
  });
  const trackTouchStart = (event: PointerEvent) => {
    if (event.pointerType !== "touch" || disabled) return;
    touchPointers.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    if (touchPointers.current.size !== 2) return;
    const entries = [...touchPointers.current.entries()];
    const first = entries[0];
    const second = entries[1];
    const distance = touchDistance(first[1], second[1]);
    if (distance <= 0) return;

    const viewportBounds = viewportRef.current?.getBoundingClientRect();
    if (!viewportBounds) return;
    const midpoint = touchMidpoint(first[1], second[1]);
    pinchGesture.current = {
      pointerIds: [first[0], second[0]],
      distance,
      zoom,
      pan,
      midpoint: {
        x: midpoint.x - viewportBounds.left,
        y: midpoint.y - viewportBounds.top,
      },
    };
    panGesture.current = null;

    const strokeStart = activeStrokeStart.current;
    if (strokeStart !== null) {
      const pointerId = activePointer.current;
      if (pointerId !== null && svgRef.current?.hasPointerCapture(pointerId))
        svgRef.current.releasePointerCapture(pointerId);
      activePointer.current = null;
      activeStrokeStart.current = null;
      onChange({ strokes: value.strokes.slice(0, strokeStart) });
    }
    for (const [pointerId] of entries)
      viewportRef.current?.setPointerCapture(pointerId);
    event.preventDefault();
    event.stopPropagation();
  };
  const trackTouchMove = (event: PointerEvent) => {
    if (event.pointerType !== "touch" || !touchPointers.current.has(event.pointerId)) return;
    touchPointers.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    const gesture = pinchGesture.current;
    if (!gesture) return;
    const first = touchPointers.current.get(gesture.pointerIds[0]);
    const second = touchPointers.current.get(gesture.pointerIds[1]);
    const bounds = viewportRef.current?.getBoundingClientRect();
    if (!first || !second || !bounds) return;

    const nextZoom = clamp(
      gesture.zoom * touchDistance(first, second) / gesture.distance,
      1,
      4,
    );
    const midpoint = touchMidpoint(first, second);
    const localX = (gesture.midpoint.x - viewportSize.width / 2 - gesture.pan.x)
      / gesture.zoom;
    const localY = (gesture.midpoint.y - viewportSize.height / 2 - gesture.pan.y)
      / gesture.zoom;
    const nextPan = clampPan({
      x: midpoint.x - bounds.left - viewportSize.width / 2 - nextZoom * localX,
      y: midpoint.y - bounds.top - viewportSize.height / 2 - nextZoom * localY,
    }, nextZoom);
    setZoom(nextZoom);
    setPan(nextPan);
    event.preventDefault();
    event.stopPropagation();
  };
  const trackTouchEnd = (event: PointerEvent) => {
    if (event.pointerType !== "touch") return;
    const wasPinching = Boolean(pinchGesture.current);
    touchPointers.current.delete(event.pointerId);
    if (wasPinching) {
      pinchGesture.current = null;
      panGesture.current = null;
      activePointer.current = null;
      activeStrokeStart.current = null;
      event.preventDefault();
      event.stopPropagation();
    }
    if (viewportRef.current?.hasPointerCapture(event.pointerId))
      viewportRef.current.releasePointerCapture(event.pointerId);
  };

  const hasSelection = value.strokes.length > 0;
  const strokeWidth = (stroke: OCRSelectionStroke) =>
    Math.max(1, stroke.width * Math.min(size.width, size.height));
  const displayScale = fitScale * zoom;
  const transform = `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px)) scale(${displayScale})`;

  const previewImage = () => e("img", {
    src: url,
    alt: "Изображение для распознавания",
    class: imageReady ? "is-ready" : "is-loading",
    draggable: false,
    onLoad: (event: Event) => {
      const target = event.currentTarget as HTMLImageElement;
      setSize({ width: Math.max(1, target.naturalWidth), height: Math.max(1, target.naturalHeight) });
      setImageReady(true);
    },
  });
  const loadingIndicator = () => !imageReady && e("span", {
    class: "image-loading-skeleton ocr-image-loading",
    role: "status",
    "aria-label": "Изображение загружается",
  }, e("span", { class: "sync-spinner" }));

  return e(
    "section",
    { class: "ocr-region-selector" },
    e(
      "div",
      { class: "ocr-region-heading" },
      e("div", null,
        e("strong", null, "Области распознавания"),
        e("small", null, hasSelection
          ? `Выделено штрихов: ${value.strokes.length}`
          : "Без выделения будет распознано всё изображение")),
      e("button", {
        type: "button",
        class: "secondary-button compact",
        disabled,
        onClick: () => setViewerOpen(true),
      }, e(UiIcon, { name: "image", size: 16 }), hasSelection ? "Изменить выделение" : "Открыть и выделить"),
    ),
    e("button", {
      type: "button",
      class: "ocr-image-preview-button",
      disabled,
      onClick: () => setViewerOpen(true),
      "aria-label": "Открыть изображение для выделения областей",
    }, url && previewImage(), loadingIndicator(), e("span", { class: "ocr-open-image-label" }, "Открыть на весь экран")),
    viewerOpen && e("div", { class: "ocr-marker-backdrop", role: "presentation" },
      e("section", {
        class: "ocr-marker-dialog",
        role: "dialog",
        "aria-modal": "true",
        "aria-label": "Выделение областей изображения",
        "data-swipe-lock": "true",
      },
      e("header", { class: "ocr-marker-dialog-header" },
        e("div", null,
          e("strong", { title: file.name }, file.name),
          e("small", null, hasSelection ? `Областей: ${value.strokes.length}` : "Выделите нужные строки или сегменты")),
        e("button", {
          ref: closeButtonRef,
          type: "button",
          class: "ocr-marker-close",
          onClick: () => setViewerOpen(false),
          "aria-label": "Закрыть просмотр изображения",
          title: "Закрыть",
        }, "×")),
      e("div", { class: "ocr-marker-toolbar" },
        e("div", { class: "ocr-marker-tool-switch", role: "group", "aria-label": "Инструмент" },
          e("button", {
            type: "button",
            class: tool === "marker" ? "primary compact" : "secondary-button compact",
            onClick: () => setTool("marker"),
            "aria-pressed": tool === "marker",
            "aria-label": "Маркер",
            title: "Маркер",
          }, e(UiIcon, { name: "marker", size: 18 }), e("span", { class: "ocr-marker-tool-label" }, "Маркер")),
          e("button", {
            type: "button",
            class: tool === "pan" ? "primary compact" : "secondary-button compact",
            onClick: () => setTool("pan"),
            "aria-pressed": tool === "pan",
            "aria-label": "Перемещение",
            title: "Перемещение",
          }, e(UiIcon, { name: "move", size: 20 }), e("span", { class: "ocr-marker-tool-label" }, "Перемещение"))),
        e("label", { class: "ocr-marker-width" },
          e("span", null, "Ширина"),
          e("input", {
            type: "range",
            min: 1,
            max: 20,
            step: 1,
            value: widthPercent,
            disabled: tool !== "marker",
            onInput: (event: Event) => setWidthPercent(Number((event.target as HTMLInputElement).value)),
          }),
          e("output", null, `${widthPercent}%`)),
        e("div", { class: "ocr-marker-zoom", role: "group", "aria-label": "Масштаб изображения" },
          e("button", {
            type: "button",
            disabled: zoom <= 1,
            onClick: () => changeZoom(zoom - 0.25),
            "aria-label": "Уменьшить масштаб",
            title: "Уменьшить",
          }, "−"),
          e("output", null, `${Math.round(zoom * 100)}%`),
          e("button", {
            type: "button",
            disabled: zoom >= 4,
            onClick: () => changeZoom(zoom + 0.25),
            "aria-label": "Увеличить масштаб",
            title: "Увеличить",
          }, "+"))),
      e("div", {
        ref: viewportRef,
        class: `ocr-marker-viewport is-${tool}`,
        onPointerDown: startPan,
        onPointerMove: continuePan,
        onPointerUp: finishPan,
        onPointerCancel: finishPan,
        onPointerDownCapture: trackTouchStart,
        onPointerMoveCapture: trackTouchMove,
        onPointerUpCapture: trackTouchEnd,
        onPointerCancelCapture: trackTouchEnd,
        onWheel: (event: WheelEvent) => {
          event.preventDefault();
          changeZoom(zoom + (event.deltaY < 0 ? 0.25 : -0.25));
        },
      },
        loadingIndicator(),
        e("div", {
          class: "ocr-marker-media",
          style: {
            width: `${size.width}px`,
            height: `${size.height}px`,
            transform,
          },
        },
          url && previewImage(),
          e("svg", {
            ref: svgRef,
            viewBox: `0 0 ${size.width} ${size.height}`,
            preserveAspectRatio: "none",
            role: "img",
            "aria-label": "Поле выделения областей изображения",
            onPointerDown: startStroke,
            onPointerMove: continueStroke,
            onPointerUp: finishStroke,
            onPointerCancel: finishStroke,
          }, value.strokes.map((stroke, index) => e("path", {
            key: index,
            d: strokePath(stroke, size),
            class: "ocr-marker-stroke",
            "stroke-width": strokeWidth(stroke),
          })))),
        e("span", { class: "ocr-marker-hint" }, tool === "marker"
          ? "Одним пальцем выделяйте текст, двумя — меняйте масштаб"
          : zoom > 1
            ? "Перетаскивайте изображение или масштабируйте двумя пальцами"
            : "Увеличьте кнопкой + или разведите два пальца")),
      e("footer", { class: "ocr-marker-footer" },
        e("div", { class: "ocr-marker-actions" },
          e("button", {
            type: "button",
            class: "tertiary-button",
            disabled: !hasSelection,
            onClick: () => onChange({ strokes: value.strokes.slice(0, -1) }),
          }, "Отменить штрих"),
          e("button", {
            type: "button",
            class: "tertiary-button",
            disabled: !hasSelection,
            onClick: () => onChange({ strokes: [] }),
          }, "Очистить")),
        e("button", {
          type: "button",
          class: "primary",
          disabled: !canRecognize || disabled,
          onClick: () => {
            setViewerOpen(false);
            onRecognize();
          },
        }, hasSelection ? "Распознать выделенное" : "Распознать всё")))));
}
