import type { TrackPoint, TrackStats } from '@core/models';
import { CLIMB_MODEL_KEY } from './elevationSmoothing';
import { computeSegmentedTrackStats, type SegmentStarts } from './segments';

/**
 * Lazy climb upgrade, the twin of `refreshMovingStats`. Trails saved before
 * the saved-trail climb rule (`climbElevations`) carry no `climbModel` stamp
 * — among them every Garmin Connect course imported with a D+ inflated by
 * terrain-lookup stepping. The trail viewer, which loads the points anyway,
 * calls this and persists the result, so the Library, Logbook and dashboard
 * pick the corrected climb up without a library-wide pass at launch.
 *
 * Returns the stored stats with ONLY `ascentM`, `descentM` and `climbModel`
 * replaced, or null when nothing should change: the stamp is current, or
 * `points` is not the list these stats were computed from (a count mismatch,
 * e.g. the pre-trim points still on screen while the trimmed file loads).
 * Drawn routes are the caller's to skip: their climb is the drawing tool's.
 */
export function refreshClimbStats(
  stats: TrackStats,
  points: readonly TrackPoint[],
  segmentStarts: SegmentStarts,
): TrackStats | null {
  if (stats.climbModel === CLIMB_MODEL_KEY) return null;
  if (points.length !== stats.pointCount) return null;
  const fresh = computeSegmentedTrackStats(points, segmentStarts, { robustClimb: true });
  return {
    ...stats,
    ascentM: fresh.ascentM,
    descentM: fresh.descentM,
    climbModel: CLIMB_MODEL_KEY,
  };
}
