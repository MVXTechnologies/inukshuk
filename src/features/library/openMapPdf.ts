import type { MapDocument } from '@core/models';
import { resolveDocumentPath } from '@data/storage';
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
 * Resolves `false` when the device cannot share files (the caller says so).
 */
export async function openMapPdf(map: Pick<MapDocument, 'fileUri' | 'name'>): Promise<boolean> {
  if (!(await Sharing.isAvailableAsync())) return false;
  // Stored paths are document-relative (#255); the share sheet needs the absolute uri.
  await Sharing.shareAsync(resolveDocumentPath(map.fileUri), {
    mimeType: 'application/pdf',
    UTI: 'com.adobe.pdf',
    dialogTitle: map.name,
  });
  return true;
}
