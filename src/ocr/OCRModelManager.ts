import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { OCRError, throwIfOCRAborted } from "./errors.ts";

export type OCRModelPackageId =
  | "printed-ru-en-v1"
  | "handwriting-ru-v1"
  | "handwriting-en-v1";

export interface OCRModelAsset {
  url: string;
  bytes: number;
  sha256: string;
}

export interface OCRModelPackage {
  kind: "printed" | "handwriting";
  language?: "ru" | "en";
  required: boolean;
  version: string;
  integrity: string;
  bytes: number;
  assets: OCRModelAsset[];
}

export interface OCRModelManifest {
  version: number;
  runtimeComplete: boolean;
  packages: Record<OCRModelPackageId, OCRModelPackage>;
}

interface OCRPackageMarker {
  id: OCRModelPackageId;
  version: string;
  integrity: string;
  installedAt: string;
  assets: string[];
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
  version: string;
  installedVersion?: string;
  updateAvailable: boolean;
  bytes: number;
  cachedBytes: number;
}

const MODEL_CACHE = "tasks-ocr-models-v1";
const STAGING_PREFIX = "tasks-ocr-models-stage-v1-";
const MANIFEST_URL = "/ocr-models/manifest.json";
const PACKAGE_IDS: OCRModelPackageId[] = [
  "printed-ru-en-v1",
  "handwriting-ru-v1",
  "handwriting-en-v1",
];
const HASH_PATTERN = /^[a-f0-9]{64}$/;
let manifestPromise: Promise<OCRModelManifest> | null = null;

function packageMarkerUrl(id: OCRModelPackageId) {
  return `/__tasks_ocr_package__/${id}`;
}

function packageIntegrity(assets: OCRModelAsset[]) {
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(assets))));
}

export function validateOCRModelManifest(value: unknown): OCRModelManifest {
  if (!value || typeof value !== "object")
    throw new OCRError("model-integrity-failed", "Некорректный manifest OCR-моделей.");
  const manifest = value as Partial<OCRModelManifest>;
  if (manifest.version !== 3 || !manifest.runtimeComplete || !manifest.packages)
    throw new OCRError(
      "model-integrity-failed",
      "OCR runtime manifest неполный или имеет неподдерживаемую версию.",
    );

  for (const id of PACKAGE_IDS) {
    const modelPackage = manifest.packages[id];
    if (!modelPackage || !modelPackage.version
        || !HASH_PATTERN.test(modelPackage.integrity)
        || !Array.isArray(modelPackage.assets)
        || modelPackage.assets.length === 0) {
      throw new OCRError("model-integrity-failed", `Некорректный OCR package: ${id}`);
    }
    const urls = new Set<string>();
    let bytes = 0;
    for (const asset of modelPackage.assets) {
      if (!asset || typeof asset.url !== "string"
          || !asset.url.startsWith("/") || asset.url.startsWith("//")
          || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0
          || !HASH_PATTERN.test(asset.sha256) || urls.has(asset.url)) {
        throw new OCRError(
          "model-integrity-failed",
          `Некорректный файл в OCR package: ${id}`,
        );
      }
      urls.add(asset.url);
      bytes += asset.bytes;
    }
    if (bytes !== modelPackage.bytes
        || packageIntegrity(modelPackage.assets) !== modelPackage.integrity) {
      throw new OCRError(
        "model-integrity-failed",
        `Контрольная сумма OCR package не совпадает: ${id}`,
      );
    }
  }
  return manifest as OCRModelManifest;
}

async function readManifestResponse(response: Response) {
  return validateOCRModelManifest(await response.json());
}

