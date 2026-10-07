import type { TrackPhoto } from './model';

/**
 * Photo anchors and the trail view's distance axis (#587).
 *
 * A photo's `distanceM` is measured along every step of the GPX (see
 * `indexTrack`), so it survives edits of how pauses are counted. The trail
 * view's charts, cursor and "3.20 km of 9.02 km" use the recording's axis,
 * which never bridges a pause (#325). Both are one cumulative value per point
 * of the SAME point list, so a photo maps between them by its place between
 * two points.
 */

/** Map a distance on one cumulative axis onto another of the same points. */
export function mapAlongPoints(
  fromCumM: ArrayLike<number>,
  toCumM: ArrayLike<number>,
  distanceM: number,
): number {
  const n = Math.min(fromCumM.length, toCumM.length);
  if (n === 0) return 0;
  if (n === 1 || distanceM <= fromCumM[0]!) return toCumM[0]!;
  if (distanceM >= fromCumM[n - 1]!) return toCumM[n - 1]!;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (fromCumM[mid]! <= distanceM) lo = mid;
    else hi = mid;
  }
  const span = fromCumM[hi]! - fromCumM[lo]!;
  const t = span > 0 ? (distanceM - fromCumM[lo]!) / span : 0;
  return toCumM[lo]! + (toCumM[hi]! - toCumM[lo]!) * t;
}

/** A photo with its distance on the trail view's axis. */
export interface PhotoOnAxis {
  photo: TrackPhoto;
  /** Metres along the trail view's axis (what the charts and cursor use). */
  distanceM: number;
}

/** Every photo placed on the trail view's axis, in the given order. */
export function photosOnAxis(
  photos: readonly TrackPhoto[],
  indexCumM: ArrayLike<number>,
  axisCumM: ArrayLike<number>,
): PhotoOnAxis[] {
  return photos.map((photo) => ({
    photo,
    distanceM: mapAlongPoints(indexCumM, axisCumM, photo.distanceM),
  }));
}
