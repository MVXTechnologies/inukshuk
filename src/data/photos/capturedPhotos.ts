import type { TrackPhoto } from '@core/photos/model';
import { StorageFullError } from '@data/storage';

import {
  deletePhotoFiles,
  writeFullSizeCopies,
  writePhotoCopies,
  type WrittenCopies,
} from './photoFiles';
import type { ResizedPhoto } from './resizer';
import { updateSidecar } from './sidecarStore';
import { deleteTrailPhotoFolder } from './trailFolder';

/**
 * Files of the photos taken with the recording's Photo button (#587). They
 * are written straight into `photos/<sessionId>/`, the folder that becomes
 * the saved trail's (the session id is the trail id), so stopping only has to
 * write the sidecar; discarding deletes the folder.
 */

/** Make one capture's copies: optimized, or the stripped JPEG itself with "Full size". */
export async function writeCapturedCopies(
  sessionId: string,
  photoId: string,
  sourceUri: string,
  resized: ResizedPhoto,
  fullSize: boolean,
): Promise<WrittenCopies> {
  const small = { thumb: resized.thumb.base64, sprite: resized.sprite.base64 };
  if (fullSize) {
    try {
      return await writeFullSizeCopies(sessionId, photoId, sourceUri, small);
    } catch (err) {
      if (err instanceof StorageFullError) throw err;
      // Not a JPEG: keep the optimized copy instead.
    }
  }
  return writePhotoCopies(sessionId, photoId, { display: resized.display.base64, ...small });
}

/** Undo one capture: its three files go. */
export function deleteCapturedPhoto(paths: { file: string; thumb: string; sprite: string }): void {
  deletePhotoFiles(paths);
}

/** The recording was discarded (or saved nothing): the session's whole folder goes. */
export function discardCapturedPhotos(sessionId: string): void {
  deleteTrailPhotoFolder(sessionId);
}

/** The recording was saved as `trackId` (= the session id): record its photos in the sidecar. */
export async function saveCapturedPhotos(
  trackId: string,
  photos: readonly TrackPhoto[],
): Promise<void> {
  if (photos.length === 0) return;
  await updateSidecar(trackId, (sidecar) => ({
    ...sidecar,
    photos: [...sidecar.photos, ...photos],
  }));
}
