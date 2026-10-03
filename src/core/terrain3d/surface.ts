/**
 * The 3D terrain's own surface (owner, #551: no draping) — a crafted relief
 * model in the app's palette: paper land, a whisper of rock at altitude,
 * washed water and glacier, soft diffuse light from the 2D hillshade's sun
 * (NNW, viewport-anchored) plus slope darkening, then fog toward the horizon.
 * Pure colour maths, mirrored line for line by the native shaders; the tests
 * pin the behaviour (and the C++ parity fixtures pin the twin).
 */
import { clamp01, smoothstep } from './morph';
import type { Rgb } from './look';

export interface SurfacePalette {
  /** Land / paper. */
  land: Rgb;
  /** Bare rock and scree tone the land drifts toward at altitude. */
  rock: Rgb;
  /** Washed water. */
  water: Rgb;
  /** Glacier / permanent snow. */
  glacier: Rgb;
  /** Shadow tint (warm umber on paper, near-black on stone night). */
  shadow: Rgb;
  /** Highlight tint for sunlit faces. */
  highlight: Rgb;
}

export interface SurfaceParams {
  /** Rock tint begins (m) and is full (m). */
  rockStartM: number;
  rockFullM: number;
  /** Rock tint at its strongest (0–1) — subtle by design. */
  rockMax: number;
  /** How much shadow tint a face turned fully away takes (0–1). */
  shadowStrength: number;
  /** Highlight on faces lit above `highlightFrom` (lambert). */
  highlightStrength: number;
  highlightFrom: number;
  /** Extra darkening of steep slopes (|grad| m/m from 0.4 to 1.6). */
  slopeDarken: number;
}

export const DEFAULT_SURFACE: SurfaceParams = {
  rockStartM: 2200,
  rockFullM: 3400,
  rockMax: 0.35,
  shadowStrength: 0.62,
  highlightStrength: 0.45,
  highlightFrom: 0.72,
  slopeDarken: 0.18,
};

export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  const k = clamp01(t);
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

/** Lambert term for a surface slope (m/m) under an exaggeration and a light vector. */
export function lambertFor(
  slopeX: number,
  slopeY: number,
  exaggeration: number,
  light: readonly [number, number, number],
): number {
  const nx = -slopeX * exaggeration;
  const ny = -slopeY * exaggeration;
  const len = Math.hypot(nx, ny, 1);
  return Math.max(0, (nx * light[0] + ny * light[1] + light[2]) / len);
}

/**
 * The lit surface colour at a point: material from height and the masks
 * (water/glacier 0–1), then the shading. `ramp` (the 2D→3D pitch ramp) does
 * NOT touch the colour — the whole 3D scene crossfades over the 2D map with it.
 */
export function shadeSurface(p: {
  palette: SurfacePalette;
  params?: SurfaceParams;
  heightM: number;
  slopeX: number;
  slopeY: number;
  exaggeration: number;
  light: readonly [number, number, number];
  water: number;
  glacier: number;
}): Rgb {
  const s = p.params ?? DEFAULT_SURFACE;
  const rock = smoothstep(s.rockStartM, s.rockFullM, p.heightM) * s.rockMax;
  let c = mixRgb(p.palette.land, p.palette.rock, rock);
  c = mixRgb(c, p.palette.glacier, p.glacier);
  // Sea level from the DEM counts as water even without a vector mask.
  const water = Math.max(p.water, p.heightM <= 0.5 ? 1 : 0);
  c = mixRgb(c, p.palette.water, water);
  const lambert = lambertFor(p.slopeX, p.slopeY, p.exaggeration, p.light);
  // Flat ground under the light reads as the plain material.
  const flat = p.light[2];
  const away = clamp01((flat - lambert) / Math.max(flat, 1e-6));
  const lit = clamp01((lambert - s.highlightFrom) / (1 - s.highlightFrom));
  const grad = Math.hypot(p.slopeX, p.slopeY) * p.exaggeration;
  // Steepness darkens, except where the sun is full on the face.
  const steep = smoothstep(0.4, 1.6, grad) * s.slopeDarken * (1 - lit);
  // Water stays flat-looking: no relief shading on lakes.
  const shadeK = (1 - water) * clamp01(away * s.shadowStrength + steep);
  c = mixRgb(c, p.palette.shadow, shadeK);
  c = mixRgb(c, p.palette.highlight, (1 - water) * lit * s.highlightStrength);
  return c;
}
