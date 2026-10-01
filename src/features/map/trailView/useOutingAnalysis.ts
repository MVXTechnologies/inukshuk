import { analyzeOuting, type OutingAnalysis } from '@core/geo/track';
import type { TrackPoint } from '@core/models';
import { useEffect, useState } from 'react';

/**
 * The trail view's derived data (#511): splits, stops, steepest stretch,
 * high point and the distance axis — computed ONCE per track and point set,
 * when the JS thread is next idle (after the screen's opening transition),
 * never during render.
 *
 * Like the lazy moving-time upgrade (#504), nothing is computed for the
 * library up front: a trail's analysis exists only once it is opened. It is
 * kept in a small in-memory cache keyed by the trail and what it was computed
 * from, so going back and reopening a trail (or flipping tabs, which remount
 * nothing here) is instant. Every pass is O(n): ~tens of ms for 50k points.
 */
const CACHE_MAX = 6;
const cache = new Map<string, OutingAnalysis>();

/** Test hook: forget every cached analysis. */
export function clearOutingAnalysisCache(): void {
  cache.clear();
}

function remember(key: string, value: OutingAnalysis): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export interface OutingAnalysisInput {
  /** Identifies the trail (and its file revision): the cache key's root. */
  cacheKey: string | null;
  points: readonly TrackPoint[] | null;
  segmentStarts: readonly number[];
  category?: string | null;
  splitUnitM: number;
}

export function useOutingAnalysis({
  cacheKey,
  points,
  segmentStarts,
  category,
  splitUnitM,
}: OutingAnalysisInput): OutingAnalysis | null {
  const key =
    cacheKey && points
      ? `${cacheKey}|${points.length}|${segmentStarts.join(',')}|${category ?? ''}|${splitUnitM}`
      : null;
  const [state, setState] = useState<{ key: string; value: OutingAnalysis } | null>(null);
  const cached = key ? cache.get(key) : undefined;

  useEffect(() => {
    if (!key || !points || cache.has(key)) return;
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      const value = analyzeOuting(points, { segmentStarts, category, splitUnitM });
      remember(key, value);
      setState({ key, value });
    };
    // When the JS thread is idle (the opening transition has run), within 500 ms.
    if (typeof requestIdleCallback === 'function') {
      const id = requestIdleCallback(run, { timeout: 500 });
      return () => {
        cancelled = true;
        cancelIdleCallback(id);
      };
    }
    const id = setTimeout(run, 0);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [key, points, segmentStarts, category, splitUnitM]);

  if (cached) return cached;
  return state && state.key === key ? state.value : null;
}
