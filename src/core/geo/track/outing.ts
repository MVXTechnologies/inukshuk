import type { TrackPoint } from '@core/models';
import {
  findElevationExtremes,
  findSteepestStretches,
  detectStops,
  type ElevationExtremes,
  type SteepestStretches,
  type Stop,
} from './highlights';
import { classifySegmentedSteps, movingProfileFor } from './movingTime';
import { computeSplits, type Split } from './splits';
import { buildTrackAxis, type TrackAxis } from './trackAxis';

/**
 * Everything the trail view (#511) derives from a trail's points, in one
 * pass per track: the distance axis, the moving/stopped step verdicts, the
 * splits, the stops, the steepest stretch and the elevation extremes. All
 * O(n); the Timeline is then built from these plus the notes (cheap, so a
 * note edit never re-runs this).
 */
export interface OutingAnalysis {
  axis: TrackAxis;
  /** True when the trail carries time (a recording, not a planned route). */
  timed: boolean;
  splits: Split[];
  stops: Stop[];
  /** Steepest climb and descent (smoothed, noise-capped). */
  steepest: SteepestStretches;
  extremes: ElevationExtremes | null;
}

export interface OutingOpts {
  segmentStarts?: readonly number[];
  /** Activity category: picks the moving-time stop threshold. */
  category?: string | null;
  /** Split length in metres (1000 for km, 1609.344 for miles). */
  splitUnitM: number;
  /** Shortest stop listed in the Timeline, seconds (default 3 min). */
  minStopS?: number;
}

/** True when at least two fixes carry forward-moving time. */
export function isTimedTrack(points: readonly TrackPoint[]): boolean {
  let prev: number | undefined;
  for (const p of points) {
    if (p.hasTime === false || !Number.isFinite(p.time)) continue;
    if (prev !== undefined && p.time > prev) return true;
    prev = p.time;
  }
  return false;
}

export function analyzeOuting(points: readonly TrackPoint[], opts: OutingOpts): OutingAnalysis {
  const segmentStarts = opts.segmentStarts ?? [];
  const axis = buildTrackAxis(points);
  const timed = isTimedTrack(points);
  const profile = movingProfileFor(opts.category);
  const steps = timed
    ? classifySegmentedSteps(points, segmentStarts, { stopSpeedMps: profile.stopSpeedMps })
    : undefined;
  return {
    axis,
    timed,
    splits: computeSplits(points, { unitM: opts.splitUnitM, steps, segmentStarts }),
    stops: steps
      ? detectStops(points, steps, { minStopS: opts.minStopS, stopSpeedMps: profile.stopSpeedMps })
      : [],
    steepest: findSteepestStretches(points, axis, { segmentStarts }),
    extremes: findElevationExtremes(points),
  };
}
