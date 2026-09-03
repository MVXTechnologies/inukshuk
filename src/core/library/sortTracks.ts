import type { TrackStats, TrackSummary } from '@core/models';
import { paceSecPerKm } from './filterTracks';

/**
 * Pure ordering for the Library's trail list.
 *
 * The index itself is insertion-ordered (`libraryStore` prepends on add), which
 * reads as newest-first and used to be the only order that existed. That is
 * fine at ten trails and stops being fine at a hundred — "which of these was
 * the longest?" had no answer short of scrolling. The comparators live here,
 * beside `filterTracks`, so "fastest" means exactly what it means to the
 * filter: both call the same {@link paceSecPerKm}.
 *
 * The Library composes the three pure passes in this order:
 * `filterTracks` → `sortTracks` → `groupByFolder`. Sorting before grouping is
 * what makes the order apply *within* each folder while the folders themselves
 * stay in their user-defined order.
 */

/** Orderings offered by the Library's "Filter & sort" panel. */
export type SortKey = 'recent' | 'oldest' | 'distance' | 'ascent' | 'duration' | 'pace' | 'name';

/** The order the list has always had (insertion order ≈ newest first). */
export const DEFAULT_SORT: SortKey = 'recent';

/** Sort options in menu order, with their user-facing labels. */
export const SORTS: readonly { key: SortKey; label: string }[] = [
  { key: 'recent', label: 'Newest' },
  { key: 'oldest', label: 'Oldest' },
  { key: 'distance', label: 'Longest' },
  { key: 'ascent', label: 'Most D+' },
  { key: 'duration', label: 'Longest time' },
  { key: 'pace', label: 'Fastest pace' },
  { key: 'name', label: 'Name A–Z' },
];

/** Type guard for a persisted / hydrated sort key (junk → false). */
export function isSortKey(value: unknown): value is SortKey {
  return typeof value === 'string' && SORTS.some((s) => s.key === value);
}

/**
 * Collation for the by-name ordering. An explicit locale (rather than the
 * host default) keeps the order identical on every device and in tests;
 * `base` sensitivity folds case and accents together — "Éboulis" belongs next
 * to "Eboulis", not after "Zec" — and `numeric` puts "Sentier 2" before
 * "Sentier 10".
 */
const NAME_LOCALE = 'fr';
const NAME_COLLATION: Intl.CollatorOptions = { sensitivity: 'base', numeric: true };

/**
 * A track's value for one sort key, or `null` when it cannot be known: a
 * missing/NaN stat, a track imported without timings, an unnamed one. Nulls
 * never participate in the comparison — see {@link nullsLast}.
 */
type Rank<R> = (track: TrackSummary) => R | null;

/** Finite numbers only: `undefined`, `null` and NaN all read as unknown. */
function finite(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Read one stat defensively. `TrackStats` is non-optional in the type, but a
 * hand-edited or downgraded `library.json` can hydrate a track whose `stats`
 * object is missing entirely; sorting must never be the thing that throws.
 */
function stat(track: TrackSummary, pick: (s: TrackStats) => number | undefined): number | null {
  const stats: TrackStats | undefined = track.stats;
  return stats === undefined || stats === null ? null : finite(pick(stats));
}

/**
 * Wrap a rank + comparison into a comparator that always pushes unknown values
 * to the **end of the list, in both directions** — the same "an unknowable
 * value never matches" instinct `filterTracks.inRange` applies. A trail with
 * no recorded distance is not the shortest trail, and reversing the order must
 * not promote it to the top; it stays parked at the bottom either way, and
 * ties among such trails fall through to the stable index tiebreak.
 */
function nullsLast<R>(rank: Rank<R>, compare: (a: R, b: R) => number) {
  return (a: TrackSummary, b: TrackSummary): number => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra === null) return rb === null ? 0 : 1;
    if (rb === null) return -1;
    return compare(ra, rb);
  };
}

const ascending = (a: number, b: number): number => a - b;
const descending = (a: number, b: number): number => b - a;

/** The comparator for one sort key (ignoring stability, added by the caller). */
function comparatorFor(key: SortKey): (a: TrackSummary, b: TrackSummary) => number {
  switch (key) {
    case 'recent':
      return nullsLast((t) => finite(t.startedAt), descending);
    case 'oldest':
      return nullsLast((t) => finite(t.startedAt), ascending);
    case 'distance':
      return nullsLast((t) => stat(t, (s) => s.distanceM), descending);
    case 'ascent':
      return nullsLast((t) => stat(t, (s) => s.ascentM), descending);
    case 'duration':
      return nullsLast((t) => stat(t, (s) => s.durationS), descending);
    case 'pace':
      // Lower s/km = faster. Untimed navigation trails have no pace and are
      // parked at the end rather than treated as infinitely fast.
      return nullsLast((t) => {
        const stats: TrackStats | undefined = t.stats;
        return stats === undefined || stats === null ? null : paceSecPerKm(stats);
      }, ascending);
    case 'name':
      return nullsLast(
        (t) => (typeof t.name === 'string' && t.name.trim() !== '' ? t.name : null),
        (a, b) => a.localeCompare(b, NAME_LOCALE, NAME_COLLATION),
      );
  }
}

/**
 * Order a copy of the trail list. **Stable**: trails whose sort value ties keep
 * their incoming order, which is the library's insertion order — so "Most D+"
 * over a fresh import does not shuffle the flat trails against each other. The
 * index tiebreak is explicit rather than leaning on `Array.prototype.sort`
 * being stable, so the guarantee holds on any engine.
 *
 * Generic OVER `TrackSummary` for the same reason as `filterTracks` and
 * `groupByFolder`: a caller holding a richer trail type gets its own element
 * type back, so the three passes compose without a widening round-trip.
 */
export function sortTracks<T extends TrackSummary>(
  tracks: readonly T[],
  key: SortKey,
): readonly T[] {
  const compare = comparatorFor(key);
  const decorated = tracks.map((track, index) => ({ track, index }));
  decorated.sort((a, b) => {
    const cmp = compare(a.track, b.track);
    return cmp !== 0 ? cmp : a.index - b.index;
  });
  return decorated.map((d) => d.track);
}
