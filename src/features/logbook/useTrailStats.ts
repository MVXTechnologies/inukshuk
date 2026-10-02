import type { TrailStatsSummary } from '@core/stats/trailSummary';
import { getTrailStatsStore, type TrailStatsProgress } from '@data/trailStatsStore';
import { useLibraryStore } from '@state/libraryStore';
import { useEffect, useSyncExternalStore } from 'react';

/** Delay before a sync starts, so a screen's first frame never waits on it. */
const SYNC_DELAY_MS = 250;

/**
 * Keep the per-trail statistics cache in step with the library (a no-op when
 * it already is): new, edited or never-summarised trails are computed in the
 * background (see `@data/trailStatsStore`). The Logbook tab mounts this so a
 * first-run backfill is usually done before Statistics is opened.
 */
export function useTrailStatsBackfill(): void {
  const tracks = useLibraryStore((s) => s.tracks);
  const hydrated = useLibraryStore((s) => s.hydrated);
  useEffect(() => {
    if (!hydrated) return;
    const timer = setTimeout(() => getTrailStatsStore().sync(tracks), SYNC_DELAY_MS);
    return () => clearTimeout(timer);
  }, [tracks, hydrated]);
}

/** The cached summaries (by trail id) and the backfill's progress. */
export function useTrailStats(): {
  summaries: ReadonlyMap<string, TrailStatsSummary>;
  progress: TrailStatsProgress;
} {
  useTrailStatsBackfill();
  const store = getTrailStatsStore();
  const summaries = useSyncExternalStore(
    (l) => store.subscribe(l),
    () => store.summaries(),
  );
  const progress = useSyncExternalStore(
    (l) => store.subscribe(l),
    () => store.progress(),
  );
  return { summaries, progress };
}
