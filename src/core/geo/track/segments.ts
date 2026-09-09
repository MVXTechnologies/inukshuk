import type { TrackPoint, TrackStats } from '@core/models';
import { accumulateElevationGainLoss, computeTrackStats, type ElevationAccumulator } from './index';

/**
 * Recording segments.
 *
 * A recording is ONE time-ordered point list, cut into segments at every
 * pause: a resume starts a new segment. Nothing bridges a pause — distance,
 * moving time, elevation gain/loss, the map polyline and the GPX (`<trkseg>`)
 * all treat the last pre-pause fix and the first post-pause fix as unrelated.
 * Before this, pausing, driving 1 km and resuming credited the 1 km and the
 * whole pause to the trail (audit A04, #275).
 *
 * Two representations, both pure:
 *
 * - {@link PauseInterval}s are the recorder's source of truth (wall-clock
 *   pause/resume times). A fix belongs to the segment after every pause that
 *   BEGAN before it — keyed on the pause start rather than the resume so a fix
 *   computed just before the resume tap (delivered after it) never lands in the
 *   pre-pause segment and bridges the gap. Fixes stamped inside a pause only
 *   ever arrive through the background journal, and are dropped.
 * - {@link SegmentStarts} are point-list indices where a new segment begins.
 *   The GPX has no pause times, so viewers and the writer use this form; the
 *   recorder derives it from the pauses. An empty list is the single-segment
 *   recording every pre-existing track and checkpoint is.
 */

/** One completed pause, in wall-clock epoch milliseconds. */
export interface PauseInterval {
  /** When the pause began. */
  from: number;
  /** When recording resumed. */
  to: number;
}

/** Indices into a point list at which a new segment begins (never 0). */
export type SegmentStarts = readonly number[];

/** Wall time spent in the given (completed) pauses. */
export function totalPausedMs(pauses: readonly PauseInterval[]): number {
  let ms = 0;
  for (const p of pauses) ms += Math.max(0, p.to - p.from);
  return ms;
}

/** Segment index a fix at `time` belongs to: the count of pauses that began before it. */
export function segmentIndexAt(time: number, pauses: readonly PauseInterval[]): number {
  let n = 0;
  for (const p of pauses) if (p.from < time) n += 1;
  return n;
}

/** True when `next` opens a new segment after `prev` (a pause began between them). */
export function startsNewSegment(
  prev: TrackPoint | undefined,
  next: TrackPoint,
  pauses: readonly PauseInterval[],
): boolean {
  if (prev === undefined || pauses.length === 0) return false;
  return segmentIndexAt(next.time, pauses) !== segmentIndexAt(prev.time, pauses);
}

/** True when `time` falls strictly inside one of the pauses. */
export function isDuringPause(time: number, pauses: readonly PauseInterval[]): boolean {
  return pauses.some((p) => p.from < time && time < p.to);
}

/**
 * Drop fixes stamped inside a pause (the recorder accepts nothing while
 * paused; these only reach it through the background journal). Returns the
 * same array when nothing is dropped, so callers can detect a no-op cheaply.
 */
export function dropPointsDuringPauses(
  points: readonly TrackPoint[],
  pauses: readonly PauseInterval[],
): readonly TrackPoint[] {
  if (pauses.length === 0 || points.length === 0) return points;
  const kept = points.filter((p) => !isDuringPause(p.time, pauses));
  return kept.length === points.length ? points : kept;
}

/** Segment start indices of a time-ordered point list, derived from its pauses. */
export function segmentStartsFromPauses(
  points: readonly TrackPoint[],
  pauses: readonly PauseInterval[],
): number[] {
  const starts: number[] = [];
  if (pauses.length === 0) return starts;
  let prevSegment = -1;
  points.forEach((p, i) => {
    const segment = segmentIndexAt(p.time, pauses);
    if (i > 0 && segment !== prevSegment) starts.push(i);
    prevSegment = segment;
  });
  return starts;
}

/**
 * Sorted, deduplicated starts strictly inside `(0, length)` — a boundary at 0
 * or past the end describes no segment. Tolerates junk from disk.
 */
export function normalizeSegmentStarts(starts: readonly number[], length: number): number[] {
  const valid = starts.filter((i) => Number.isInteger(i) && i > 0 && i < length);
  return Array.from(new Set(valid)).sort((a, b) => a - b);
}

