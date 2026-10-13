/**
 * Share a trail's photos with the team (#589 + #587): each live photo as the
 * core's owned `photo` entity (its synced fields, `trackId` = the shared
 * trail's id), then its 240 px thumbnail in a second op (`tb`, base64 JPEG)
 * so each op stays under the 32 KiB cap. Display and full-size copies stay on
 * this phone: blob transfer is the protocol's stage 3.
 */
import { livePhotos } from '@core/photos/model';
import { photoToFields } from '@core/team/photos';
import { MAX_THUMB_B64 } from '@core/teamui/comments';
import { readSidecar } from '@data/photos/sidecarStore';
import { readFileBase64, resolveDocumentPath } from '@data/storage';
import type { ActionError, TeamSession } from '@data/team/teamSession';

export async function shareTrailPhotos(
  session: TeamSession,
  trackId: string,
): Promise<{ shared: number; error: ActionError | null }> {
  let sidecar;
  try {
    sidecar = await readSidecar(trackId);
  } catch {
    return { shared: 0, error: null }; // no photos on this trail
  }
  let shared = 0;
  for (const photo of livePhotos(sidecar.sidecar.photos)) {
    const err = session.writeEntity('photo', photo.id, { ...photoToFields(photo), trackId });
    if (err) return { shared, error: err };
    try {
      const tb = await readFileBase64(resolveDocumentPath(photo.thumb));
      if (tb.length <= MAX_THUMB_B64) session.writeEntity('photo', photo.id, { tb });
    } catch {
      // The thumbnail file is missing: the photo is shared without a preview.
    }
    shared++;
  }
  return { shared, error: null };
}
