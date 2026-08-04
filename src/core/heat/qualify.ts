import { isPerformedActivity } from '@core/dashboard/aggregate';
import type { TrackSummary } from '@core/models';

/**
 * Which trails count toward the global heatmap/tap index. Coordinator's
 * rule, verbatim: "every trail which has a time attached to it (or not in
 * the navigation category)" — i.e. the baseline is
 * {@link isPerformedActivity} (category !== 'navigation'), OR'd with a real
 * timing signal (`stats.durationS > 0`) so a track qualifies even if its
 * category situation is odd. Untimed navigation-category routes stay
 * excluded, exactly as before.
 */
export function qualifiesForHeat(
  track: Pick<TrackSummary, 'category'> & { stats: Pick<TrackSummary['stats'], 'durationS'> },
): boolean {
  return isPerformedActivity(track) || track.stats.durationS > 0;
}
