/**
 * The terrain's reference height — MapLibre's camera is relative to sea
 * level, so the terrain is drawn relative to `hRef` (GL JS's "centre
 * altitude"). We take the highest ground under the bottom edge of the view:
 * nothing in front of the camera can then rise into the frame from below,
 * where the flat map has no pixels to drape (see docs/plans/native-terrain.md).
 */
import { groundAtNdc } from './camera';
import { invert, type Mat4 } from './mat4';
import { DEM_MAX_ZOOM, type TileId } from './tiles';

/** NDC points under the bottom edge the reference is sampled at. */
export const REFERENCE_NDC: readonly (readonly [number, number])[] = [
  [-0.9, -0.98],
  [0, -0.98],
  [0.9, -0.98],
];

/** The reference from height samples: the max of the finite ones (0 if none). */
export function referenceHeight(samples: readonly (number | null | undefined)[]): number {
  let best = -Infinity;
  for (const s of samples) if (typeof s === 'number' && Number.isFinite(s) && s > best) best = s;
  return best === -Infinity ? 0 : best;
}

/** World points (x_px, y_px) under the reference NDC points; nulls above the horizon. */
export function referencePoints(P: Mat4): ([number, number] | null)[] {
  const inv = invert(P);
  if (!inv) return REFERENCE_NDC.map(() => null);
  return REFERENCE_NDC.map(([x, y]) => groundAtNdc(inv, x, y));
}

/**
 * Exponential smoothing toward `target` over `dtMs` with time constant
 * `tauMs`; snaps when within `epsilon` (and on the first sample, `current`
 * null).
 */
export function smoothToward(
  current: number | null,
  target: number,
  dtMs: number,
  tauMs = 150,
  epsilon = 0.05,
): number {
  if (current === null || !Number.isFinite(current)) return target;
  if (!Number.isFinite(dtMs) || dtMs <= 0) return current;
  const a = 1 - Math.exp(-dtMs / Math.max(tauMs, 1e-6));
  const next = current + (target - current) * a;
  return Math.abs(next - target) < epsilon ? target : next;
}

export interface StableReferenceInput {
  /** Ground height (m) under the map centre — the camera's pivot; null when unknown. */
  center: number | null;
  /** Highest ground (m) under the bottom edge — the nearest visible terrain; null when unknown. */
  nearMax: number | null;
  /** Camera eye altitude (m) above the plane the terrain is drawn relative to. */
  eyeAltM: number;
  /** exaggeration × ramp. */
  heightScale: number;
  /** Clearance kept between the camera and the near terrain (m, ≥ 15 % of the altitude). */
  marginM?: number;
}

/**
 * The reference height without the swings (2.2.1, "mountains grow and
 * shrink"): anchored to the ground under the map centre, which MapLibre's
 * tilt pivots around — so tilting never moves it, and panning moves it as
 * smoothly as the terrain under the centre (GL JS's centre altitude). It
 * only rises above the centre when the near terrain (the bottom edge) would
 * otherwise come within `marginM` of the camera. The 2.2.0 rule (the max
 * under the bottom edge) swept across ridges and valleys as the view tilted,
 * shifting the whole terrain toward and away from the camera.
 */
export function stableReferenceHeight(i: StableReferenceInput): number {
  const center = i.center !== null && Number.isFinite(i.center) ? i.center : null;
  const near = i.nearMax !== null && Number.isFinite(i.nearMax) ? i.nearMax : null;
  let ref = center ?? near ?? 0;
  if (near !== null && i.heightScale > 1e-6 && Number.isFinite(i.eyeAltM)) {
    const margin = Math.max(i.marginM ?? 50, 0.15 * Math.max(i.eyeAltM, 0));
    const guard = near - (i.eyeAltM - margin) / i.heightScale;
    if (guard > ref) ref = guard;
  }
  return ref;
}

/**
 * The 360° base ring (2.2.1): (2·radius+1)² tiles at `zoom` around the
 * mercator point (mx, my), x wrapped across the antimeridian, y clamped to
 * the world. The engine pins their DEMs, meshes and drapes, so a tile that
 * turns into view always has an ancestor surface and texture — it is never
 * drawn flat or white — and rotating needs no fresh fetch.
 */
export function baseRing(mx: number, my: number, zoom: number, radius = 2): TileId[] {
  const out: TileId[] = [];
  if (zoom < 0) return out;
  const n = 2 ** zoom;
  const cx = Math.floor(mx * n);
  const cy = Math.floor(my * n);
  for (let dy = -radius; dy <= radius; dy++) {
    const y = cy + dy;
    if (y < 0 || y >= n) continue;
    for (let dx = -radius; dx <= radius; dx++) {
      const xw = cx + dx;
      const wrap = Math.floor(xw / n);
      const x = xw - wrap * n;
      if (!out.some((t) => t.x === x && t.y === y)) out.push({ z: zoom, x, y, wrap });
    }
  }
  return out;
}

/** The base ring's zoom: ±2 tiles span about the fog distance; `zoom` − 7 … `zoom` − 2. */
export function baseRingZoom(zoom: number, fogDistancePx: number): number {
  const tilePx = Math.max(fogDistancePx, 1) / 2;
  const levels = Math.log2(Math.max(1, tilePx / 512));
  let z = Math.floor(zoom - levels);
  z = Math.max(z, Math.floor(zoom) - 7);
  z = Math.min(z, Math.floor(zoom) - 2);
  return Math.max(0, Math.min(z, DEM_MAX_ZOOM));
}
