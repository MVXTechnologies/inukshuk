import { pdfShareName } from '@core/library/shareName';
import type { MapDocument } from '@core/models';
import { contentUriFor, copyToSharedCache, resolveDocumentPath } from '@data/storage';
import { reportError } from '@lib/errorReporting';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';

/** Android's `Intent.FLAG_GRANT_READ_URI_PERMISSION`: the viewer may read our content uri. */
const FLAG_GRANT_READ_URI_PERMISSION = 0x1;
const ACTION_VIEW = 'android.intent.action.VIEW';
const PDF_MIME = 'application/pdf';

/**
 * How {@link openMapPdf} handed the PDF over:
 * - `viewer`: Android opened it in a PDF viewer (VIEW intent);
 * - `shared`: the share sheet showed it (iOS, with its Quick Look preview);
 * - `no-viewer`: Android has no PDF viewer, so the share sheet showed it instead;
 * - `unavailable`: the device can neither view nor share files.
 */
export type OpenMapPdfResult = 'viewer' | 'shared' | 'no-viewer' | 'unavailable';

/**
 * Open a map's PDF as a document, outside the map (#680).
 *
 * A map that is not placed yet (a Cartes Plein-air canoe map: a plain PDF
 * with no georeferencing) has nothing to draw on the map, so tapping it hands
 * the stored PDF to the system. On Android a VIEW intent opens it straight in
 * the installed PDF viewer, through a FileProvider `content://` uri with a
 * read grant; with no viewer installed (`ActivityNotFoundException`) the share
 * sheet is the fallback. iOS shows the share sheet with its Quick Look
 * preview. No GPS position is shown on it — placing such a map with control
 * points is a later feature (#694).
 *
 * The file goes out under the map's title (`Rivière du Nord 2022.pdf`), never
 * the random id it is stored under (2.5.2 QA): a copy in the cache, replaced
 * by the next one. Should the copy fail (a full disk), the stored file goes.
 */
export async function openMapPdf(
  map: Pick<MapDocument, 'fileUri' | 'name'>,
): Promise<OpenMapPdfResult> {
  let uri: string;
  try {
    uri = await copyToSharedCache(map.fileUri, pdfShareName(map.name));
  } catch (err) {
    reportError(err, 'open-map-pdf-copy');
    // Stored paths are document-relative (#255); other apps need the absolute uri.
    uri = resolveDocumentPath(map.fileUri);
  }
  if (Platform.OS === 'android') {
    if (await viewOnAndroid(uri)) return 'viewer';
    return (await share(uri, map.name)) ? 'no-viewer' : 'unavailable';
  }
  return (await share(uri, map.name)) ? 'shared' : 'unavailable';
}

/** The snackbar line for an outcome the user should hear about, else `null`. */
export function openMapPdfMessage(result: OpenMapPdfResult): string | null {
  if (result === 'no-viewer') return 'No PDF viewer installed: pick an app to open the map';
  if (result === 'unavailable') return 'Opening PDFs is not available on this device';
  return null;
}

/** Start the viewer; `false` when no app takes the intent. */
async function viewOnAndroid(uri: string): Promise<boolean> {
  // Resolves when the user comes back from the viewer; rejects at once when
  // no activity handles application/pdf.
  try {
    await IntentLauncher.startActivityAsync(ACTION_VIEW, {
      data: contentUriFor(uri),
      type: PDF_MIME,
      flags: FLAG_GRANT_READ_URI_PERMISSION,
    });
    return true;
  } catch (err) {
    // A second tap while the viewer is still opening: it is on its way.
    if ((err as { code?: unknown } | null)?.code === 'E_ACTIVITY_ALREADY_STARTED') return true;
    // "No viewer" is an expected outcome, not a defect worth a report.
    if (!/ActivityNotFound|No Activity found/i.test(String(err))) {
      reportError(err, 'open-map-pdf-view');
    }
    return false;
  }
}

async function share(uri: string, title: string): Promise<boolean> {
  if (!(await Sharing.isAvailableAsync())) return false;
  await Sharing.shareAsync(uri, { mimeType: PDF_MIME, UTI: 'com.adobe.pdf', dialogTitle: title });
  return true;
}
