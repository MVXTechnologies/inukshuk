import type { TrackPhoto } from './model';
import { choosePass } from './placement';
import { passesNear, positionAtDistance, positionAtTime, type TrackIndex } from './trackIndex';

/**
 * Keep photos on their trail when the trail itself changes (#587): a trim
 * cuts the ends, a merge joins two trails into a new one.
 */

/** Refresh a photo's cached position and elevation for a new `distanceM`. */
function at(photo: TrackPhoto, index: TrackIndex, distanceM: number, now: number): TrackPhoto {
  const pos = positionAtDistance(index, distanceM);
  if (!pos) return photo;
  const next: TrackPhoto = {
    ...photo,
    distanceM: pos.distanceM,
    lngLat: pos.lngLat,
    updatedAt: now,
  };
  if (pos.elevationM !== undefined) next.elevationM = pos.elevationM;
  else delete next.elevationM;
  return next;
}

/**
 * After a trim that kept `[keptStartM, keptEndM]` of the old trail: photos in
 * the cut parts are removed (the trim dialog says so, like notes), the rest
 * shift back by `keptStartM` and get positions on the new, trimmed trail.
 */
export function reanchorAfterTrim(
  photos: readonly TrackPhoto[],
  keptStartM: number,
  keptEndM: number,
  trimmed: TrackIndex,
  now: number,
): { kept: TrackPhoto[]; removed: TrackPhoto[] } {
  const kept: TrackPhoto[] = [];
  const removed: TrackPhoto[] = [];
  // A hair of tolerance: a photo exactly on a cut stays.
  const eps = 0.5;
  for (const p of photos) {
    if (p.deletedAt !== undefined) {
      kept.push(p);
      continue;
    }
    if (p.distanceM < keptStartM - eps || p.distanceM > keptEndM + eps) removed.push(p);
    else kept.push(at(p, trimmed, Math.max(0, p.distanceM - keptStartM), now));
  }
  return { kept, removed };
}

/**
 * Re-place photos on a different trail (a merge): by time when the photo has
 * one and the new trail covers it, else by its EXIF GPS, else at its old
 * distance (clamped). `trackId` is moved to the new trail.
 */
export function reanchorOnTrail(
  photos: readonly TrackPhoto[],
  index: TrackIndex,
  trackId: string,
  now: number,
): TrackPhoto[] {
  return photos.map((p) => {
    const moved = { ...p, trackId };
    if (p.deletedAt !== undefined) return moved;
    if (p.takenAt !== undefined) {
      const pos = positionAtTime(index, p.takenAt);
      if (pos) return at(moved, index, pos.distanceM, now);
    }
    const gps =
      p.exifLngLat ?? (p.placement === 'gps' || p.placement === 'capture' ? p.lngLat : undefined);
    if (gps) {
      const pass = choosePass(index, passesNear(index, gps, 200), p.takenAt);
      if (pass) return at(moved, index, pass.distanceM, now);
    }
    return at(moved, index, Math.min(p.distanceM, index.totalM), now);
  });
}
