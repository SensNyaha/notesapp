import { h as e } from "preact";
import { useEffect, useState } from "preact/hooks";

export function LoadingImage({
  src = "",
  load,
  cacheKey,
  alt,
  className = "",
  frameClassName = "",
  loading = "lazy",
  draggable,
  onLoad,
}: {
  src?: string;
  load?: () => Promise<Blob | null>;
  cacheKey?: string;
  alt: string;
  className?: string;
  frameClassName?: string;
  loading?: "eager" | "lazy";
  draggable?: boolean;
  onLoad?: (event: Event) => void;
}) {
  const [resolvedSrc, setResolvedSrc] = useState(src);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    let objectUrl = "";
    setResolvedSrc(src);
    setReady(false);
    setFailed(false);
    if (!src && load) {
      void load()
        .then((blob) => {
          if (!active || !blob) {
            if (active) setFailed(true);
            return;
          }
          objectUrl = URL.createObjectURL(blob);
          setResolvedSrc(objectUrl);
        })
        .catch(() => active && setFailed(true));
    } else if (!src) {
      setFailed(true);
    }
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src, cacheKey]);

  return e(
    "span",
    {
      class: `loading-image-frame ${frameClassName}${ready ? " is-ready" : " is-loading"}${failed ? " is-failed" : ""}`,
      "aria-busy": !ready && !failed ? "true" : undefined,
    },
    !ready && !failed && e("span", {
      class: "image-loading-skeleton",
      role: "status",
      "aria-label": "Изображение загружается",
    }, e("span", { class: "sync-spinner" })),
    failed && e("span", { class: "image-loading-failed", role: "status" }, "Изображение недоступно"),
    resolvedSrc && !failed && e("img", {
      src: resolvedSrc,
      alt,
      class: className,
      loading,
      draggable,
      onLoad: (event: Event) => {
        setReady(true);
        onLoad?.(event);
      },
      onError: () => setFailed(true),
    }),
  );
}
