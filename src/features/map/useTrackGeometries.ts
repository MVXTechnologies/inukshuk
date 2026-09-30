import type { TrackSummary } from '@core/models';
import { loadTrackGeometry, peekTrackGeometry } from '@data/trackGeometry';
import { useEffect, useRef, useState } from 'react';

/**
 * Loads the simplified geometry (see `@data/trackGeometry`) of every trail in
 * `ids` and returns a version number that changes when newly loaded ones are
 * ready to read with `peekTrackGeometry`.
 *
 * The version is bumped in batches, never once per trail (#465): each bump
 * re-runs the caller's whole-library memos (heat grid, line source), so with
 * 400 trails a per-trail bump meant 400 full rebuilds and 400 GeoJSON
 * re-uploads. A batch flushes when the trails loaded since the last flush at
 * least match those already shown (so the number of rebuilds grows with
 * log(n) and their total cost stays linear), when {@link FLUSH_MAX_MS} has
 * passed with something new (a cold first load still shows progress), and
 * at the end of the run.
 */

/** Longest a loaded trail waits to be shown. */
export const FLUSH_MAX_MS = 2000;
/** Smallest batch (below this, a flush waits for time or the end). */
export const FLUSH_MIN_BATCH = 8;

const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export function useTrackGeometries(
  tracksById: ReadonlyMap<string, TrackSummary>,
  ids: readonly string[],
): number {
  const [version, setVersion] = useState(0);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const key = ids.join('|');

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    (async () => {
      let shown = 0;
      let pending = 0;
      let lastFlush = Date.now();
      const flush = () => {
        shown += pending;
        pending = 0;
        lastFlush = Date.now();
        setVersion((v) => v + 1);
      };
      for (const id of ids) {
        if (cancelled) return;
        const t = tracksById.get(id);
        if (!t) continue;
        if (peekTrackGeometry(t) !== undefined) {
          shown++;
          continue;
        }
        await loadTrackGeometry(t);
        if (cancelled) {
          // The caller's inputs changed mid-load and its memos already re-ran
          // without this trail: a newer run will skip it as loaded, so say so.
          if (mounted.current) setVersion((v) => v + 1);
          return;
        }
        pending++;
        if (
          (pending >= FLUSH_MIN_BATCH && pending >= shown) ||
          Date.now() - lastFlush >= FLUSH_MAX_MS
        ) {
          flush();
        }
        // A cached load resolves without touching the JS event loop; yield so
        // a long run never blocks touches.
        await yieldToUi();
      }
      if (pending > 0 && !cancelled) flush();
    })();
    return () => {
      cancelled = true;
    };
    // `key` is the joined ids — callers rebuild the array on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tracksById]);

  return version;
}

/** Id → trail lookup, for hot paths that used `tracks.find` per id. */
export function indexTracks(tracks: readonly TrackSummary[]): Map<string, TrackSummary> {
  const byId = new Map<string, TrackSummary>();
  for (const t of tracks) byId.set(t.id, t);
  return byId;
}
