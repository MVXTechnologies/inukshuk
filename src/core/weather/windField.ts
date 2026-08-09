import type { WindGrid } from './windTiff';

/**
 * Wind vector field (weather M3): combines the GeoMet speed + direction (and
 * optionally gust) scalar grids into a u/v field the particle renderer can
 * sample, and encodes it into the RGBA texture layout the ported webgl-wind
 * shaders expect (R = normalized u, G = normalized v, B = gust ratio).
 *
 * GeoMet has no U/V component layers (verified: 0 hits across all WMS
 * layers), so components are derived client-side. Direction is the
 * METEOROLOGICAL "blowing from" convention in degrees (verified against an
 * independent GEM reading at the same point/time):
 *
 *   u = −speed · sin(dir · π/180)   // eastward component, m/s
 *   v = −speed · cos(dir · π/180)   // northward component, m/s
 */

export interface WindField {
  width: number;
  height: number;
  /** Eastward wind component per cell, m/s (row 0 = north edge). */
  u: Float32Array;
  /** Northward wind component per cell, m/s. */
  v: Float32Array;
  /** Wind speed per cell, m/s. */
  speed: Float32Array;
  /**
   * Gust/speed ratio per cell, clamped to [1, 3]; null when the model had no
   * usable gust coverage (particles then advect at plain field speed).
   */
  gustRatio: Float32Array | null;
  /** West edge longitude, degrees. */
  lon0: number;
  /** NORTH edge latitude, degrees. */
  lat0: number;
  /** Grid span in degrees longitude (positive). */
  lonSpan: number;
  /** Grid span in degrees latitude (positive; extends south from lat0). */
  latSpan: number;
  /** Max speed over the grid, m/s (≥ 1 so normalization never divides by 0). */
  maxSpeed: number;
}

/** Derive u/v (m/s, east/north positive) from speed + meteorological direction. */
export function windUV(speedMps: number, dirDeg: number): { u: number; v: number } {
  const rad = (dirDeg * Math.PI) / 180;
  return { u: -speedMps * Math.sin(rad), v: -speedMps * Math.cos(rad) };
}

/** Gust ratios below/above this are clamped — keeps the encoding bounded. */
export const GUST_RATIO_MAX = 3;
/** Below this speed (m/s) the gust ratio is meaningless noise — force 1. */
const GUST_MIN_SPEED = 0.5;

/** Do two grids describe the same geographic raster (within float slop)? */
function sameGeometry(a: WindGrid, b: WindGrid): boolean {
  const eps = 1e-6;
  return (
    a.width === b.width &&
    a.height === b.height &&
    Math.abs(a.lon0 - b.lon0) < eps &&
    Math.abs(a.lat0 - b.lat0) < eps &&
    Math.abs(a.dLon - b.dLon) < eps &&
    Math.abs(a.dLat - b.dLat) < eps
  );
}

/**
 * Build the vector field from the speed + direction grids (and gust when its
 * grid matches). Null when speed/direction disagree about the raster — the
 * caller degrades to gradient-only. A mismatched gust grid is dropped
 * silently instead of failing the whole field (some models may lag their
 * post-processed gust product).
 */
export function createWindField(
  speedGrid: WindGrid,
  dirGrid: WindGrid,
  gustGrid: WindGrid | null,
): WindField | null {
  if (!sameGeometry(speedGrid, dirGrid)) return null;
  const n = speedGrid.width * speedGrid.height;
  const u = new Float32Array(n);
  const v = new Float32Array(n);
  const speed = new Float32Array(n);
  let maxSpeed = 1;
  for (let i = 0; i < n; i++) {
    const s = speedGrid.data[i] ?? 0;
    const d = dirGrid.data[i] ?? 0;
    if (!Number.isFinite(s) || !Number.isFinite(d) || s < 0) continue;
    const uv = windUV(s, d);
    u[i] = uv.u;
    v[i] = uv.v;
    speed[i] = s;
    if (s > maxSpeed) maxSpeed = s;
  }
  let gustRatio: Float32Array | null = null;
  if (gustGrid !== null && sameGeometry(speedGrid, gustGrid)) {
    gustRatio = new Float32Array(n).fill(1);
    for (let i = 0; i < n; i++) {
      const s = speed[i] ?? 0;
      const g = gustGrid.data[i] ?? 0;
      if (s < GUST_MIN_SPEED || !Number.isFinite(g) || g <= s) continue;
      gustRatio[i] = Math.min(g / s, GUST_RATIO_MAX);
    }
  }
  return {
    width: speedGrid.width,
    height: speedGrid.height,
    u,
    v,
    speed,
    gustRatio,
    lon0: speedGrid.lon0,
    lat0: speedGrid.lat0,
    lonSpan: speedGrid.dLon * speedGrid.width,
    latSpan: speedGrid.dLat * speedGrid.height,
    maxSpeed,
  };
}

