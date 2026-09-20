export type OCRModelPackageId =
  | "printed-ru-en-v1"
  | "handwriting-ru-v1"
  | "handwriting-en-v1";

interface OCRModelAsset {
  url: string;
  bytes: number;
}

interface OCRModelPackage {
  kind: "printed" | "handwriting";
  language?: "ru" | "en";
  required: boolean;
  bytes: number;
  assets: OCRModelAsset[];
}

interface OCRModelManifest {
  version: number;
  packages: Record<OCRModelPackageId, OCRModelPackage>;
}

export interface OCRModelProgress {
  packageId: OCRModelPackageId;
  loaded: number;
  total: number;
  currentAsset?: string;
}

export interface OCRModelState {
  id: OCRModelPackageId;
  installed: boolean;
  bytes: number;
  cachedBytes: number;
}

const MODEL_CACHE = "tasks-ocr-models-v1";
let manifestPromise: Promise<OCRModelManifest> | null = null;

async function getManifest() {
  if (!manifestPromise) {
    manifestPromise = fetch("/ocr-models/manifest.json", {
      credentials: "same-origin",
      cache: "no-store",
    }).then(async (response) => {
      if (!response.ok)
        throw new Error("Не удалось прочитать локальный manifest OCR-моделей.");
      return await response.json() as OCRModelManifest;
    });
    manifestPromise.catch(() => {
      manifestPromise = null;
    });
  }
  return manifestPromise;
}

async function cachedAsset(cache: Cache, asset: OCRModelAsset) {
  const response = await cache.match(asset.url);
  if (!response) return false;
  const length = Number(response.headers.get("content-length"));
  return !Number.isFinite(length) || length === 0 || length === asset.bytes;
}

export class OCRModelManager {
  async state(id: OCRModelPackageId): Promise<OCRModelState> {
    const manifest = await getManifest();
    const modelPackage = manifest.packages[id];
    if (!modelPackage) throw new Error(`Неизвестный OCR package: ${id}`);

    const cache = await caches.open(MODEL_CACHE);
    let cachedBytes = 0;
    for (const asset of modelPackage.assets) {
      if (await cachedAsset(cache, asset)) cachedBytes += asset.bytes;
    }

    return {
      id,
      installed: cachedBytes === modelPackage.bytes,
      bytes: modelPackage.bytes,
      cachedBytes,
    };
  }

  async states(): Promise<OCRModelState[]> {
    return await Promise.all(
      ([
        "printed-ru-en-v1",
        "handwriting-ru-v1",
        "handwriting-en-v1",
      ] as OCRModelPackageId[]).map((id) => this.state(id)),
    );
  }

  async install(
    id: OCRModelPackageId,
    onProgress?: (progress: OCRModelProgress) => void,
  ) {
    const manifest = await getManifest();
    const modelPackage = manifest.packages[id];
    if (!modelPackage) throw new Error(`Неизвестный OCR package: ${id}`);

    const cache = await caches.open(MODEL_CACHE);
    let loaded = 0;

    for (const asset of modelPackage.assets) {
      if (await cachedAsset(cache, asset)) {
        loaded += asset.bytes;
        onProgress?.({
          packageId: id,
          loaded,
          total: modelPackage.bytes,
          currentAsset: asset.url,
        });
        continue;
      }

      const response = await fetch(asset.url, {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok || !response.body)
        throw new Error(`Не удалось загрузить локальную OCR-модель: ${asset.url}`);

      let assetLoaded = 0;
      const counter = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          assetLoaded += chunk.byteLength;
          onProgress?.({
            packageId: id,
            loaded: loaded + Math.min(assetLoaded, asset.bytes),
            total: modelPackage.bytes,
            currentAsset: asset.url,
          });
          controller.enqueue(chunk);
        },
      });

      const headers = new Headers(response.headers);
      headers.set("content-length", String(asset.bytes));
      const cachedResponse = new Response(response.body.pipeThrough(counter), {
        status: 200,
        statusText: "OK",
        headers,
      });

      await cache.put(asset.url, cachedResponse);
      if (assetLoaded !== asset.bytes) {
        await cache.delete(asset.url);
        throw new Error(
          `OCR-модель загружена не полностью: ${asset.url} (${assetLoaded}/${asset.bytes})`,
        );
      }

      loaded += asset.bytes;
    }

    const finalState = await this.state(id);
    if (!finalState.installed)
      throw new Error("OCR package не прошёл проверку после установки.");

    return finalState;
  }

  async remove(id: OCRModelPackageId) {
    const manifest = await getManifest();
    const modelPackage = manifest.packages[id];
    if (!modelPackage) return;
    const cache = await caches.open(MODEL_CACHE);
    await Promise.all(modelPackage.assets.map((asset) => cache.delete(asset.url)));
  }

  async isPrintedInstalled() {
    return (await this.state("printed-ru-en-v1")).installed;
  }

  async isHandwritingInstalled(language: "ru" | "en") {
    const id: OCRModelPackageId =
      language === "ru" ? "handwriting-ru-v1" : "handwriting-en-v1";
    return (await this.state(id)).installed;
  }
}

export function formatModelBytes(bytes: number) {
  const mib = bytes / (1024 * 1024);
  return mib >= 100 ? `${mib.toFixed(0)} МБ` : `${mib.toFixed(1)} МБ`;
}
