import type { TrackStats, TrackSummary } from '@core/models';

/**
 * Pure filtering for the Library's trail list. The UI builds a
 * {@link TrackFilter} (all criteria optional) and the predicate here decides
 * which saved trails match; an empty filter matches everything.
 */

/** Inclusive numeric range; either bound may be omitted (open-ended). */
export interface NumericRange {
  min?: number;
  max?: number;
}

/** Sentinel category id matching tracks that have no category. */
export const UNCATEGORIZED = '__uncategorized__';

/** All criteria a Library filter can apply. Every field optional = inactive. */
export interface TrackFilter {
  /** Total distance, metres. */
  distanceM?: NumericRange;
  /** Wall-clock duration, seconds. */
  durationS?: NumericRange;
  /** Elevation gain (D+), metres. */
  ascentM?: NumericRange;
  /** Recording start time, epoch milliseconds. */
  startedAt?: NumericRange;
  /** Average pace, seconds per kilometre (see {@link paceSecPerKm}). */
  paceSecPerKm?: NumericRange;
  /**
   * Category ids to keep (multi-select, OR semantics). Include
   * {@link UNCATEGORIZED} to match tracks without a category. An empty array
   * counts as inactive (no category constraint), not "match nothing".
   */
  categories?: readonly string[];
}

/**
 * A trail's average pace in seconds per kilometre. Prefers the stored moving
 * average speed; derives from distance over moving (then total) time when the
 * summary predates `avgSpeedMps` or stored it as 0. Null when no positive,
 * finite pace can be derived (e.g. zero-distance tracks).
 */
export function paceSecPerKm(stats: TrackStats): number | null {
  const speed =
    stats.avgSpeedMps > 0
      ? stats.avgSpeedMps
      : stats.movingTimeS > 0
        ? stats.distanceM / stats.movingTimeS
        : stats.durationS > 0
          ? stats.distanceM / stats.durationS
          : 0;
  if (!Number.isFinite(speed) || speed <= 0) return null;
  return 1000 / speed;
}

function rangeActive(range: NumericRange | undefined): range is NumericRange {
  return range !== undefined && (range.min !== undefined || range.max !== undefined);
}

/**
 * Inclusive range test. An inactive range matches everything; an active range
 * never matches a missing (null/non-finite) value — filtering by pace must not
 * surface tracks whose pace is unknowable.
 */
function inRange(value: number | null, range: NumericRange | undefined): boolean {
  if (!rangeActive(range)) return true;
  if (value === null || !Number.isFinite(value)) return false;
  if (range.min !== undefined && value < range.min) return false;
  if (range.max !== undefined && value > range.max) return false;
  return true;
}

/** Number of active criteria (for the filter icon's badge). */
export function countActiveFilters(filter: TrackFilter): number {
  let n = 0;
  if (rangeActive(filter.distanceM)) n++;
  if (rangeActive(filter.durationS)) n++;
  if (rangeActive(filter.ascentM)) n++;
  if (rangeActive(filter.startedAt)) n++;
  if (rangeActive(filter.paceSecPerKm)) n++;
  if (filter.categories !== undefined && filter.categories.length > 0) n++;
  return n;
}

/** True when at least one criterion is active. */
export function hasActiveFilters(filter: TrackFilter): boolean {
  return countActiveFilters(filter) > 0;
}

/** Does one saved trail match every active criterion? */
export function matchesFilter(track: TrackSummary, filter: TrackFilter): boolean {
  const s = track.stats;
  if (!inRange(s.distanceM, filter.distanceM)) return false;
  if (!inRange(s.durationS, filter.durationS)) return false;
  if (!inRange(s.ascentM, filter.ascentM)) return false;
  if (!inRange(track.startedAt, filter.startedAt)) return false;
  if (!inRange(paceSecPerKm(s), filter.paceSecPerKm)) return false;
  if (filter.categories !== undefined && filter.categories.length > 0) {
    const id = typeof track.category === 'string' && track.category !== '' ? track.category : null;
    const match =
      id === null ? filter.categories.includes(UNCATEGORIZED) : filter.categories.includes(id);
    if (!match) return false;
  }
  return true;
}

/**
 * Apply a filter to the trail list, preserving order. With no active criteria
 * the input array is returned as-is (stable identity for memoized consumers).
 *
 * Generic OVER `TrackSummary` rather than typed ON it: a caller holding a
 * richer trail type (the web playground's `WebTrack`, which adds a preview
 * polyline and a colour) gets its own element type back instead of a widened
 * `TrackSummary` it then has to recover through an id map.
 */
export function filterTracks<T extends TrackSummary>(
  tracks: readonly T[],
  filter: TrackFilter,
): readonly T[] {
  if (!hasActiveFilters(filter)) return tracks;
  return tracks.filter((t) => matchesFilter(t, filter));
}
