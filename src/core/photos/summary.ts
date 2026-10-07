import type { TrackPhoto } from './model';
import { stackCover, visiblePhotos } from './stack';

/**
 * What the library index caches about a trail's photos (#587): the count of
 * photos the trail shows (not hidden, not removed) and its cover, the first
 * in time (owner Q11). `undefined` fields mean "no photos".
 */
export interface TrailPhotoSummary {
  photoCount?: number;
  coverPhotoId?: string;
}

export function trailPhotoSummary(photos: readonly TrackPhoto[]): TrailPhotoSummary {
  const shown = visiblePhotos(photos);
  const cover = stackCover(shown);
  if (shown.length === 0 || !cover) return {};
  return { photoCount: shown.length, coverPhotoId: cover.id };
}

/** Whether a summary differs from what a trail already carries (skip no-op index writes). */
export function photoSummaryChanged(current: TrailPhotoSummary, next: TrailPhotoSummary): boolean {
  return current.photoCount !== next.photoCount || current.coverPhotoId !== next.coverPhotoId;
}

/** "33 photos", "1 photo". */
export function photoCountLabel(n: number): string {
  return n === 1 ? '1 photo' : `${n} photos`;
}
