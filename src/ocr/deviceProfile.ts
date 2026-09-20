export type OCRDeviceProfileLevel = "low" | "medium" | "high";

export interface OCRDeviceProfile {
  level: OCRDeviceProfileLevel;
  maxImageSide: number;
  maxImagePixels: number;
  htrConcurrency: 1;
  preferredBackend: "webgpu" | "wasm";
}

export interface OCRDeviceSignals {
  deviceMemory?: number;
  hardwareConcurrency?: number;
  webgpu: boolean;
  offscreenCanvas: boolean;
  createImageBitmap: boolean;
  mobile: boolean;
}

export function resolveOCRDeviceProfile(
  signals: OCRDeviceSignals,
): OCRDeviceProfile {
  const lowMemory = signals.deviceMemory !== undefined
    && signals.deviceMemory <= 2;
  const lowCpu = signals.hardwareConcurrency !== undefined
    && signals.hardwareConcurrency <= 2;
  const highMemory = (signals.deviceMemory ?? 0) >= 8;
  const highCpu = (signals.hardwareConcurrency ?? 0) >= 8;
  const fullyAccelerated = signals.offscreenCanvas
    && signals.createImageBitmap
    && signals.webgpu;

  const level: OCRDeviceProfileLevel = lowMemory || lowCpu
    ? "low"
    : !signals.mobile && highMemory && highCpu && fullyAccelerated
      ? "high"
      : "medium";

  if (level === "low") {
    return {
      level,
      maxImageSide: 1280,
      maxImagePixels: 1_500_000,
      htrConcurrency: 1,
      preferredBackend: "wasm",
    };
  }
  if (level === "high") {
    return {
      level,
      maxImageSide: 2048,
      maxImagePixels: 4_000_000,
      htrConcurrency: 1,
      preferredBackend: "webgpu",
    };
  }
  return {
    level,
    maxImageSide: 1800,
    maxImagePixels: 2_800_000,
    htrConcurrency: 1,
    preferredBackend: signals.webgpu ? "webgpu" : "wasm",
  };
}

export function detectOCRDeviceProfile(): OCRDeviceProfile {
  const nav = navigator as Navigator & {
    deviceMemory?: number;
    gpu?: unknown;
  };
  const userAgent = nav.userAgent || "";
  return resolveOCRDeviceProfile({
    deviceMemory: nav.deviceMemory,
    hardwareConcurrency: nav.hardwareConcurrency,
    webgpu: Boolean(nav.gpu),
    offscreenCanvas: typeof OffscreenCanvas !== "undefined",
    createImageBitmap: typeof createImageBitmap === "function",
    mobile: /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent),
  });
}
