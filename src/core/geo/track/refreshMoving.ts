import type { TrackPoint, TrackStats } from '@core/models';
import { hasCurrentMovingStats } from './movingTime';
import { computeSegmentedTrackStats, type SegmentStarts } from './segments';

/**
 * Lazy moving-time upgrade (#504). Trails saved before the moving-time
 * algorithm (or re-filed under a category with another stop threshold) carry
 * a stale `movingModel`. Rather than re-reading every GPX at launch, the trail
 * viewer — which loads the points anyway — calls this and persists the result.
 *
 * Returns the stored stats with ONLY the moving fields (`movingTimeS`,
 * `avgSpeedMps`, `movingModel`) replaced, or null when nothing should change:
 * the stamp is current, or `points` is not the point list these stats were
 * computed from (a count mismatch — e.g. the pre-trim points still on screen
 * while the trimmed file loads), so a stale list can never be stamped current.
 */
export function refreshMovingStats(
  stats: TrackStats,
  category: string | null | undefined,
  points: readonly TrackPoint[],
  segmentStarts: SegmentStarts,
): TrackStats | null {
  if (hasCurrentMovingStats(stats, category)) return null;
  if (points.length !== stats.pointCount) return null;
  const fresh = computeSegmentedTrackStats(points, segmentStarts, { category });
  return {
    ...stats,
    movingTimeS: fresh.movingTimeS,
    avgSpeedMps: fresh.avgSpeedMps,
    ...(fresh.movingModel !== undefined ? { movingModel: fresh.movingModel } : {}),
  };
}