async function getManifest(forceRefresh = false) {
  if (forceRefresh) manifestPromise = null;
  if (!manifestPromise) {
    manifestPromise = (async () => {
      const cache = await caches.open(MODEL_CACHE);
      try {
        const response = await fetch(MANIFEST_URL, {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!response.ok)
          throw new OCRError(
            "model-download-failed",
            "Не удалось прочитать локальный manifest OCR-моделей.",
          );
        const cachedResponse = response.clone();
        const manifest = await readManifestResponse(response);
        await cache.put(MANIFEST_URL, cachedResponse);
        return manifest;
      } catch (error) {
        const cached = await cache.match(MANIFEST_URL);
        if (cached) return await readManifestResponse(cached);
        throw error;
      }
    })();
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
  return length === asset.bytes
    && response.headers.get("x-ocr-sha256") === asset.sha256;
}

async function readMarker(cache: Cache, id: OCRModelPackageId) {
  const response = await cache.match(packageMarkerUrl(id));
  if (!response) return null;
  try {
    const value = await response.json() as Partial<OCRPackageMarker>;
    if (value.id !== id || typeof value.version !== "string"
        || typeof value.integrity !== "string") return null;
    return {
      id,
      version: value.version,
      integrity: value.integrity,
      installedAt: typeof value.installedAt === "string" ? value.installedAt : "",
      assets: Array.isArray(value.assets)
        ? value.assets.filter((url): url is string => typeof url === "string")
        : [],
    };
  } catch {
    return null;
  }
}

function markerMatches(
  marker: OCRPackageMarker | null,
  id: OCRModelPackageId,
  modelPackage: OCRModelPackage,
) {
  return marker?.id === id
    && marker.version === modelPackage.version
    && marker.integrity === modelPackage.integrity;
}

export function hasEnoughOCRStorage(
  requiredBytes: number,
  estimate: { quota?: number; usage?: number },
) {
  if (!requiredBytes || estimate.quota === undefined
      || estimate.usage === undefined) return true;
  const available = Math.max(0, estimate.quota - estimate.usage);
  const reserve = Math.max(16 * 1024 * 1024, Math.ceil(requiredBytes * 0.1));
  return available >= requiredBytes + reserve;
}

async function ensureStorageCapacity(requiredBytes: number) {
  const storage = navigator.storage;
  if (!storage?.estimate || !requiredBytes) return;
  const estimate = await storage.estimate();
  if (!hasEnoughOCRStorage(requiredBytes, estimate)) {
    throw new OCRError(
      "storage-failed",
      "Недостаточно свободного места для установки OCR-модели.",
    );
  }
  try {
    await storage.persist?.();
  } catch {
    // Persistent storage is an optimization and is unavailable on some Safari versions.
  }
}

function downloadUrl(asset: OCRModelAsset, modelPackage: OCRModelPackage) {
  const url = new URL(asset.url, location.origin);
  url.searchParams.set("ocr-download", modelPackage.integrity.slice(0, 16));
  return url.toString();
}

async function downloadAsset(
  cache: Cache,
  id: OCRModelPackageId,
  modelPackage: OCRModelPackage,
  asset: OCRModelAsset,
  loaded: number,
  onProgress?: (progress: OCRModelProgress) => void,
  signal?: AbortSignal,
  source?: Response,
) {
  throwIfOCRAborted(signal);
  const response = source ?? await fetch(downloadUrl(asset, modelPackage), {
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
  if (!response.ok || !response.body) {
    throw new OCRError(
      "model-download-failed",
      `Не удалось загрузить локальную OCR-модель: ${asset.url}`,
    );
  }

  const hasher = sha256.create();
  let assetLoaded = 0;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      assetLoaded += chunk.byteLength;
      hasher.update(chunk);
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
  headers.set("x-ocr-sha256", asset.sha256);
  headers.set("x-ocr-package-version", modelPackage.version);
  await cache.put(asset.url, new Response(response.body.pipeThrough(counter), {
    status: 200,
    statusText: "OK",
    headers,
  }));
  throwIfOCRAborted(signal);
  const digest = bytesToHex(hasher.digest());
  if (assetLoaded !== asset.bytes || digest !== asset.sha256) {
    await cache.delete(asset.url);
    throw new OCRError(
      "model-integrity-failed",
      `OCR-модель не прошла проверку целостности: ${asset.url}`,
    );
  }
}

export class OCRModelManager {
  private async stateFromManifest(
    id: OCRModelPackageId,
    manifest: OCRModelManifest,
  ): Promise<OCRModelState> {
    const modelPackage = manifest.packages[id];
    if (!modelPackage) throw new Error(`Неизвестный OCR package: ${id}`);
    const cache = await caches.open(MODEL_CACHE);
    const marker = await readMarker(cache, id);
    let cachedBytes = 0;
    for (const asset of modelPackage.assets) {
      if (await cachedAsset(cache, asset)) cachedBytes += asset.bytes;
    }
    const installed = cachedBytes === modelPackage.bytes
      && markerMatches(marker, id, modelPackage);
    return {
      id,
      installed,
      version: modelPackage.version,
      installedVersion: marker?.version,
      updateAvailable: Boolean(marker) && !markerMatches(marker, id, modelPackage),
      bytes: modelPackage.bytes,
      cachedBytes,
    };
  }

  async state(id: OCRModelPackageId): Promise<OCRModelState> {
    return this.stateFromManifest(id, await getManifest());
  }

  async states(forceRefresh = false): Promise<OCRModelState[]> {
    const manifest = await getManifest(forceRefresh);
    return await Promise.all(PACKAGE_IDS.map(
      (id) => this.stateFromManifest(id, manifest),
    ));
  }

  async install(
    id: OCRModelPackageId,
    onProgress?: (progress: OCRModelProgress) => void,
    signal?: AbortSignal,
  ) {
    const manifest = await getManifest();
    const modelPackage = manifest.packages[id];
    if (!modelPackage) throw new Error(`Неизвестный OCR package: ${id}`);
    throwIfOCRAborted(signal);

    const live = await caches.open(MODEL_CACHE);
    const missing: OCRModelAsset[] = [];
    const locallyCached = new Set<string>();
    let requiredStorage = 0;
    let loaded = 0;
    for (const asset of modelPackage.assets) {
      if (await cachedAsset(live, asset)) loaded += asset.bytes;
      else {
        missing.push(asset);
        if (await live.match(asset.url)) locallyCached.add(asset.url);
        requiredStorage += asset.bytes * (locallyCached.has(asset.url) ? 1 : 2);
      }
    }
    await ensureStorageCapacity(requiredStorage);

    const stagingName = `${STAGING_PREFIX}${id}-${modelPackage.integrity.slice(0, 16)}`;
    await caches.delete(stagingName);
    const staging = await caches.open(stagingName);
    try {
      for (const asset of missing) {
        const existing = await live.match(asset.url);
        if (existing) {
          try {
            await downloadAsset(
              staging,
              id,
              modelPackage,
              asset,
              loaded,
              onProgress,
              signal,
              existing,
            );
          } catch (caught) {
            throwIfOCRAborted(signal);
            await staging.delete(asset.url);
            await downloadAsset(
              staging,
              id,
              modelPackage,
              asset,
              loaded,
              onProgress,
              signal,
            );
          }
        } else {
          await downloadAsset(
            staging,
            id,
            modelPackage,
            asset,
            loaded,
            onProgress,
            signal,
          );
        }
        loaded += asset.bytes;
      }
      throwIfOCRAborted(signal);

      const markerUrl = packageMarkerUrl(id);
      const oldMarker = await live.match(markerUrl);
      let previousMarker: OCRPackageMarker | null = null;
      if (oldMarker) {
        try {
          previousMarker = await oldMarker.clone().json() as OCRPackageMarker;
        } catch {
          // Invalid legacy markers are replaced only after verification succeeds.
        }
      }
      const previous = new Map<string, Response | null>();
      try {
        await live.delete(markerUrl);
        for (const asset of missing) {
          previous.set(asset.url, (await live.match(asset.url))?.clone() ?? null);
          const verified = await staging.match(asset.url);
          if (!verified) {
            throw new OCRError(
              "model-integrity-failed",
              `Проверенный файл OCR-модели потерян: ${asset.url}`,
            );
          }
          await live.put(asset.url, verified);
        }
        const marker: OCRPackageMarker = {
          id,
          version: modelPackage.version,
          integrity: modelPackage.integrity,
          installedAt: new Date().toISOString(),
          assets: modelPackage.assets.map((asset) => asset.url),
        };
        await live.put(markerUrl, new Response(JSON.stringify(marker), {
          headers: { "content-type": "application/json" },
        }));
      } catch (caught) {
        for (const [url, response] of previous) {
          if (response) await live.put(url, response);
          else await live.delete(url);
        }
        if (oldMarker) await live.put(markerUrl, oldMarker);
        throw caught;
      }
      const currentUrls = new Set(Object.values(manifest.packages)
        .flatMap((value) => value.assets.map((asset) => asset.url)));
      const previousAssets = Array.isArray(previousMarker?.assets)
        ? previousMarker.assets
        : [];
      await Promise.all(previousAssets
        .filter((url) => !currentUrls.has(url))
        .map((url) => live.delete(url)));
    } catch (caught) {
      if (signal?.aborted) throwIfOCRAborted(signal);
      throw caught;
    } finally {
      await caches.delete(stagingName);
    }

    const finalState = await this.stateFromManifest(id, manifest);
    if (!finalState.installed) {
      throw new OCRError(
        "model-integrity-failed",
        "OCR package не прошёл проверку после установки.",
      );
    }
    return finalState;
  }

  async update(
    id: OCRModelPackageId,
    onProgress?: (progress: OCRModelProgress) => void,
    signal?: AbortSignal,
  ) {
    await getManifest(true);
    return this.install(id, onProgress, signal);
  }

  async remove(id: OCRModelPackageId) {
    const manifest = await getManifest();
    const modelPackage = manifest.packages[id];
    if (!modelPackage) return;
    const cache = await caches.open(MODEL_CACHE);
    const marker = await readMarker(cache, id);
    await cache.delete(packageMarkerUrl(id));
    const keep = new Set<string>();
    for (const otherId of PACKAGE_IDS.filter((value) => value !== id)) {
      const state = await this.stateFromManifest(otherId, manifest);
      if (!state.installed) continue;
      for (const asset of manifest.packages[otherId].assets) keep.add(asset.url);
    }
    const removable = new Set([
      ...modelPackage.assets.map((asset) => asset.url),
      ...(marker?.assets ?? []),
    ]);
    await Promise.all([...removable]
      .filter((url) => !keep.has(url))
      .map((url) => cache.delete(url)));
  }

  async isPrintedInstalled() {
    return (await this.state("printed-ru-en-v1")).installed;
  }

  async isHandwritingInstalled(language: "ru" | "en") {
    const id: OCRModelPackageId = language === "ru"
      ? "handwriting-ru-v1"
      : "handwriting-en-v1";
    return (await this.state(id)).installed;
  }
}

export function formatModelBytes(bytes: number) {
  const mib = bytes / (1024 * 1024);
  return mib >= 100 ? `${mib.toFixed(0)} МБ` : `${mib.toFixed(1)} МБ`;
}
