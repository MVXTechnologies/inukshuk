import { Directory, File, Paths } from 'expo-file-system';
import * as LegacyFS from 'expo-file-system/legacy';

import type { CatalogItem } from '@core/catalog/schema';
import { extractPdf } from '@core/catalog/unzip';
import * as storage from './storage';

/**
 * Download one catalog item's file and land its PDF in the maps store.
 *
 * Uses the legacy `createDownloadResumable` deliberately: the SDK 56
 * `File.downloadFileAsync` has neither a progress callback nor cancellation,
 * and a CanTopo sheet is a multi-MB download the UI must show a real bar for.
 * The transfer stages into `Paths.cache/catalog/` and only the extracted,
 * verified PDF is written into `maps/<id>.pdf` — a killed or failed download
 * can never leave a partial file in the library directory.
 */

/** Thrown when the download was canceled by the user. */
export class CatalogDownloadCanceled extends Error {
  constructor() {
    super('Download canceled');
    this.name = 'CatalogDownloadCanceled';
  }
}

export interface CatalogDownloadHandle {
  /** Resolves to the stored PDF's file:// uri in the maps store. */
  promise: Promise<string>;
  /** Cancel the transfer; `promise` then rejects with {@link CatalogDownloadCanceled}. */
  cancel: () => void;
}

/**
 * Fraction 0..1, or null while the total is unknown (no Content-Length and no
 * manifest sizeBytes) — the bar shows indeterminate then.
 */
export type CatalogDownloadProgress = (fraction: number | null) => void;

export function downloadCatalogPdf(
  item: CatalogItem,
  mapId: string,
  onProgress: CatalogDownloadProgress,
): CatalogDownloadHandle {
  const stagingDir = new Directory(Paths.cache, 'catalog');
  if (!stagingDir.exists) stagingDir.create({ intermediates: true });
  const staged = new File(stagingDir, `${mapId}.part`);
  if (staged.exists) staged.delete();

  let canceled = false;
  const resumable = LegacyFS.createDownloadResumable(item.url, staged.uri, {}, (progress) => {
    const total =
      progress.totalBytesExpectedToWrite > 0
        ? progress.totalBytesExpectedToWrite
        : (item.sizeBytes ?? 0);
    onProgress(total > 0 ? Math.min(1, progress.totalBytesWritten / total) : null);
  });

  const cleanupStaged = () => {
    try {
      if (staged.exists) staged.delete();
    } catch {
      // Best-effort — the cache dir is transient anyway.
    }
  };

  const promise = (async () => {
    let result: LegacyFS.FileSystemDownloadResult | undefined;
    try {
      result = await resumable.downloadAsync();
    } catch (err) {
      // Cancellation surfaces as a rejection on some platforms — normalize it.
      if (canceled) throw new CatalogDownloadCanceled();
      throw err;
    }
    if (canceled || result === undefined) throw new CatalogDownloadCanceled();
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`Download failed: HTTP ${result.status}`);
    }
    const bytes = await storage.readFileBytes(staged.uri);
    const pdf = extractPdf(bytes);
    if (pdf === null) {
      throw new Error('The downloaded file does not contain a PDF map.');
    }
    return storage.writeMapPdfBytes(mapId, pdf);
  })().finally(cleanupStaged);

  return {
    promise,
    cancel: () => {
      canceled = true;
      // Fire-and-forget: downloadAsync settles (undefined or rejection) after
      // the native task stops; the promise above normalizes both to Canceled.
      resumable.cancelAsync().catch(() => undefined);
    },
  };
}
