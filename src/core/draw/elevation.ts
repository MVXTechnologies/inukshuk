import { elevationGainLoss } from '@core/geo/track';
import type { LngLat } from '@core/models';
import {
  CLIMB_MAX_ZOOM,
  CLIMB_MIN_ZOOM,
  CLIMB_THRESHOLD_M,
  elevationAt,
  tilesUnder,
  type DemTile,
  type TileKey,
} from '@core/trails/climb';

import { densifyLine } from './geometry';

/**
 * Elevation along a drawn route (#502), from the same Terrarium DEM tiles the
 * 3D view and the long-distance trails' climb use (`@core/trails/climb`).
 * The route is densified every {@link ROUTE_SAMPLE_STEP_M} metres (vertices
 * kept), the deepest zoom whose tiles fit {@link ROUTE_MAX_TILES} is chosen,
 * and climb/descent are summed with the recorder's own hysteresis at the
 * DEM threshold. The densified samples with their elevations are also what
 * the saved GPX holds, so the trail view's profile reads the same numbers the
 * drawing bar showed.
 *
 * This is the pure half: the plan and the arithmetic. The map screen fetches
 * and decodes the tiles (`useRouteElevation`).
 */

/** Sample spacing along the route, metres (≈ a z12–z13 DEM pixel). */
export const ROUTE_SAMPLE_STEP_M = 30;
/** Tile budget: each tile is a PNG decoded on the JS thread. */
export const ROUTE_MAX_TILES = 24;
/** Sample cap: a 300 km freehand line still saves a sane GPX. */
export const ROUTE_MAX_SAMPLES = 10_000;

export interface RouteElevationPlan {
  z: number;
  tiles: TileKey[];
  /** The densified line (vertices included), in order. */
  samples: LngLat[];
}

/**
 * What to sample and which tiles to read, or null when there is no line (one
 * vertex or none) or even the shallowest zoom needs more tiles than the
 * budget (the route is then saved without elevation, never with a guess).
 */
export function planRouteElevation(
  vertices: readonly LngLat[],
  options?: { maxTiles?: number; stepM?: number },
): RouteElevationPlan | null {
  if (vertices.length < 2) return null;
  let step = options?.stepM ?? ROUTE_SAMPLE_STEP_M;
  let samples = densifyLine(vertices, step);
  // Very long lines: widen the step until the sample count fits the cap.
  while (samples.length > ROUTE_MAX_SAMPLES) {
    step *= 2;
    samples = densifyLine(vertices, step);
  }
  const budget = options?.maxTiles ?? ROUTE_MAX_TILES;
  for (let z = CLIMB_MAX_ZOOM + 1; z >= CLIMB_MIN_ZOOM; z--) {
    const tiles = tilesUnder(samples, z);
    if (tiles.length <= budget) return { z, tiles, samples };
  }
  return null;
}

export interface RouteElevation {
  /** One per sample; undefined where its tile was missing. */
  elevations: (number | undefined)[];
  ascentM: number;
  descentM: number;
}

/** Elevations and climb/descent along the plan's samples; null when no tile had data. */
export function routeElevationFromTiles(
  plan: RouteElevationPlan,
  tiles: ReadonlyMap<string, DemTile>,
): RouteElevation | null {
  const elevations = plan.samples.map((p) => elevationAt(p, plan.z, tiles));
  if (!elevations.some((e) => e !== undefined)) return null;
  const { ascentM, descentM } = elevationGainLoss(elevations, { threshold: CLIMB_THRESHOLD_M });
  return { elevations, ascentM, descentM };
}
