import { elevationGainLoss } from '@core/geo/track';
import { lngLatToTile, sampleGridBilinear } from '@core/geo/terrain';
import type { LngLat } from '@core/models';

import { resampleLine } from './geometry';

/**
 * Climb (D+) of a long-distance trail from our DEM (#467). OSM has no
 * elevation, and a number we can't back is never shown — so the trail page
 * computes it on open from the same Terrarium tiles the 3D view uses:
 *
 * 1. resample the trail every CLIMB_STEP_M metres;
 * 2. pick the deepest zoom (≤ CLIMB_MAX_ZOOM) whose tiles under those samples
 *    stay within a budget — a 50 km trail reads z12 (~30 m pixels), a long
 *    one coarser; past the budget even at CLIMB_MIN_ZOOM there is no climb;
 * 3. bilinearly sample each tile, then sum the ascent with the recorder's own
 *    hysteresis (`elevationGainLoss`), at a threshold suited to a DEM.
 *
 * This module is the pure half; `@features/store/trails/useTrailClimb` fetches
 * and decodes the tiles.
 */

export const CLIMB_STEP_M = 60;
export const CLIMB_MAX_ZOOM = 12;
export const CLIMB_MIN_ZOOM = 10;
/** Each tile is a ~60 KB PNG decoded on the JS thread: keep the page responsive. */
export const CLIMB_MAX_TILES = 36;
/** DEM noise is far below GPS noise, but ridgeline pixels still wobble. */
export const CLIMB_THRESHOLD_M = 4;

export interface TileKey {
  z: number;
  x: number;
  y: number;
}

export const tileKeyId = (t: TileKey) => `${t.z}/${t.x}/${t.y}`;

/** Distinct tiles under `points` at zoom `z`. */
export function tilesUnder(points: readonly LngLat[], z: number): TileKey[] {
  const seen = new Map<string, TileKey>();
  for (const [lon, lat] of points) {
    const { x, y } = lngLatToTile(lon, lat, z);
    const key = { z, x: Math.floor(x), y: Math.floor(y) };
    seen.set(tileKeyId(key), key);
  }
  return [...seen.values()];
}

export interface ClimbPlan {
  z: number;
  tiles: TileKey[];
  /** Samples per part (a pause between parts is not climbed). */
  samples: LngLat[][];
}

/** The zoom and tiles to read, or null when the trail is too long for the budget. */
export function planClimb(
  parts: readonly (readonly LngLat[])[],
  options?: { maxTiles?: number; stepM?: number },
): ClimbPlan | null {
  const samples = resampleLine(parts, options?.stepM ?? CLIMB_STEP_M);
  const flat = samples.flat();
  if (flat.length < 2) return null;
  const budget = options?.maxTiles ?? CLIMB_MAX_TILES;
  for (let z = CLIMB_MAX_ZOOM; z >= CLIMB_MIN_ZOOM; z--) {
    const tiles = tilesUnder(flat, z);
    if (tiles.length <= budget) return { z, tiles, samples };
  }
  return null;
}

/** A decoded DEM tile: `size × size` metres, row 0 = north. */
export interface DemTile {
  size: number;
  data: ArrayLike<number>;
}

/** Elevation at a point from the loaded tiles (undefined when its tile is missing). */
export function elevationAt(
  point: LngLat,
  z: number,
  tiles: ReadonlyMap<string, DemTile>,
): number | undefined {
  const { x, y } = lngLatToTile(point[0], point[1], z);
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  const tile = tiles.get(tileKeyId({ z, x: tx, y: ty }));
  if (tile === undefined) return undefined;
  // Pixel centres: fraction across the tile, mapped onto the grid's cell centres.
  const fx = ((x - tx) * tile.size - 0.5) / (tile.size - 1);
  const fy = ((y - ty) * tile.size - 0.5) / (tile.size - 1);
  return sampleGridBilinear(tile.data, tile.size, tile.size, fx, fy);
}

/** Ascent (m) along `samples`, parts summed separately; null when no sample had data. */
export function climbFromTiles(
  samples: readonly (readonly LngLat[])[],
  z: number,
  tiles: ReadonlyMap<string, DemTile>,
): number | null {
  let total = 0;
  let any = false;
  for (const part of samples) {
    const elevations = part.map((p) => elevationAt(p, z, tiles));
    if (elevations.some((e) => e !== undefined)) any = true;
    total += elevationGainLoss(elevations, { threshold: CLIMB_THRESHOLD_M }).ascentM;
  }
  return any ? total : null;
}
