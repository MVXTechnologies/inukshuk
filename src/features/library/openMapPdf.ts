import { pdfShareName } from '@core/library/shareName';
import type { MapDocument } from '@core/models';
import { copyToSharedCache, resolveDocumentPath } from '@data/storage';
import { reportError } from '@lib/errorReporting';
import * as Sharing from 'expo-sharing';

/**
 * Open a map's PDF as a document, outside the map (#680).
 *
 * A map that is not placed yet (a Cartes Plein-air canoe map: a plain PDF
 * with no georeferencing) has nothing to draw on the map, so tapping it hands
 * the stored PDF to the system: iOS shows the share sheet with its Quick Look
 * preview, Android offers the installed PDF viewers. No GPS position is shown
 * on it — placing such a map with control points is a later feature (#694).
 *
 * The file goes out under the map's title (`Rivière du Nord 2022.pdf`), never
 * the random id it is stored under (2.5.2 QA): a copy in the cache, replaced
 * by the next one. Should the copy fail (a full disk), the stored file goes.
 *
 * Resolves `false` when the device cannot share files (the caller says so).
 */
export async function openMapPdf(map: Pick<MapDocument, 'fileUri' | 'name'>): Promise<boolean> {
  if (!(await Sharing.isAvailableAsync())) return false;
  let uri: string;
  try {
    uri = await copyToSharedCache(map.fileUri, pdfShareName(map.name));
  } catch (err) {
    reportError(err, 'open-map-pdf-copy');
    // Stored paths are document-relative (#255); the share sheet needs the absolute uri.
    uri = resolveDocumentPath(map.fileUri);
  }
  await Sharing.shareAsync(uri, {
    mimeType: 'application/pdf',
    UTI: 'com.adobe.pdf',
    dialogTitle: map.name,
  });
  return true;
}