/** A bilinearly sampled wind vector at a geographic point. */
export interface WindSample {
  u: number;
  v: number;
  speed: number;
}

/**
 * Bilinear sample of the field at a lon/lat, or null outside the grid.
 * Mirrors the GLSL lookup (cell centers at pixel centers, clamped edges) so
 * the tests that pin advection behaviour describe what the GPU does.
 */
export function sampleWind(field: WindField, lon: number, lat: number): WindSample | null {
  const fx = ((lon - field.lon0) / field.lonSpan) * field.width - 0.5;
  const fy = ((field.lat0 - lat) / field.latSpan) * field.height - 0.5;
  if (fx < -0.5 || fy < -0.5 || fx > field.width - 0.5 || fy > field.height - 0.5) return null;
  const x0 = Math.max(0, Math.min(field.width - 1, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(field.height - 1, Math.floor(fy)));
  const x1 = Math.min(field.width - 1, x0 + 1);
  const y1 = Math.min(field.height - 1, y0 + 1);
  const tx = Math.max(0, Math.min(1, fx - x0));
  const ty = Math.max(0, Math.min(1, fy - y0));
  const mix2 = (arr: Float32Array): number => {
    const a = (arr[y0 * field.width + x0] ?? 0) * (1 - tx) + (arr[y0 * field.width + x1] ?? 0) * tx;
    const b = (arr[y1 * field.width + x0] ?? 0) * (1 - tx) + (arr[y1 * field.width + x1] ?? 0) * tx;
    return a * (1 - ty) + b * ty;
  };
  return { u: mix2(field.u), v: mix2(field.v), speed: mix2(field.speed) };
}

/** The RGBA texture the GL renderer uploads, plus its decode ranges. */
export interface EncodedWindTexture {
  width: number;
  height: number;
  /** RGBA bytes: R/G = u/v normalized to [min,max], B = gust ratio, A = 255. */
  rgba: Uint8Array;
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
  maxSpeed: number;
}

/**
 * Encode the field the way the ported webgl-wind shaders decode it:
 * `velocity = mix(min, max, texel.rg)`; B carries the gust ratio mapped
 * [1, GUST_RATIO_MAX] → [0, 255] (0 = no gust boost).
 */
export function encodeWindTexture(field: WindField): EncodedWindTexture {
  const n = field.width * field.height;
  let uMin = 0;
  let uMax = 0;
  let vMin = 0;
  let vMax = 0;
  for (let i = 0; i < n; i++) {
    const uu = field.u[i] ?? 0;
    const vv = field.v[i] ?? 0;
    if (uu < uMin) uMin = uu;
    if (uu > uMax) uMax = uu;
    if (vv < vMin) vMin = vv;
    if (vv > vMax) vMax = vv;
  }
  // Degenerate (calm everywhere): keep a non-zero range so mix() stays sane.
  if (uMax - uMin < 1e-6) uMax = uMin + 1e-6;
  if (vMax - vMin < 1e-6) vMax = vMin + 1e-6;
  const rgba = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const uu = field.u[i] ?? 0;
    const vv = field.v[i] ?? 0;
    rgba[i * 4] = Math.round(((uu - uMin) / (uMax - uMin)) * 255);
    rgba[i * 4 + 1] = Math.round(((vv - vMin) / (vMax - vMin)) * 255);
    const ratio = field.gustRatio?.[i] ?? 1;
    rgba[i * 4 + 2] = Math.round(
      (Math.max(1, Math.min(GUST_RATIO_MAX, ratio)) - 1) * (255 / (GUST_RATIO_MAX - 1)),
    );
    rgba[i * 4 + 3] = 255;
  }
  return {
    width: field.width,
    height: field.height,
    rgba,
    uMin,
    uMax,
    vMin,
    vMax,
    maxSpeed: field.maxSpeed,
  };
}
