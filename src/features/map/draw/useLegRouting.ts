import {
  capResults,
  legViews,
  pendingLegs,
  withoutFailures,
  type LegMode,
  type LegRequest,
  type LegResult,
} from '@core/draw/legs';
import type { LngLat } from '@core/models';
import { routeLeg } from '@data/routing';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Snapping the drawn route's Trails/Roads legs (#515): every leg the editor
 * holds that has no answer yet is asked of the routing proxy, debounced
 * behind the last edit and ONE AT A TIME (the Worker paces the public engines
 * to a request a second; a burst would only queue there).
 *
 * Results are keyed by leg (`@core/draw/legs`), so an edit only asks for the
 * legs it changed and Undo finds earlier ones already answered. A failure is
 * kept as a result (the leg is drawn straight with a warning) until `retry`.
 */

/** Answers kept for undo and re-edits; old ones beyond this are forgotten. */
const MAX_RESULTS = 400;

export interface LegRouting {
  results: ReadonlyMap<string, LegResult>;
  /** Ask again for every failed leg of the current route. */
  retry: () => void;
  /** Answers known without asking (a saved route's line, when editing it). */
  seed: (results: ReadonlyMap<string, LegResult>) => void;
}

type Route = (mode: LegMode, from: LngLat, to: LngLat) => Promise<LegResult>;

export function useLegRouting(
  vertices: readonly LngLat[],
  modes: readonly LegMode[],
  enabled: boolean,
  { debounceMs = 350, route = routeLeg }: { debounceMs?: number; route?: Route } = {},
): LegRouting {
  const [results, setResults] = useState<ReadonlyMap<string, LegResult>>(() => new Map());
  const asked = useRef(new Set<string>());
  const queue = useRef<LegRequest[]>([]);
  const running = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const drain = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      for (let leg = queue.current.shift(); leg !== undefined; leg = queue.current.shift()) {
        const { key, mode, from, to } = leg;
        const result = await route(mode, from, to).catch((): LegResult => ({
          status: 'failed',
          reason: 'error',
        }));
        asked.current.delete(key);
        if (!alive.current) return;
        setResults((prev) => capResults(new Map(prev).set(key, result), MAX_RESULTS));
      }
    } finally {
      running.current = false;
    }
  }, [route]);

  useEffect(() => {
    if (!enabled) return;
    const needed = pendingLegs(legViews(vertices, modes, results)).filter(
      (p) => !asked.current.has(p.key),
    );
    if (needed.length === 0) return;
    const t = setTimeout(() => {
      for (const leg of needed) {
        asked.current.add(leg.key);
        queue.current.push(leg);
      }
      void drain();
    }, debounceMs);
    return () => clearTimeout(t);
  }, [vertices, modes, results, enabled, debounceMs, drain]);

  // A queued leg the route no longer has must not hold its "asked" mark.
  useEffect(() => {
    const live = new Set(pendingLegs(legViews(vertices, modes, results)).map((p) => p.key));
    queue.current = queue.current.filter((q) => {
      if (live.has(q.key)) return true;
      asked.current.delete(q.key);
      return false;
    });
  }, [vertices, modes, results]);

  const retry = useCallback(() => {
    setResults((prev) => withoutFailures(prev, legViews(vertices, modes, prev)));
  }, [vertices, modes]);

  const seed = useCallback((known: ReadonlyMap<string, LegResult>) => {
    if (known.size === 0) return;
    setResults((prev) => capResults(new Map([...prev, ...known]), MAX_RESULTS));
  }, []);

  return { results, retry, seed };
}
