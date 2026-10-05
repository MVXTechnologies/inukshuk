import type { Track, TrackPoint } from '@core/models';
import { computeSegmentedTrackStats } from './segments';

/**
 * Assemble a finished {@link Track} from points parsed out of an imported GPX
 * file. Pure (no platform deps) so it's unit-tested independently of the picker
 * and file I/O. `startedAt`/`endedAt` come from the point timestamps; when the
 * GPX has no `<time>` data, `fallbackTime` (the import time) is used so the UI
 * never shows a 1970 date.
 */
export function buildImportedTrack(args: {
  id: string;
  points: readonly TrackPoint[];
  /** Trail name from GPX metadata, if any. */
  name?: string;
  /** Used when `name` is missing/blank (e.g. the file name). */
  fallbackName: string;
  /** Used for startedAt when the GPX carries no timestamps. */
  fallbackTime: number;
  /** `<trkseg>` boundaries (see `@core/geo/track/segments`); stats never bridge them. */
  segmentStarts?: readonly number[];
  /**
   * The activity category the caller will file it under, when already known:
   * picks the moving-time stop threshold (#504). Not copied onto the track —
   * callers still set `track.category` themselves.
   */
  category?: string | null;
}): Track {
  const { id, points, name, fallbackName, fallbackTime, segmentStarts = [], category } = args;

  let minT = Infinity;
  let maxT = -Infinity;
  for (const p of points) {
    if (p.hasTime !== false && Number.isFinite(p.time) && (p.time > 0 || p.hasTime === true)) {
      if (p.time < minT) minT = p.time;
      if (p.time > maxT) maxT = p.time;
    }
  }

  return {
    id,
    name: name?.trim() || fallbackName,
    startedAt: minT === Infinity ? fallbackTime : minT,
    endedAt: maxT === -Infinity ? undefined : maxT,
    status: 'finished',
    points: [...points],
    // The saved-trail climb rule: a course's terrain-lookup stepping
    // (Garmin Connect) must not read as thousands of metres of climb.
    stats: computeSegmentedTrackStats(points, segmentStarts, { category, robustClimb: true }),
  };
}
