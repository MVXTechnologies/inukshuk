import {
  planRouteElevation,
  routeElevationFromTiles,
  type RouteElevation,
  type RouteElevationPlan,
} from '@core/draw/elevation';
import type { LngLat } from '@core/models';
import { tileKeyId, type DemTile } from '@core/trails/climb';
import { fetchDemTile } from '@features/map/dem';
import { useEffect, useRef, useState } from 'react';

/**
 * Climb and descent along the route being drawn (#502), from our DEM tiles —
 * `@core/draw/elevation` for the rules.
 *
 * Never blocks a gesture: the computation is debounced behind the last edit,
 * runs async with a yield between tile decodes (each tile is a PNG decoded on
 * the JS thread), and a newer edit simply supersedes an older run. Decoded
 * tiles stay in a small in-memory cache, so dragging a point around the same
 * valley re-reads nothing; the on-disk tile cache is the 3D view's.
 *
 * `unavailable` = too long for the tile budget, offline with nothing cached,
 * or a decode failure: the bar then shows no climb rather than a guess, and
 * the route still saves (without elevation).
 */

export type RouteElevationState =
  | { status: 'idle' }
  | { status: 'computing'; previous: RouteElevationResult | null }
  | { status: 'done'; result: RouteElevationResult }
  | { status: 'unavailable' };

export interface RouteElevationResult {
  /** The vertices this was computed for (the save path checks it is current). */
  vertices: readonly LngLat[];
  plan: RouteElevationPlan;
  elevation: RouteElevation;
}

const TILE_CACHE_MAX = 64;
const tileCache = new Map<string, DemTile>();
const PARALLEL = 4;

const yieldToUi = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function loadTiles(plan: RouteElevationPlan, alive: () => boolean) {
  const tiles = new Map<string, DemTile>();
  const queue = plan.tiles.filter((t) => {
    const hit = tileCache.get(tileKeyId(t));
    if (hit === undefined) return true;
    tiles.set(tileKeyId(t), hit);
    // Refresh its recency.
    tileCache.delete(tileKeyId(t));
    tileCache.set(tileKeyId(t), hit);
    return false;
  });
  const worker = async () => {
    for (let key = queue.shift(); key !== undefined && alive(); key = queue.shift()) {
      try {
        const tile: DemTile = { size: 256, data: await fetchDemTile(key.z, key.x, key.y) };
        tiles.set(tileKeyId(key), tile);
        tileCache.set(tileKeyId(key), tile);
        while (tileCache.size > TILE_CACHE_MAX) {
          const oldest = tileCache.keys().next().value;
          if (oldest === undefined) break;
          tileCache.delete(oldest);
        }
      } catch {
        // A missing tile leaves its samples undefined; the rest still count.
      }
      await yieldToUi();
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  return tiles;
}

/**
 * One elevation computation for `vertices` (also the save path's fallback
 * when the debounced one has not caught up). Null when unavailable.
 */
export async function computeRouteElevation(
  vertices: readonly LngLat[],
  alive: () => boolean = () => true,
): Promise<RouteElevationResult | null> {
  const plan = planRouteElevation(vertices);
  if (plan === null) return null;
  const tiles = await loadTiles(plan, alive);
  if (!alive()) return null;
  // Mostly-missing tiles would read as a cliff: no number beats a wrong one.
  if (tiles.size < plan.tiles.length * 0.9) return null;
  const elevation = routeElevationFromTiles(plan, tiles);
  return elevation === null ? null : { vertices, plan, elevation };
}

export function useRouteElevation(
  vertices: readonly LngLat[],
  enabled: boolean,
  debounceMs = 350,
): RouteElevationState {
  const [state, setState] = useState<RouteElevationState>({ status: 'idle' });
  const lastDone = useRef<RouteElevationResult | null>(null);

  useEffect(() => {
    if (!enabled || vertices.length < 2) {
      const t = setTimeout(() => setState({ status: 'idle' }), 0);
      return () => clearTimeout(t);
    }
    let alive = true;
    const start = setTimeout(() => {
      setState({ status: 'computing', previous: lastDone.current });
      void computeRouteElevation(vertices, () => alive)
        .catch(() => null)
        .then((result) => {
          if (!alive) return;
          if (result === null) {
            setState({ status: 'unavailable' });
            return;
          }
          lastDone.current = result;
          setState({ status: 'done', result });
        });
    }, debounceMs);
    return () => {
      alive = false;
      clearTimeout(start);
    };
  }, [vertices, enabled, debounceMs]);

  return state;
}

/** The latest numbers to show: the finished result, or the previous one while recomputing. */
export function shownElevation(state: RouteElevationState): RouteElevationResult | null {
  if (state.status === 'done') return state.result;
  if (state.status === 'computing') return state.previous;
  return null;
}
