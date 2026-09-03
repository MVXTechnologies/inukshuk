import type { TrackStats, TrackSummary } from '@core/models';

/**
 * Lifetime ("all time") aggregation over the library's track summaries — the
 * running total the period graph in `aggregate.ts` deliberately does not show,
 * because every bucket there is windowed to 7d/3m/1y.
 *
 * Same defensive instinct as `sortTracks`: an unknown value contributes
 * NOTHING and never poisons a total. A track whose `stats` object is missing
 * entirely (a hand-edited or downgraded `library.json`), or whose distance is
 * NaN, still counts as an outing — it happened — but adds 0 metres rather than
 * turning every total on the screen into "NaN km".
 */

/** One category's slice of the lifetime totals. */
export interface CategoryTotals {
  /** Raw `track.category`, or `null` for uncategorized trails. */
  categoryId: string | null;
  /** Number of trails in this category. */
  outings: number;
  distanceM: number;
  /** Sum of `stats.movingTimeS`. */
  movingTimeS: number;
  /** Sum of `stats.durationS` (wall clock, including stops). */
  durationS: number;
  /** Sum of `stats.ascentM` (D+). */
  ascentM: number;
}

/** Lifetime totals plus their per-category breakdown. */
export interface LifetimeTotals {
  /** Number of trails aggregated (every input track, known stats or not). */
  outings: number;
  distanceM: number;
  movingTimeS: number;
  durationS: number;
  ascentM: number;
  /**
   * One entry per category present in the input, ordered by distance
   * descending, then outings descending, then category id — a stable order
   * that does not depend on the library's insertion order.
   */
  byCategory: CategoryTotals[];
}

/** Finite numbers only: `undefined`, `null`, NaN and ±Infinity read as 0. */
function finite(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Read one stat defensively; a track with no `stats` object contributes 0. */
function stat(track: TrackSummary, pick: (s: TrackStats) => number | undefined): number {
  const stats: TrackStats | undefined = track.stats;
  return stats === undefined || stats === null ? 0 : finite(pick(stats));
}

/** A track's category id, normalized: absent or empty string = uncategorized. */
function categoryOf(track: TrackSummary): string | null {
  return typeof track.category === 'string' && track.category !== '' ? track.category : null;
}

/** The zero totals — what an empty library aggregates to. */
function empty(categoryId: string | null): CategoryTotals {
  return { categoryId, outings: 0, distanceM: 0, movingTimeS: 0, durationS: 0, ascentM: 0 };
}

function accumulate(into: CategoryTotals, track: TrackSummary): void {
  into.outings += 1;
  into.distanceM += stat(track, (s) => s.distanceM);
  into.movingTimeS += stat(track, (s) => s.movingTimeS);
  into.durationS += stat(track, (s) => s.durationS);
  into.ascentM += stat(track, (s) => s.ascentM);
}

/**
 * Total distance, time and elevation gain over the whole input, with a
 * per-category breakdown. The caller decides WHAT is a lifetime activity —
 * pass the list already narrowed by `matchesCategoryFilter`, which is what
 * keeps untimed navigation routes (plans, not outings) out of the totals.
 *
 * Empty input gives all-zero totals and an empty breakdown, so callers can
 * render the shape unconditionally.
 */
export function lifetimeTotals(tracks: readonly TrackSummary[]): LifetimeTotals {
  const overall = empty(null);
  const perCategory = new Map<string | null, CategoryTotals>();

  for (const track of tracks) {
    accumulate(overall, track);
    const id = categoryOf(track);
    let bucket = perCategory.get(id);
    if (bucket === undefined) {
      bucket = empty(id);
      perCategory.set(id, bucket);
    }
    accumulate(bucket, track);
  }

  const byCategory = [...perCategory.values()].sort(
    (a, b) =>
      b.distanceM - a.distanceM ||
      b.outings - a.outings ||
      (a.categoryId ?? '').localeCompare(b.categoryId ?? ''),
  );

  return {
    outings: overall.outings,
    distanceM: overall.distanceM,
    movingTimeS: overall.movingTimeS,
    durationS: overall.durationS,
    ascentM: overall.ascentM,
    byCategory,
  };
}
