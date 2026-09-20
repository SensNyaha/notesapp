import { OCRError, throwIfOCRAborted } from "./errors.ts";
import type { OCRDeviceProfile } from "./deviceProfile.ts";

export interface OCRImageSize {
  width: number;
  height: number;
}

export interface OCRImagePreprocessingOptions {
  profile: OCRDeviceProfile;
  grayscale?: boolean;
  normalizeContrast?: boolean;
  signal?: AbortSignal;
}

export interface PreparedOCRImage {
  file: File;
  originalSize: OCRImageSize;
  size: OCRImageSize;
  resized: boolean;
  profile: OCRDeviceProfile["level"];
}

interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  release(): void;
}

type OCRCanvas = HTMLCanvasElement | OffscreenCanvas;
type OCRCanvasContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function fitOCRImageSize(
  width: number,
  height: number,
  maxSide: number,
  maxPixels: number,
): OCRImageSize {
  if (!Number.isFinite(width) || !Number.isFinite(height)
      || width <= 0 || height <= 0) {
    throw new OCRError("invalid-image", "Не удалось определить размер изображения.");
  }
  const sideScale = Math.min(1, maxSide / Math.max(width, height));
  const pixelScale = Math.min(1, Math.sqrt(maxPixels / (width * height)));
  const scale = Math.min(sideScale, pixelScale);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function normalizeOCRPixels(
  pixels: Uint8ClampedArray,
  grayscale: boolean,
  contrast: boolean,
) {
  if (!grayscale && !contrast) return pixels;
  const histogram = contrast ? new Uint32Array(256) : null;
  if (histogram) {
    for (let index = 0; index < pixels.length; index += 4) {
      const luminance = Math.round(
        pixels[index] * 0.299
        + pixels[index + 1] * 0.587
        + pixels[index + 2] * 0.114,
      );
      histogram[luminance] += 1;
    }
  }

  let low = 0;
  let high = 255;
  if (histogram) {
    const pixelCount = pixels.length / 4;
    const clip = Math.floor(pixelCount * 0.01);
    let seen = 0;
    while (low < 255 && seen + histogram[low] <= clip) {
      seen += histogram[low++];
    }
    seen = 0;
    while (high > 0 && seen + histogram[high] <= clip) {
      seen += histogram[high--];
    }
  }
  const range = Math.max(1, high - low);
  const adjust = (value: number) => contrast
    ? Math.max(0, Math.min(255, Math.round((value - low) * 255 / range)))
    : value;

  for (let index = 0; index < pixels.length; index += 4) {
    if (grayscale) {
      const luminance = adjust(Math.round(
        pixels[index] * 0.299
        + pixels[index + 1] * 0.587
        + pixels[index + 2] * 0.114,
      ));
      pixels[index] = luminance;
      pixels[index + 1] = luminance;
      pixels[index + 2] = luminance;
    } else {
      pixels[index] = adjust(pixels[index]);
      pixels[index + 1] = adjust(pixels[index + 1]);
      pixels[index + 2] = adjust(pixels[index + 2]);
    }
  }
  return pixels;
}

async function decodeWithImageBitmap(file: File): Promise<DecodedImage | null> {
  if (typeof createImageBitmap !== "function") return null;
  try {
    const bitmap = await createImageBitmap(file, {
      imageOrientation: "from-image",
    });
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      release: () => bitmap.close(),
    };
  } catch {
    return null;
  }
}

async function decodeWithImageElement(file: File): Promise<DecodedImage> {
  if (typeof document === "undefined" || typeof Image === "undefined") {
    throw new OCRError(
      "image-processing-failed",
      "Браузер не поддерживает декодирование выбранного изображения.",
    );
  }
  const url = URL.createObjectURL(file);
  const image = new Image();
  try {
    image.decoding = "async";
    image.src = url;
    await image.decode();
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      release: () => {
        image.src = "";
        URL.revokeObjectURL(url);
      },
    };
  } catch (caught) {
    image.src = "";
    URL.revokeObjectURL(url);
    throw new OCRError(
      "invalid-image",
      "Не удалось открыть выбранное изображение.",
      { cause: caught },
    );
  }
}

function createCanvas(width: number, height: number): OCRCanvas {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(width, height);
  }
  if (typeof document === "undefined") {
    throw new OCRError(
      "image-processing-failed",
      "Canvas недоступен для подготовки изображения.",
    );
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

async function canvasToBlob(canvas: OCRCanvas, type: string, quality: number) {
  if (typeof OffscreenCanvas !== "undefined" && canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type, quality });
  }
  const htmlCanvas = canvas as HTMLCanvasElement;
  return await new Promise<Blob>((resolve, reject) => {
    htmlCanvas.toBlob(
      (blob: Blob | null) => blob
        ? resolve(blob)
        : reject(new OCRError(
            "image-processing-failed",
            "Не удалось подготовить изображение для OCR.",
          )),
      type,
      quality,
    );
  });
}

export async function prepareOCRImage(
  file: File,
  options: OCRImagePreprocessingOptions,
): Promise<PreparedOCRImage> {
  throwIfOCRAborted(options.signal);
  const decoded = await decodeWithImageBitmap(file)
    ?? await decodeWithImageElement(file);
  let canvas: OCRCanvas | null = null;
  try {
    throwIfOCRAborted(options.signal);
    const size = fitOCRImageSize(
      decoded.width,
      decoded.height,
      options.profile.maxImageSide,
      options.profile.maxImagePixels,
    );
    canvas = createCanvas(size.width, size.height);
    const context = canvas.getContext("2d", {
      alpha: false,
      willReadFrequently: Boolean(
        options.grayscale || options.normalizeContrast,
      ),
    }) as OCRCanvasContext | null;
    if (!context) {
      throw new OCRError(
        "image-processing-failed",
        "Не удалось создать контекст подготовки изображения.",
      );
    }
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(decoded.source, 0, 0, size.width, size.height);

    if (options.grayscale || options.normalizeContrast) {
      const imageData = context.getImageData(0, 0, size.width, size.height);
      normalizeOCRPixels(
        imageData.data,
        Boolean(options.grayscale),
        Boolean(options.normalizeContrast),
      );
      context.putImageData(imageData, 0, 0);
    }
    throwIfOCRAborted(options.signal);

    const outputType = file.type === "image/png" ? "image/png" : "image/jpeg";
    const blob = await canvasToBlob(canvas, outputType, 0.9);
    throwIfOCRAborted(options.signal);
    return {
      file: new File([blob], file.name || "ocr-image", {
        type: outputType,
        lastModified: file.lastModified,
      }),
      originalSize: { width: decoded.width, height: decoded.height },
      size,
      resized: size.width !== decoded.width || size.height !== decoded.height,
      profile: options.profile.level,
    };
  } finally {
    decoded.release();
    if (canvas) {
      canvas.width = 1;
      canvas.height = 1;
    }
  }
}
