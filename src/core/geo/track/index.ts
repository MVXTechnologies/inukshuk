import type { BoundingBox, TrackPoint, TrackStats } from '@core/models';
import { haversineMeters } from '@core/geo/geomath';
import { CLIMB_MODEL_KEY, climbElevations } from './elevationSmoothing';
import { computeMovingTime, movingModelKey, movingProfileFor } from './movingTime';

/**
 * Pure track-statistics math: distance, elevation gain/loss with GPS-noise
 * suppression, moving time, speeds and bbox. No platform dependencies — runs
 * in Node (Jest) and the RN JS runtime.
 */

// Re-exported here so existing `@core/geo/track` consumers keep working after
// haversineMeters moved to the shared geomath module.
export { haversineMeters };
export { buildElevationProfile } from './elevationProfile';
export type { ElevationProfile, ElevationSample } from './elevationProfile';
export { buildImportedTrack } from './importTrack';
export { snapWaypointsToNotes } from './snapWaypoints';
export { withDemElevations, type DemGrid } from './demElevations';
export {
  CLIMB_MODEL_KEY,
  CLIMB_MODEL_VERSION,
  CLIMB_NOISE_RATIO,
  CLIMB_SMOOTHING_WINDOW_M,
  climbElevations,
  smoothElevationsByDistance,
} from './elevationSmoothing';
export { refreshClimbStats } from './refreshClimb';
export type { ImportedNote } from './snapWaypoints';
export { interpolateTrackAtDistance } from './interpolate';
export type { TrackPointAt } from './interpolate';
export { scrubProfileAtRatio } from './scrub';
export type { ProfileScrub } from './scrub';
export {
  accumulateSegmentedElevation,
  computeSegmentedTrackStats,
  dropPointsDuringPauses,
  normalizeSegmentStarts,
  segmentStartsFromPauses,
  splitSegments,
  startsNewSegment,
  totalPausedMs,
} from './segments';
export type { PauseInterval, SegmentStarts } from './segments';
export {
  computeMovingTime,
  hasCurrentMovingStats,
  MOVING_MODEL_VERSION,
  movingModelKey,
  movingProfileFor,
  trailTiming,
} from './movingTime';
export { refreshMovingStats } from './refreshMoving';
export {
  classifyMovingSteps,
  classifySegmentedSteps,
  STEP_BREAK,
  STEP_GAP,
  STEP_INVALID,
  STEP_MOVING,
  STEP_STOPPED,
} from './movingTime';
export {
  buildTrackAxis,
  gradeAtDistance,
  indexAtDistance,
  interpolateOnAxis,
  pointAtIndex,
} from './trackAxis';
export type { TrackAxis } from './trackAxis';
export { computeSplits } from './splits';
export type { Split, SplitOpts } from './splits';
export { detectStops, findElevationExtremes, findSteepestStretches } from './highlights';
export type { ElevationExtremes, SteepestStretches, SteepStretch, Stop } from './highlights';
export { buildOutingTimeline } from './timeline';
export type { TimelineEvent, TimelineEventKind, TimelineNote } from './timeline';
export { analyzeOuting, isTimedTrack } from './outing';
export type { OutingAnalysis } from './outing';
export type { MovingProfile, MovingProfileId, MovingTimeOpts, TrailTiming } from './movingTime';

const DEFAULT_ELEVATION_THRESHOLD_M = 3;
const DEFAULT_MOVING_SPEED_THRESHOLD_MPS = 0.5;

/**
 * Running state for the elevation hysteresis filter (see
 * {@link stepElevationGainLoss} / {@link elevationGainLoss}): the current
 * "reference" elevation plus the ascent/descent committed so far. Threading
 * this through callers (rather than recomputing from scratch) is what lets
 * the LIVE recorder apply the exact same hysteresis as the final saved
 * stats, incrementally, one fix at a time.
 */
export interface ElevationAccumulator {
  reference: number | undefined;
  ascentM: number;
  descentM: number;
}

/** The accumulator's initial state, before any elevation sample has been seen. */
export const EMPTY_ELEVATION_ACC: ElevationAccumulator = {
  reference: undefined,
  ascentM: 0,
  descentM: 0,
};

/**
 * Fold ONE new elevation sample into an {@link ElevationAccumulator}, applying
 * the same hysteresis rule as {@link elevationGainLoss}: a delta from the
 * current reference only commits to ascent/descent once it exceeds
 * `threshold`, and the reference then advances to the new elevation. A
 * `undefined`/`NaN` sample is a no-op (returns `acc` unchanged) — it neither
 * resets nor advances the reference, exactly like the batch version skipping
 * undefined samples.
 *
 * Unlike a naive "compare to the previous point" step, this keeps a real
 * running reference across calls, so a slow sustained climb made of many
 * sub-threshold single-fix deltas is still counted in full once the
 * CUMULATIVE change from the reference clears the threshold — the live HUD
 * no longer under-counts relative to the authoritative batch computation.
 */
