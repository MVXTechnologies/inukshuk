/**
 * Pure terrain-analysis math for the map's analytical overlays: slope, the
 * CalTopo-style slope bands and their anti-aliased colours, Web-Mercator pixel
 * geometry and the auto contour interval. Everything works on the
 * **metre-space** heightmap grid.
 */

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

export const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/** GLSL-style smoothstep (the slope-band edge blend). */
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** GLSL-style fract (result in [0,1) even for negative inputs). */
export function fract(x: number): number {
  return x - Math.floor(x);
}

/**
 * Horn 3×3 gradient of one cell, in metres of elevation per metre of ground.
 * Row 0 is the NORTH edge (matching {@link import('@features/map/dem').Heightmap}),
 * so `dzdy` is the gradient toward the SOUTH. Edges clamp (replicate), which
 * halves the reported gradient on the outermost ring — acceptable, since the
 * mesh border is hidden by the skirt and fog.
 */
function hornGradient(
  data: ArrayLike<number>,
  grid: number,
  cellXm: number,
  cellZm: number,
  gx: number,
  gy: number,
): { dzdx: number; dzdy: number } {
  const cl = (v: number) => Math.max(0, Math.min(grid - 1, v));
  const at = (x: number, y: number) => data[cl(y) * grid + cl(x)] as number;
  const a = at(gx - 1, gy - 1);
  const b = at(gx, gy - 1);
  const c = at(gx + 1, gy - 1);
  const d = at(gx - 1, gy);
  const f = at(gx + 1, gy);
  const g = at(gx - 1, gy + 1);
  const h = at(gx, gy + 1);
  const i = at(gx + 1, gy + 1);
  return {
    dzdx: (c + 2 * f + i - (a + 2 * d + g)) / (8 * cellXm),
    dzdy: (g + 2 * h + i - (a + 2 * b + c)) / (8 * cellZm),
  };
}

/**
 * Slope in degrees (0..90) for every cell of a metre-space heightmap grid,
 * via the Horn 3×3 method (what CalTopo / GDAL use). `cellXm`/`cellZm` are the
 * ground metres between adjacent columns / rows.
 */
export function slopeDegrees(
  data: ArrayLike<number>,
  grid: number,
  cellXm: number,
  cellZm: number,
): Float32Array {
  const out = new Float32Array(grid * grid);
  for (let gy = 0; gy < grid; gy++) {
    for (let gx = 0; gx < grid; gx++) {
      const { dzdx, dzdy } = hornGradient(data, grid, cellXm, cellZm, gx, gy);
      out[gy * grid + gx] = Math.atan(Math.hypot(dzdx, dzdy)) * DEG;
    }
  }
  return out;
}

/** One CalTopo-style slope band: colours apply from `minDeg` up to the next band. */
export interface SlopeBand {
  minDeg: number;
  rgb: readonly [number, number, number];
}

/**
 * The CalTopo / Gaia avalanche-slope bands: transparent below 27°, then
 * yellow 27–29°, light orange 30–31°, orange 32–34°, red 35–44°, purple 45°+.
 */
export const SLOPE_BANDS: readonly SlopeBand[] = [
  { minDeg: 27, rgb: [246, 231, 74] },
  { minDeg: 30, rgb: [250, 183, 92] },
  { minDeg: 32, rgb: [243, 126, 33] },
  { minDeg: 35, rgb: [214, 44, 34] },
  { minDeg: 45, rgb: [136, 42, 178] },
];

/** RGBA for a slope in degrees: the band colour (alpha 255), or all-zero <27°. */
export function slopeBandColor(slopeDeg: number): [number, number, number, number] {
  for (let i = SLOPE_BANDS.length - 1; i >= 0; i--) {
    const band = SLOPE_BANDS[i]!;
    if (slopeDeg >= band.minDeg) return [band.rgb[0], band.rgb[1], band.rgb[2], 255];
  }
  return [0, 0, 0, 0];
}

