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
}): Track {
  const { id, points, name, fallbackName, fallbackTime, segmentStarts = [] } = args;

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
    stats: computeSegmentedTrackStats(points, segmentStarts),
  };
}
