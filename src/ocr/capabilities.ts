export interface OCRCapabilities {
  camera: boolean;
  filePicker: boolean;
  webgpu: boolean;
  worker: boolean;
  offscreenCanvas: boolean;
  createImageBitmap: boolean;
  wasm: boolean;
  standalone: boolean;
  touch: boolean;
}

export function detectOCRCapabilities(): OCRCapabilities {
  const nav = navigator as Navigator & {
    gpu?: unknown;
    standalone?: boolean;
  };
  let standalone = Boolean(nav.standalone);
  try {
    standalone =
      standalone || matchMedia("(display-mode: standalone)").matches;
  } catch {
    // matchMedia is not required for OCR itself.
  }
  let touch = nav.maxTouchPoints > 0;
  try {
    touch = touch || matchMedia("(pointer: coarse)").matches;
  } catch {
    // Pointer media query is only a UI hint.
  }

  return {
    camera: Boolean(nav.mediaDevices?.getUserMedia),
    filePicker: typeof File !== "undefined",
    webgpu: Boolean(nav.gpu),
    worker: typeof Worker !== "undefined",
    offscreenCanvas: typeof OffscreenCanvas !== "undefined",
    createImageBitmap: typeof createImageBitmap === "function",
    wasm: typeof WebAssembly !== "undefined",
    standalone,
    touch,
  };
}
