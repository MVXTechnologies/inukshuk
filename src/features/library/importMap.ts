import type { MapDocument } from '@core/models';
import { parseGeoPdf } from '@core/geo/geopdf';
import { defaultActivePages } from '@core/library/overlayPages';
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
    // later. The rule lives in @core/library/overlayPages so the Library card
    // and this path can never disagree about what a map "has pages" means.
    georeferences: parsed.georeferences,
    activePages: defaultActivePages(parsed.georeferences),
    georeferenceWarning:
      parsed.georeferences.length > 0
        ? undefined
        : (parsed.warnings[0] ?? 'No georeferencing found in this PDF.'),
  };
}

/** Copy + parse one picked PDF asset into a MapDocument (throws on failure). */
async function importOne(asset: DocumentPicker.DocumentPickerAsset): Promise<MapDocument> {
  const id = storage.newId();
  const fileUri = await storage.importPdf(asset.uri, id);
  return mapDocumentFromStoredPdf(id, fileUri, asset.name?.replace(/\.pdf$/i, '') ?? 'Map');
}

/**
 * Let the user pick one or more PDFs, copy them into app storage, and resolve
 * each one's embedded georeferencing. PDFs with no recognizable georeferencing
 * are still imported (viewable as plain documents) but flagged with a warning
 * — `parseGeoPdf` never throws, so that case is a *parsed* map the card
 * explains, not a failure.
 *
 * A file that genuinely fails (its bytes could not be read back) is NOT added:
 * a MapDocument over an unreadable file can be neither drawn nor opened, so
 * adding it "flagged" would only leave a permanently broken row. Failures are
 * counted in `failed`, and when EVERY picked file failed the result is an
 * `error` carrying the reason — so a whole import can never end in a cheerful
 * "Imported 0 maps" with nothing said about why (#236).
 */
export async function pickAndImportMaps(): Promise<BulkImportResult> {
  let picked: DocumentPicker.DocumentPickerResult;
  try {
    picked = await DocumentPicker.getDocumentAsync({
      type: 'application/pdf',
      copyToCacheDirectory: true,
      multiple: true,
    });
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : 'Picker failed' };
  }

  if (picked.canceled || picked.assets.length === 0) return { kind: 'canceled' };

  const docs: MapDocument[] = [];
  let failed = 0;
  let firstFailure: string | null = null;
  for (const asset of picked.assets) {
    try {
      docs.push(await importOne(asset));
    } catch (err) {
      // Counted in the user-facing "N failed" summary; report the cause too.
      reportError(err, 'pdf-import');
      failed += 1;
      firstFailure ??= err instanceof Error ? err.message : 'Could not read that PDF';
    }
  }
  // Nothing imported at all: say why, through the caller's error snackbar,
  // instead of reporting a successful import of zero maps.
  if (docs.length === 0 && failed > 0) {
    return { kind: 'error', message: firstFailure ?? 'Could not read that PDF' };
  }
  return { kind: 'imported', docs, failed };
}
