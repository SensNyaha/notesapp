export type OCRMode = "auto" | "printed" | "handwriting";
export type OCRLanguage = "ru" | "en" | "ru+en";
export type OCREngine = "paddle" | "trocr";
export type OCRProgressPhase =
  | "preparing"
  | "loading-models"
  | "detecting"
  | "recognizing"
  | "handwriting"
  | "done";

export interface OCRPoint {
  x: number;
  y: number;
}

export interface OCRLine {
  text: string;
  score?: number;
  poly?: OCRPoint[];
  engine: OCREngine;
  language?: "ru" | "en";
}
export interface OCRResult {
  text: string;
  lines: OCRLine[];
  modeUsed: "printed" | "handwriting" | "mixed";
  languages: Array<"ru" | "en">;
  backend: string;
  confidence?: number;
  durationMs: number;
}

export interface OCRRecognizeOptions {
  mode: OCRMode;
  languages: OCRLanguage;
  preprocessing?: {
    grayscale?: boolean;
    normalizeContrast?: boolean;
  };
}

export interface OCRProgress {
  phase: OCRProgressPhase;
  message: string;
  current?: number;
  total?: number;
}

export interface OCRImagePayload {
  buffer: ArrayBuffer;
  mime: string;
  name: string;
}
export type OCRWorkerRequest =
  | {
      type: "recognize";
      id: string;
      image: OCRImagePayload;
      options: OCRRecognizeOptions;
    }
  | { type: "dispose" };

export type OCRWorkerResponse =
  | {
      type: "progress";
      id: string;
      progress: OCRProgress;
    }
  | {
      type: "result";
      id: string;
      result: OCRResult;
    }
  | {
      type: "error";
      id: string;
      message: string;
    };
