import { useCallback, useSyncExternalStore } from 'react';

import { floorToStep } from '@core/geo/weatherTimeline';

/**
 * "Now", floored to `stepMs`.
 *
 * Two things fall out of the flooring, and both matter:
 *
 *  - the value is STABLE between steps, so anything derived from it (the whole
 *    clock-guessed timeline, for one) keeps its identity instead of churning
 *    every render and re-triggering downstream fetches;
 *  - it still MOVES. A tab left open for an hour on a radar layer was
 *    otherwise stuck on the frame grid it was mounted with, quietly showing a
 *    stale "latest" frame. Stepping at the layer's own cadence is exactly when
 *    a new frame becomes available.
 *
 * `floorToStep` is `@core/geo/weatherTimeline`'s, so the grid this lands on is
 * the same grid the timeline is built against.
 *
 * `useSyncExternalStore` rather than `useState` + an effect: the wall clock IS
 * an external store, and this is the one hook that models it without a render
 * of stale value first. The snapshot is a plain number, so React's own
 * `Object.is` check means a poll that lands inside the same step re-renders
 * nothing.
 */
export function useNow(stepMs: number): number {
  const subscribe = useCallback(
    (onChange: () => void) => {
      // Poll well inside the step so the value lands soon after a boundary
      // rather than up to a whole step late.
      const id = window.setInterval(onChange, Math.max(1000, Math.min(stepMs / 4, 60_000)));
      return () => window.clearInterval(id);
    },
    [stepMs],
  );

  const getSnapshot = useCallback(() => floorToStep(Date.now(), stepMs), [stepMs]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
