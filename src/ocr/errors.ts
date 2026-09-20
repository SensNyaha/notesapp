export type OCRErrorCode =
  | "cancelled"
  | "invalid-image"
  | "image-processing-failed"
  | "model-not-installed"
  | "model-download-failed"
  | "model-integrity-failed"
  | "worker-failed"
  | "no-result"
  | "backend-failed"
  | "storage-failed"
  | "unknown";

export class OCRError extends Error {
  readonly code: OCRErrorCode;
  readonly userMessage: string;

  constructor(
    code: OCRErrorCode,
    userMessage: string,
    options?: { cause?: unknown },
  ) {
    super(userMessage, options);
    this.name = "OCRError";
    this.code = code;
    this.userMessage = userMessage;
  }
}

export function throwIfOCRAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new OCRError("cancelled", "Распознавание отменено.", {
      cause: signal.reason,
    });
  }
}

export function asOCRError(
  caught: unknown,
  code: OCRErrorCode = "unknown",
  message = "Не удалось распознать текст.",
) {
  if (caught instanceof OCRError) return caught;
  return new OCRError(code, caught instanceof Error ? caught.message : message, {
    cause: caught,
  });
}
