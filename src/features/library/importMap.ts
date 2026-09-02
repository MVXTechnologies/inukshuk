import type { GeoReference, MapDocument } from '@core/models';
import { parseGeoPdf } from '@core/geo/geopdf';
import { primaryGeoreferences } from '@core/geo/geopdf/primary';
import { looksLikeGeoTiffFile } from '@core/library/mapFile';
import { installGeoTiffMap } from '@data/geotiffImport';
import * as storage from '@data/storage';
import { reportError } from '@lib/errorReporting';
import * as DocumentPicker from 'expo-document-picker';

export type BulkImportResult =
  | { kind: 'imported'; docs: MapDocument[]; failed: number }
  | { kind: 'canceled' }
  | { kind: 'error'; message: string };

/**
 * Parse a PDF already sitting in app storage into a MapDocument (throws on
 * failure, deleting the stored file so it can't orphan). Shared by the picker
 * import below and the map maker's generated PDFs.
 */
export async function mapDocumentFromStoredPdf(
  id: string,
  fileUri: string,
  name: string,
): Promise<MapDocument> {
  let parsed: ReturnType<typeof parseGeoPdf>;
  try {
    const bytes = await storage.readFileBytes(fileUri);
    parsed = parseGeoPdf(bytes);
  } catch (err) {
    // The copy landed in permanent storage before it could be read/parsed;
    // delete it or a failed import orphans the file there forever.
    storage.deleteFileAt(fileUri);
    throw err;
  }
  return {
    id,
    name,
    fileUri,
    importedAt: Date.now(),
    pageCount: parsed.pageCount,
    // Default to showing every georeferenced page; the user can uncheck pages
    // later. One PAGE may carry several viewports (AUSTopo and US Topo sheets
    // carry a locator inset and an adjoining-sheet diagram beside the map), so
    // active pages are the distinct page indexes — never one entry per
    // viewport, which would activate the same page three times.
    georeferences: parsed.georeferences,
    activePages: primaryGeoreferences(parsed.georeferences).map((g) => g.pageIndex),
    georeferenceWarning:
      parsed.georeferences.length > 0
        ? undefined
        : (parsed.warnings[0] ?? 'No georeferencing found in this PDF.'),
  };
}

/**
 * A MapDocument for a map that is already a rendered, georeferenced raster —
 * the GeoTIFF path, where `installGeoTiffMap` has written the overlay PNG and
 * resolved the georeferencing on the way through.
 *
 * There is nothing to parse and nothing to page through: one image, one
 * georeference, always active. The `.png` extension on `fileUri` is what tells
 * the overlay hook to draw the file rather than run the PDF rasterizer over it.
 */
export function mapDocumentFromRasterOverlay(
  id: string,
  fileUri: string,
  name: string,
  georeference: GeoReference,
): MapDocument {
  return {
    id,
    name,
    fileUri,
    importedAt: Date.now(),
    pageCount: 1,
    georeferences: [georeference],
    activePages: [georeference.pageIndex],
  };
}

/** Copy + parse one picked asset into a MapDocument (throws on failure). */
async function importOne(asset: DocumentPicker.DocumentPickerAsset): Promise<MapDocument> {
  const id = storage.newId();
  const name = asset.name?.replace(/\.(pdf|tiff?)$/i, '') ?? 'Map';
  if (looksLikeGeoTiffFile(asset)) {
    // A GeoTIFF is rendered to its overlay here and now — the scan itself is
    // never stored (see `@data/geotiffImport`). No sheet is known for a
    // hand-picked file, so there is no neatline to crop to: the whole image is
    // drawn, collar and all.
    const installed = await installGeoTiffMap(asset.uri, id);
    return mapDocumentFromRasterOverlay(id, installed.fileUri, name, installed.georeference);
  }
  const fileUri = await storage.importMapFile(asset.uri, id, 'pdf');
  return mapDocumentFromStoredPdf(id, fileUri, name);
}

/**
 * Let the user pick one or more maps, copy them into app storage, and resolve
 * each one's georeferencing. PDFs with no recognizable georeferencing are still
 * imported (viewable as plain documents) but flagged with a warning. Files that
 * fail to import are counted in `failed` rather than aborting the lot.
 */
export async function pickAndImportMaps(): Promise<BulkImportResult> {
  let picked: DocumentPicker.DocumentPickerResult;
  try {
    picked = await DocumentPicker.getDocumentAsync({
      // `image/tiff` for the CanMatrix-style scans; `octet-stream` because
      // several Android file providers type a .tif as exactly that, and
      // without it the picker greys those files out.
      type: ['application/pdf', 'image/tiff', 'application/octet-stream'],
      copyToCacheDirectory: true,
      multiple: true,
    });
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : 'Picker failed' };
  }

  if (picked.canceled || picked.assets.length === 0) return { kind: 'canceled' };

  const docs: MapDocument[] = [];
  let failed = 0;
  for (const asset of picked.assets) {
    try {
      docs.push(await importOne(asset));
    } catch (err) {
      // Counted in the user-facing "N failed" summary; report the cause too.
      reportError(err, 'map-import');
      failed += 1;
    }
  }
  return { kind: 'imported', docs, failed };
}
