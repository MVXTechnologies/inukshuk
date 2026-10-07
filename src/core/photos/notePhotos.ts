import type { TrackNote } from '@core/models';

import { noteToPhoto, type TrackPhoto } from './model';
import { orderPhotos } from './stack';
import { positionAtDistance, type TrackIndex } from './trackIndex';

/**
 * A trail's note photos seen as trail photos (owner Q9: one set of photos per
 * trail, in the same layer and viewer). Each sits at its note's distance on
 * the trail. Notes without a photo are skipped. Read-only: see `noteToPhoto`.
 */
export function notePhotosOnTrail(
  notes: readonly TrackNote[] | undefined,
  trackId: string,
  index: TrackIndex,
): TrackPhoto[] {
  const out: TrackPhoto[] = [];
  for (const note of notes ?? []) {
    if (!note.photoUri) continue;
    const pos = positionAtDistance(index, note.distanceM);
    if (!pos) continue;
    const at =
      pos.elevationM === undefined
        ? { lngLat: pos.lngLat }
        : { lngLat: pos.lngLat, elevationM: pos.elevationM };
    const photo = noteToPhoto(note, trackId, at);
    // A note past a since-trimmed end sits on the last point, like its circle.
    if (photo) out.push({ ...photo, distanceM: pos.distanceM });
  }
  return out;
}

/**
 * Everything a trail shows as photos, in the viewer's order (time first): its
 * own photos plus its note photos. A note photo has no capture time, so it
 * sorts by distance among the timeless ones, after the timed photos.
 */
export function combineTrailPhotos(
  photos: readonly TrackPhoto[],
  notePhotos: readonly TrackPhoto[],
): TrackPhoto[] {
  return notePhotos.length === 0 ? [...photos] : orderPhotos([...photos, ...notePhotos]);
}