export function stepElevationGainLoss(
  acc: ElevationAccumulator,
  elevation: number | undefined,
  opts?: { threshold?: number },
): ElevationAccumulator {
  if (elevation === undefined || Number.isNaN(elevation)) return acc;
  const threshold = opts?.threshold ?? DEFAULT_ELEVATION_THRESHOLD_M;
  if (acc.reference === undefined) {
    return { reference: elevation, ascentM: acc.ascentM, descentM: acc.descentM };
  }
  const delta = elevation - acc.reference;
  if (delta >= threshold) {
    return { reference: elevation, ascentM: acc.ascentM + delta, descentM: acc.descentM };
  }
  if (-delta >= threshold) {
    return { reference: elevation, ascentM: acc.ascentM, descentM: acc.descentM - delta };
  }
  // Within the dead-band: leave the reference (and totals) untouched.
  return acc;
}

/**
 * Fold a whole elevation series into an {@link ElevationAccumulator} from
 * scratch, one sample at a time via {@link stepElevationGainLoss}. Used both
 * by {@link elevationGainLoss} (which discards the final reference) and by
 * the recorder store to (re)synchronize its live accumulator after a batch
 * operation (merge, crash recovery) replaces the point list wholesale.
 */
export function accumulateElevationGainLoss(
  elevations: readonly (number | undefined)[],
  opts?: { threshold?: number },
): ElevationAccumulator {
  let acc = EMPTY_ELEVATION_ACC;
  for (const ele of elevations) acc = stepElevationGainLoss(acc, ele, opts);
  return acc;
}

/**
 * Open a new recording segment on a live accumulator: the ascent/descent
 * totals carry over, the running reference is dropped so the first fix after
 * a pause re-seeds it instead of being measured against the last pre-pause
 * elevation (a pause on a summit followed by a resume in the valley is not
 * 500 m of descent). Equals {@link accumulateSegmentedElevation} run
 * incrementally.
 */
export function beginElevationSegment(acc: ElevationAccumulator): ElevationAccumulator {
  return { reference: undefined, ascentM: acc.ascentM, descentM: acc.descentM };
}

/**
 * Cumulative ascent (D+) and descent (D-) from an elevation series.
 *
 * Raw GPS altitude is noisy: summing every tiny up/down would inflate D+ on a
 * dead-flat walk to hundreds of metres. We therefore use a hysteresis filter:
 * we keep a "reference" elevation and only commit a delta (to ascent or
 * descent) once the signed change from the reference exceeds `threshold`. When
 * we commit, the reference advances to the new elevation, so a sustained climb
 * is still counted in full while jitter under the threshold is ignored.
 *
 * `undefined` samples are skipped (they neither reset nor advance the
 * reference); a series with no defined samples yields zero gain/loss.
 */
export function elevationGainLoss(
  elevations: readonly (number | undefined)[],
  opts?: { threshold?: number },
): { ascentM: number; descentM: number } {
  const { ascentM, descentM } = accumulateElevationGainLoss(elevations, opts);
  return { ascentM, descentM };
}

interface ComputeOpts {
  elevationThresholdM?: number;
  /** Overrides the category's stop threshold (m/s); the result then carries no `movingModel`. */
  movingSpeedThresholdMps?: number;
  maxAccuracyM?: number;
  /** The trail's activity category: picks the moving-time stop threshold (#504). */
  category?: string | null;
  /**
   * Measure climb/descent on {@link climbElevations} — the trail's own
   * elevations unless they are terrain-lookup stepping noise (a Garmin
   * Connect course), then a smoothed profile — and stamp `climbModel`. Every
   * saved trail uses it; it is off by default only so the live recorder's
   * incremental hysteresis and its batch twin stay byte-identical.
   */
  robustClimb?: boolean;
}

/** The `movingModel` stamp for these options (none when the threshold is overridden). */
function movingModelOf(opts?: ComputeOpts): Pick<TrackStats, 'movingModel'> {
  return opts?.movingSpeedThresholdMps === undefined
    ? { movingModel: movingModelKey(opts?.category) }
    : {};
}

const emptyStats = (opts?: ComputeOpts): TrackStats => ({
  distanceM: 0,
  ascentM: 0,
  descentM: 0,
  durationS: 0,
  movingTimeS: 0,
  avgSpeedMps: 0,
  maxSpeedMps: 0,
  minAltitudeM: undefined,
  maxAltitudeM: undefined,
  bbox: undefined,
  pointCount: 0,
  ...movingModelOf(opts),
  ...(opts?.robustClimb ? { climbModel: CLIMB_MODEL_KEY } : {}),
});