/**
 * RGBA overlay image (grid × grid) of the slope bands for a heightmap, for the
 * 2D map's slope raster: each cell gets its band colour, fully transparent
 * outside the [minDeg, maxDeg] window (the range slider; 27–90 shows every
 * band). Opacity is left to the map layer.
 */
export function slopeOverlayRgba(
  data: ArrayLike<number>,
  grid: number,
  cellXm: number,
  cellZm: number,
  minDeg: number,
  maxDeg = 90,
): Uint8Array {
  const slope = slopeDegrees(data, grid, cellXm, cellZm);
  const out = new Uint8Array(grid * grid * 4);
  for (let i = 0; i < slope.length; i++) {
    const deg = slope[i]!;
    if (deg < minDeg || deg > maxDeg) continue; // stays transparent
    const [r, g, b, a] = slopeBandColor(deg);
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = a;
  }
  return out;
}

/** Degrees over which the 2D overlay blends one slope band into the next. */
export const SLOPE_BLEND_DEG = 1.5;

/**
 * Anti-aliased slope-band colour for the 2D overlay (#461): the CalTopo band
 * colours of {@link slopeBandColor}, but each band boundary is a linear blend
 * over {@link SLOPE_BLEND_DEG} centred on it, and the overlay fades in over
 * the same width from the window's lower edge (and out at its upper edge when
 * that is below 90°). A hard step turned every DEM-pixel edge into a visible
 * stair; the blend keeps the bands' meaning — the colour at each band's
 * centre, and at its start ± 0.75°, is the band's own — while the edges read
 * as contours instead of pixels. Outside [minDeg, maxDeg]: transparent.
 */
export function slopeOverlayColor(
  slopeDeg: number,
  minDeg: number,
  maxDeg = 90,
): [number, number, number, number] {
  const lo = Math.max(minDeg, SLOPE_BANDS[0]!.minDeg);
  if (slopeDeg < lo || slopeDeg > maxDeg) return [0, 0, 0, 0];
  const half = SLOPE_BLEND_DEG / 2;
  let [r, g, b] = slopeBandColor(slopeDeg);
  for (let i = 1; i < SLOPE_BANDS.length; i++) {
    const edge = SLOPE_BANDS[i]!.minDeg;
    if (Math.abs(slopeDeg - edge) < half) {
      const t = (slopeDeg - (edge - half)) / SLOPE_BLEND_DEG;
      const from = SLOPE_BANDS[i - 1]!.rgb;
      const to = SLOPE_BANDS[i]!.rgb;
      r = Math.round(from[0] + (to[0] - from[0]) * t);
      g = Math.round(from[1] + (to[1] - from[1]) * t);
      b = Math.round(from[2] + (to[2] - from[2]) * t);
      break;
    }
  }
  let alpha = smoothstep(lo, lo + SLOPE_BLEND_DEG, slopeDeg);
  if (maxDeg < 90) alpha *= 1 - smoothstep(maxDeg - SLOPE_BLEND_DEG, maxDeg, slopeDeg);
  return [r, g, b, Math.round(255 * alpha)];
}

/** Web-Mercator circumference at the equator, metres (EPSG:3857). */
const EARTH_CIRCUMFERENCE_M = 40075016.686;

/**
 * Ground metres covered by one pixel of a Web-Mercator tile pyramid
 * (`tilePx`-pixel tiles) at a latitude and zoom. Mercator is conformal, so
 * the size is the same east–west and north–south; it shrinks with cos(lat).
 */
export function mercatorMetersPerPixel(latDeg: number, z: number, tilePx = 256): number {
  return (EARTH_CIRCUMFERENCE_M * Math.cos(latDeg * RAD)) / (tilePx * 2 ** z);
}

/** Latitude (degrees) of a global pixel row `row` (may be fractional) at zoom `z`. */
export function mercatorRowLat(row: number, z: number, tilePx = 256): number {
  const n = Math.PI * (1 - (2 * row) / (tilePx * 2 ** z));
  return Math.atan(Math.sinh(n)) * DEG;
}

/** A slope overlay image: RGBA, `width` × `height`, row 0 = north. */
export interface SlopeOverlayImage {
  rgba: Uint8Array;
  width: number;
  height: number;
}