/** Cut `items` into contiguous segments; `[]` for no items, one segment for no starts. */
export function splitSegments<T>(items: readonly T[], starts: SegmentStarts): T[][] {
  if (items.length === 0) return [];
  const bounds = normalizeSegmentStarts(starts, items.length);
  const out: T[][] = [];
  let from = 0;
  for (const b of bounds) {
    out.push(items.slice(from, b));
    from = b;
  }
  out.push(items.slice(from));
  return out;
}

interface SegmentedStatsOpts {
  elevationThresholdM?: number;
  movingSpeedThresholdMps?: number;
  maxAccuracyM?: number;
}

/**
 * {@link computeTrackStats} over a segmented recording: every segment is
 * measured on its own (distance, moving time, elevation hysteresis, duration
 * all restart at the boundary) and the totals summed; bbox and altitude range
 * are unioned, max speed is the max. `durationS` is therefore the recorded
 * (active) time, not the wall clock spanning the pauses. With no starts this
 * IS `computeTrackStats` — single-segment tracks are unchanged.
 */
export function computeSegmentedTrackStats(
  points: readonly TrackPoint[],
  starts: SegmentStarts,
  opts?: SegmentedStatsOpts,
): TrackStats {
  const segments = splitSegments(points, starts);
  if (segments.length <= 1) return computeTrackStats(points, opts);

  let distanceM = 0;
  let ascentM = 0;
  let descentM = 0;
  let durationS = 0;
  let movingTimeS = 0;
  let movingDistanceM = 0;
  let maxSpeedMps = 0;
  let pointCount = 0;
  let minAltitudeM: number | undefined;
  let maxAltitudeM: number | undefined;
  let bbox: TrackStats['bbox'];

  for (const segment of segments) {
    const s = computeTrackStats(segment, opts);
    distanceM += s.distanceM;
    ascentM += s.ascentM;
    descentM += s.descentM;
    durationS += s.durationS;
    movingTimeS += s.movingTimeS;
    // Recover each segment's moving-distance numerator from its average.
    movingDistanceM += s.avgSpeedMps * s.movingTimeS;
    if (s.maxSpeedMps > maxSpeedMps) maxSpeedMps = s.maxSpeedMps;
    pointCount += s.pointCount;
    if (
      s.minAltitudeM !== undefined &&
      (minAltitudeM === undefined || s.minAltitudeM < minAltitudeM)
    )
      minAltitudeM = s.minAltitudeM;
    if (
      s.maxAltitudeM !== undefined &&
      (maxAltitudeM === undefined || s.maxAltitudeM > maxAltitudeM)
    )
      maxAltitudeM = s.maxAltitudeM;
    if (s.bbox) {
      bbox = bbox
        ? {
            minLat: Math.min(bbox.minLat, s.bbox.minLat),
            minLng: Math.min(bbox.minLng, s.bbox.minLng),
            maxLat: Math.max(bbox.maxLat, s.bbox.maxLat),
            maxLng: Math.max(bbox.maxLng, s.bbox.maxLng),
          }
        : s.bbox;
    }
  }

  return {
    distanceM,
    ascentM,
    descentM,
    durationS,
    movingTimeS,
    avgSpeedMps: movingTimeS > 0 ? movingDistanceM / movingTimeS : 0,
    maxSpeedMps,
    minAltitudeM,
    maxAltitudeM,
    bbox,
    pointCount,
  };
}

/**
 * The live D+/D- accumulator for a segmented recording: totals summed over
 * every segment, each with its own hysteresis run, and the running reference
 * left where the LAST segment ended — so a recorder resynchronizing after a
 * batch merge keeps matching {@link computeSegmentedTrackStats} fix by fix.
 */
export function accumulateSegmentedElevation(
  points: readonly TrackPoint[],
  starts: SegmentStarts,
  opts?: { threshold?: number },
): ElevationAccumulator {
  let ascentM = 0;
  let descentM = 0;
  let reference: number | undefined;
  for (const segment of splitSegments(points, starts)) {
    const acc = accumulateElevationGainLoss(
      segment.map((p) => p.altitude),
      opts,
    );
    ascentM += acc.ascentM;
    descentM += acc.descentM;
    reference = acc.reference;
  }
  return { reference, ascentM, descentM };
}