/** Full statistics for an ordered series of track points. */
export function computeTrackStats(points: readonly TrackPoint[], opts?: ComputeOpts): TrackStats {
  const elevationThresholdM = opts?.elevationThresholdM ?? DEFAULT_ELEVATION_THRESHOLD_M;
  const movingSpeedThresholdMps =
    opts?.movingSpeedThresholdMps ?? movingProfileFor(opts?.category).stopSpeedMps;
  const maxAccuracyM = opts?.maxAccuracyM;

  // Optionally drop low-quality fixes before any math.
  const pts =
    maxAccuracyM === undefined
      ? points
      : points.filter((p) => p.accuracy === undefined || p.accuracy <= maxAccuracyM);

  if (pts.length === 0) return emptyStats(opts);

  let distanceM = 0;
  let firstTime: number | undefined;
  let lastTime: number | undefined;
  let maxSpeedMps = 0;
  let minAltitudeM: number | undefined;
  let maxAltitudeM: number | undefined;

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;

  const elevations: (number | undefined)[] = new Array(pts.length);

  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    elevations[i] = p.altitude;
    const hasTime = p.hasTime !== false && Number.isFinite(p.time);
    if (hasTime) {
      firstTime ??= p.time;
      lastTime = p.time;
    }

    if (p.latitude < minLat) minLat = p.latitude;
    if (p.latitude > maxLat) maxLat = p.latitude;
    if (p.longitude < minLng) minLng = p.longitude;
    if (p.longitude > maxLng) maxLng = p.longitude;

    if (p.altitude !== undefined && !Number.isNaN(p.altitude)) {
      if (minAltitudeM === undefined || p.altitude < minAltitudeM) minAltitudeM = p.altitude;
      if (maxAltitudeM === undefined || p.altitude > maxAltitudeM) maxAltitudeM = p.altitude;
    }

    if (i > 0) {
      const prev = pts[i - 1]!;
      const segDist = haversineMeters(prev, p);
      distanceM += segDist;
      const dt = (p.time - prev.time) / 1000;
      if (hasTime && prev.hasTime !== false && Number.isFinite(prev.time) && dt > 0) {
        const speed = segDist / dt;
        // dt<=0 segments are already excluded.
        if (speed > maxSpeedMps) maxSpeedMps = speed;
      }
    }
  }

  const { ascentM, descentM } = elevationGainLoss(
    opts?.robustClimb ? climbElevations(pts, elevationThresholdM) : elevations,
    { threshold: elevationThresholdM },
  );

  const durationS =
    firstTime !== undefined && lastTime !== undefined
      ? Math.max(0, (lastTime - firstTime) / 1000)
      : 0;
  // Sustained stops, stationary GPS drift and long fix gaps are not moving.
  const { movingTimeS, movingDistanceM } = computeMovingTime(pts, {
    stopSpeedMps: movingSpeedThresholdMps,
  });
  const avgSpeedMps = movingTimeS > 0 ? movingDistanceM / movingTimeS : 0;

  const bbox: BoundingBox = { minLat, minLng, maxLat, maxLng };

  return {
    distanceM,
    ascentM,
    descentM,
    durationS,
    movingTimeS,
    avgSpeedMps,
    maxSpeedMps,
    minAltitudeM,
    maxAltitudeM,
    bbox,
    pointCount: pts.length,
    ...movingModelOf(opts),
    ...(opts?.robustClimb ? { climbModel: CLIMB_MODEL_KEY } : {}),
  };
}

interface ReduceOpts {
  elevationThresholdM?: number;
  movingSpeedThresholdMps?: number;
}

/**
 * Fold a single new point into prior stats for the live recording HUD.
 *
 * APPROXIMATION for ascent/descent — read carefully. True D+/D- hysteresis
 * needs a running "reference" elevation that this function cannot persist (we
 * must not widen the `TrackStats` type). So per step we apply the threshold
 * between `prevPoint` and `next` directly: a single inter-point jump is
 * committed to ascent/descent only if it already exceeds the threshold. This
 * means a slow, sustained climb made of many sub-threshold steps would be
 * UNDER-counted if the caller relied on THIS function's own ascentM/descentM.
 *
 * The recorder store does not: it tracks elevation gain/loss separately via
 * {@link ElevationAccumulator} / {@link stepElevationGainLoss} (a real
 * persisted reference, exactly matching `computeTrackStats`'s hysteresis
 * incrementally) and overwrites this function's ascentM/descentM with that
 * accumulator's totals. Any other caller that folds points one at a time
 * should do the same rather than trust the fields below.
 *
 * For distance / duration / max speed this folding is exact. Moving time is
 * a live APPROXIMATION too: it uses the simple per-step speed rule, while the
 * saved trail's moving time comes from `computeMovingTime` (smoothed speed,
 * sustained stops, gaps — #504), recomputed in batch when recording stops.
 *
 * `prevPoint` is the previous point OF THE SAME SEGMENT. Passing `undefined`
 * on a track that already has points opens a new segment (a resume after a
 * pause): the point extends the bbox, altitude range and count, and nothing
 * else — no distance, time or speed bridges the pause.
 */
