import { resampleLine } from '@core/trails/geometry';
import {
  CLIMB_STEP_M,
  climbFromTiles,
  planClimb,
  tileKeyId,
  type DemTile,
} from '@core/trails/climb';
import type { TrailDetail } from '@core/trails/schema';
import { fetchDemTile } from '@features/map/dem';
import { useEffect, useState } from 'react';

/**
 * The climb (D+) of a trail and of each of its stages, from our DEM tiles
 * (#467) — `@core/trails/climb` for the rules. `unavailable` covers a trail
 * too long for the tile budget, no connection and nothing cached, or a decode
 * failure: the page then simply has no Climb figure. Never a guess.
 */

export type TrailClimb =
  | { status: 'computing' }
  | { status: 'unavailable' }
  | { status: 'done'; totalM: number; stagesM: (number | null)[] };

const cache = new Map<string, TrailClimb>();
const COMPUTING: TrailClimb = { status: 'computing' };

/** Concurrent tile fetches (the 3D view's own fetches run all at once; stay gentler). */
const PARALLEL = 6;

async function computeClimb(detail: TrailDetail): Promise<TrailClimb> {
  const plan = planClimb(detail.geometry);
  if (plan === null) return { status: 'unavailable' };
  const tiles = new Map<string, DemTile>();
  const queue = [...plan.tiles];
  const worker = async () => {
    for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
      try {
        tiles.set(tileKeyId(key), { size: 256, data: await fetchDemTile(key.z, key.x, key.y) });
      } catch {
        // A missing tile leaves its samples undefined; the rest still count.
      }
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  if (tiles.size < plan.tiles.length * 0.9) return { status: 'unavailable' };
  const totalM = climbFromTiles(plan.samples, plan.z, tiles);
  if (totalM === null) return { status: 'unavailable' };
  const stagesM = detail.stages.map((stage) =>
    climbFromTiles(resampleLine(stage.geometry, CLIMB_STEP_M), plan.z, tiles),
  );
  return { status: 'done', totalM, stagesM };
}

export function useTrailClimb(detail: TrailDetail | null): TrailClimb {
  const [result, setResult] = useState<{ id: string; climb: TrailClimb } | null>(null);
  const id = detail?.id ?? null;
  useEffect(() => {
    if (detail === null || cache.has(detail.id)) return;
    let alive = true;
    void computeClimb(detail)
      .catch((): TrailClimb => ({ status: 'unavailable' }))
      .then((climb) => {
        // An offline miss may succeed later: only remember real answers.
        if (climb.status === 'done') cache.set(detail.id, climb);
        if (alive) setResult({ id: detail.id, climb });
      });
    return () => {
      alive = false;
    };
  }, [detail]);
  if (id === null) return COMPUTING;
  return cache.get(id) ?? (result?.id === id ? result.climb : COMPUTING);
}