/**
 * The 2D map's slope-band overlay, computed at the DEM's FULL resolution
 * (#461). `data` is a Web-Mercator elevation mosaic (metres, row-major,
 * `width` × `height`, row 0 = north) whose row 0 is global pixel row `topRow`
 * of zoom `z` (256-px tiles).
 *
 * Why not {@link slopeOverlayRgba} on a resampled grid: the old 2D path first
 * shrank a up-to-2048-px mosaic to a 384 grid — ~5 DEM pixels per cell with a
 * single bilinear tap each — and then took the Horn gradient over those wide
 * cells. That aliased the relief and averaged every short steep pitch into
 * its gentler neighbours, so steep ground under-read (fewer red/purple
 * cells, next to nothing when zoomed out) and each cell was a visible block.
 * Here the gradient uses every DEM pixel with its true ground size (per row:
 * Mercator pixels shrink with latitude), and only then is the SLOPE averaged
 * down by `step` × `step` blocks to keep the image a sensible size.
 *
 * Colours come from {@link slopeOverlayColor} (anti-aliased bands); cells
 * outside [minDeg, maxDeg] stay transparent; opacity is the layer's.
 */
export function slopeOverlayMercator(
  data: ArrayLike<number>,
  width: number,
  height: number,
  z: number,
  topRow: number,
  minDeg: number,
  maxDeg = 90,
  step = 1,
): SlopeOverlayImage {
  const s = Math.max(1, Math.floor(step));
  const outW = Math.ceil(width / s);
  const outH = Math.ceil(height / s);
  const sum = new Float32Array(outW * outH);
  const count = new Uint16Array(outW * outH);
  // Hot loop (up to 2048² cells on the JS thread): plain indexing, rows and
  // edge columns clamped once instead of per sample.
  for (let y = 0; y < height; y++) {
    const cell = mercatorMetersPerPixel(mercatorRowLat(topRow + y + 0.5, z), z);
    const inv8 = 1 / (8 * cell);
    const rN = Math.max(0, y - 1) * width;
    const r0 = y * width;
    const rS = Math.min(height - 1, y + 1) * width;
    const oy = Math.floor(y / s) * outW;
    for (let x = 0; x < width; x++) {
      const xw = x > 0 ? x - 1 : 0;
      const xe = x < width - 1 ? x + 1 : x;
      const a = data[rN + xw] as number;
      const b = data[rN + x] as number;
      const c = data[rN + xe] as number;
      const d = data[r0 + xw] as number;
      const f = data[r0 + xe] as number;
      const g = data[rS + xw] as number;
      const h = data[rS + x] as number;
      const i = data[rS + xe] as number;
      const dzdx = (c + 2 * f + i - (a + 2 * d + g)) * inv8;
      const dzdy = (g + 2 * h + i - (a + 2 * b + c)) * inv8;
      const o = oy + ((x / s) | 0);
      sum[o] = (sum[o] as number) + Math.atan(Math.sqrt(dzdx * dzdx + dzdy * dzdy)) * DEG;
      count[o] = (count[o] as number) + 1;
    }
  }
  const rgba = new Uint8Array(outW * outH * 4);
  for (let o = 0; o < sum.length; o++) {
    const deg = (sum[o] as number) / Math.max(1, count[o] as number);
    const [r, g, b, al] = slopeOverlayColor(deg, minDeg, maxDeg);
    if (al === 0) continue; // stays transparent
    rgba[o * 4] = r;
    rgba[o * 4 + 1] = g;
    rgba[o * 4 + 2] = b;
    rgba[o * 4 + 3] = al;
  }
  return { rgba, width: outW, height: outH };
}

/**
 * Minor contour interval (m) for an elevation span (m): 10/25/50/100 so a slab
 * carries roughly 15–35 minor lines whatever its relief.
 */
export function autoContourInterval(spanM: number): number {
  if (spanM <= 350) return 10;
  if (spanM <= 900) return 25;
  if (spanM <= 1800) return 50;
  return 100;
}