export function reduceStatsWith(
  prev: TrackStats,
  prevPoint: TrackPoint | undefined,
  next: TrackPoint,
  opts?: ReduceOpts,
): TrackStats {
  const elevationThresholdM = opts?.elevationThresholdM ?? DEFAULT_ELEVATION_THRESHOLD_M;
  const movingSpeedThresholdMps =
    opts?.movingSpeedThresholdMps ?? DEFAULT_MOVING_SPEED_THRESHOLD_MPS;

  // First point of a track.
  if (prev.pointCount === 0) {
    const alt =
      next.altitude !== undefined && !Number.isNaN(next.altitude) ? next.altitude : undefined;
    return {
      distanceM: 0,
      ascentM: 0,
      descentM: 0,
      durationS: 0,
      movingTimeS: 0,
      avgSpeedMps: 0,
      maxSpeedMps: 0,
      minAltitudeM: alt,
      maxAltitudeM: alt,
      bbox: {
        minLat: next.latitude,
        minLng: next.longitude,
        maxLat: next.latitude,
        maxLng: next.longitude,
      },
      pointCount: 1,
    };
  }

  // First point of a new segment: extend the extents only.
  if (prevPoint === undefined) {
    return {
      ...prev,
      ...extentsWith(prev, next),
      pointCount: prev.pointCount + 1,
    };
  }

  const segDist = haversineMeters(prevPoint, next);
  const distanceM = prev.distanceM + segDist;

  let movingTimeS = prev.movingTimeS;
  // Recover the moving-distance numerator from the prior average so the fold
  // also works after a background merge or checkpoint recovery computed in batch.
  let movingDistanceM = prev.avgSpeedMps * prev.movingTimeS;
  let maxSpeedMps = prev.maxSpeedMps;
  const dt = (next.time - prevPoint.time) / 1000;
  if (dt > 0) {
    const speed = segDist / dt;
    if (speed > maxSpeedMps) maxSpeedMps = speed;
    if (speed >= movingSpeedThresholdMps) {
      movingTimeS += dt;
      movingDistanceM += segDist;
    }
  }

  // Per-step hysteresis (see the doc comment caveat).
  let ascentM = prev.ascentM;
  let descentM = prev.descentM;
  if (
    prevPoint.altitude !== undefined &&
    !Number.isNaN(prevPoint.altitude) &&
    next.altitude !== undefined &&
    !Number.isNaN(next.altitude)
  ) {
    const delta = next.altitude - prevPoint.altitude;
    if (delta >= elevationThresholdM) ascentM += delta;
    else if (-delta >= elevationThresholdM) descentM += -delta;
  }

  // durationS grows from the recorded duration plus this step's wall time.
  const durationS = Math.max(0, prev.durationS + (next.time - prevPoint.time) / 1000);
  const avgSpeedMps = movingTimeS > 0 ? movingDistanceM / movingTimeS : 0;

  return {
    distanceM,
    ascentM,
    descentM,
    durationS,
    movingTimeS,
    avgSpeedMps,
    maxSpeedMps,
    ...extentsWith(prev, next),
    pointCount: prev.pointCount + 1,
  };
}

/** The altitude range and bbox of `prev` extended by one more point. */
function extentsWith(
  prev: TrackStats,
  next: TrackPoint,
): Pick<TrackStats, 'minAltitudeM' | 'maxAltitudeM' | 'bbox'> {
  let minAltitudeM = prev.minAltitudeM;
  let maxAltitudeM = prev.maxAltitudeM;
  if (next.altitude !== undefined && !Number.isNaN(next.altitude)) {
    if (minAltitudeM === undefined || next.altitude < minAltitudeM) minAltitudeM = next.altitude;
    if (maxAltitudeM === undefined || next.altitude > maxAltitudeM) maxAltitudeM = next.altitude;
  }

  const prevBbox = prev.bbox;
  const bbox: BoundingBox = prevBbox
    ? {
        minLat: Math.min(prevBbox.minLat, next.latitude),
        minLng: Math.min(prevBbox.minLng, next.longitude),
        maxLat: Math.max(prevBbox.maxLat, next.latitude),
        maxLng: Math.max(prevBbox.maxLng, next.longitude),
      }
    : {
        minLat: next.latitude,
        minLng: next.longitude,
        maxLat: next.latitude,
        maxLng: next.longitude,
      };
  return { minAltitudeM, maxAltitudeM, bbox };
}
export { averageHeartRate, buildChartSeries, heartRateBands, sampleIndexAt } from './chartSeries';
export type { ChartSeries, HeartRateBand } from './chartSeries';
