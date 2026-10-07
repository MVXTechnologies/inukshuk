import { Directory } from 'expo-file-system';

import { trailPhotoDir } from '@core/photos/paths';
import { resolveDocumentPath } from '@data/storage';

/**
 * Delete a trail's whole photo folder (copies and sidecar) because the trail
 * itself was deleted (#587). Best effort: nothing to delete, or already gone,
 * is not an error.
 *
 * Kept apart from `photoFiles` (which also stages files for the loopback
 * server) so the library store can depend on it without pulling the static
 * server's native module in.
 */
export function deleteTrailPhotoFolder(trackId: string): void {
  try {
    const dir = new Directory(resolveDocumentPath(trailPhotoDir(trackId)));
    if (dir.exists) dir.delete();
  } catch {
    // Nothing to delete, or already gone.
  }
}
