import { Directory, File, Paths } from 'expo-file-system';
import * as LegacyFS from 'expo-file-system/legacy';

import { isPdfFormat, type CatalogItem } from '@core/catalog/schema';
import { extractPdf } from '@core/catalog/unzip';
import type { BoundingBox, GeoReference } from '@core/models';
import { GeoTiffImportAborted, installGeoTiffMap } from './geotiffImport';
import * as storage from './storage';

/**
 * Download one catalog item's file and land it in the maps store.
 *
 * Uses the legacy `createDownloadResumable` deliberately: the SDK 56
 * `File.downloadFileAsync` has neither a progress callback nor cancellation,
 * and a CanTopo sheet is a multi-MB download the UI must show a real bar for.
 * The transfer stages into `Paths.cache/catalog/` and only the extracted,
 * verified map is written into `maps/<id>.<ext>` — a killed or failed download
 * can never leave a partial file in the library directory.
 *
 * Two formats land here, and they land differently:
 *
 * - **PDF / GeoPDF** — the PDF is lifted out of the zip and stored whole; the
 *   georeferencing is read later, by `parseGeoPdf`, from the stored file.
 * - **GeoTIFF** (NRCan CanMatrix scans) — far too big to store whole, so
 *   `installGeoTiffMap` streams the staged zip, renders the overlay once and
 *   stores that PNG. It resolves the georeferencing on the way past, which is
 *   why a download result can carry one.
 */

/** Thrown when the download was canceled by the user. */
export class CatalogDownloadCanceled extends Error {
  constructor() {
    super('Download canceled');
    this.name = 'CatalogDownloadCanceled';
  }
}

export interface CatalogDownloadResult {
  /** The stored map's file:// uri in the maps store. */
  fileUri: string;
  /**
   * Georeferencing already resolved during the install, for formats whose
   * stored file no longer carries it (a GeoTIFF is stored as its rendered
   * overlay PNG). Absent for PDFs, which are parsed from the stored file.
   */
  georeference?: GeoReference;
}

export interface CatalogDownloadHandle {
  promise: Promise<CatalogDownloadResult>;
  /** Cancel the transfer; `promise` then rejects with {@link CatalogDownloadCanceled}. */
  cancel: () => void;
}

/**
 * Fraction 0..1, or null while the total is unknown (no Content-Length and no
 * manifest sizeBytes) — the bar shows indeterminate then.
 */
export type CatalogDownloadProgress = (fraction: number | null) => void;

/** The item's extent as a {@link BoundingBox}, for the GeoTIFF neatline crop. */
function clipBoxOf(item: CatalogItem): BoundingBox | undefined {
  if (item.bbox === undefined) return undefined;
  const [minLng, minLat, maxLng, maxLat] = item.bbox;
  return { minLng, minLat, maxLng, maxLat };
}

export function downloadCatalogMap(
  item: CatalogItem,
  mapId: string,
  onProgress: CatalogDownloadProgress,
): CatalogDownloadHandle {
  const stagingDir = new Directory(Paths.cache, 'catalog');
  if (!stagingDir.exists) stagingDir.create({ intermediates: true });
  const staged = new File(stagingDir, `${mapId}.part`);
  if (staged.exists) staged.delete();

  let canceled = false;
  // A GeoTIFF is rendered after the transfer, and that render takes about as
  // long again — so the transfer only fills the first two thirds of the bar
  // and the render fills the rest. A PDF is stored as-is: transfer IS the bar.
  const transferShare = isPdfFormat(item.format) ? 1 : 0.66;
  const resumable = LegacyFS.createDownloadResumable(item.url, staged.uri, {}, (progress) => {
    const total =
      progress.totalBytesExpectedToWrite > 0
        ? progress.totalBytesExpectedToWrite
        : (item.sizeBytes ?? 0);
    onProgress(total > 0 ? Math.min(1, progress.totalBytesWritten / total) * transferShare : null);
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
    if (!isPdfFormat(item.format)) {
      // Streams the staged file — a 92 MB scan is never read into memory.
      // The render is long enough to be cancelled part-way through, and must
      // be: finishing would install a map the user just said no to.
      const clipBbox = clipBoxOf(item);
      try {
        const installed = await installGeoTiffMap(staged.uri, mapId, {
          ...(clipBbox !== undefined ? { clipBbox } : {}),
          onRenderProgress: (fraction) =>
            onProgress(transferShare + fraction * (1 - transferShare)),
          shouldAbort: () => canceled,
        });
        return { fileUri: installed.fileUri, georeference: installed.georeference };
      } catch (err) {
        if (err instanceof GeoTiffImportAborted) throw new CatalogDownloadCanceled();
        throw err;
      }
    }
    const bytes = await storage.readFileBytes(staged.uri);
    const pdf = extractPdf(bytes);
    if (pdf === null) {
      throw new Error('The downloaded file does not contain a PDF map.');
    }
    return { fileUri: storage.writeMapPdfBytes(mapId, pdf) };
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
