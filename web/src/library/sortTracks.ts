import { paceSecPerKm } from '@core/library/filterTracks';
import type { TrackSummary } from '@core/models';

/**
 * Trail ordering.
 *
 * **This is a playground proposal, not a copy of the app.** The shipped Library
 * has no sort at all: `libraryStore` prepends on add, so the list is insertion
 * order, which reads as newest-first and is the only order that exists. That is
 * fine at ten trails and stops being fine at a hundred — "which of these was
 * the longest?" currently has no answer short of scrolling.
 *
 * The comparators live here rather than in `@core/library` because `@core`
 * requires a co-located test file and its own coverage gate; if this survives
 * the review it should move to `@core/library/sortTracks.ts` with tests, and
 * the app should adopt it unchanged. `paceSecPerKm` is already `@core`'s and is
 * reused rather than re-derived, so "fastest" here means exactly what
 * "fastest" means to the filter.
 */

export type SortKey = 'recent' | 'oldest' | 'distance' | 'ascent' | 'duration' | 'pace' | 'name';

export const SORTS: readonly { key: SortKey; label: string }[] = [
  { key: 'recent', label: 'Newest' },
  { key: 'oldest', label: 'Oldest' },
  { key: 'distance', label: 'Longest' },
  { key: 'ascent', label: 'Most D+' },
  { key: 'duration', label: 'Longest time' },
  { key: 'pace', label: 'Fastest pace' },
  { key: 'name', label: 'Name A–Z' },
];

export const isSortKey = (v: string): v is SortKey => SORTS.some((s) => s.key === v);

/**
 * Sort a copy of the list. Untimed navigation trails have no pace, and are
 * pushed to the end of the pace ordering instead of being treated as infinitely
 * fast — the same "an unknowable value never matches" instinct the filter's
 * `inRange` applies.
 */
export function sortTracks<T extends TrackSummary>(tracks: readonly T[], key: SortKey): T[] {
  const out = [...tracks];
  switch (key) {
    case 'recent':
      return out.sort((a, b) => b.startedAt - a.startedAt);
    case 'oldest':
      return out.sort((a, b) => a.startedAt - b.startedAt);
    case 'distance':
      return out.sort((a, b) => b.stats.distanceM - a.stats.distanceM);
    case 'ascent':
      return out.sort((a, b) => b.stats.ascentM - a.stats.ascentM);
    case 'duration':
      return out.sort((a, b) => b.stats.durationS - a.stats.durationS);
    case 'pace':
      return out.sort((a, b) => {
        const pa = paceSecPerKm(a.stats);
        const pb = paceSecPerKm(b.stats);
        if (pa === null) return pb === null ? 0 : 1;
        if (pb === null) return -1;
        return pa - pb;
      });
    case 'name':
      return out.sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));
  }
}
