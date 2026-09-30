import { sampleGridBilinear } from './terrain';

/**
 * Pure terrain-analysis math for the 3D map's analytical overlays: slope,
 * aspect, multidirectional hillshade, and the colour ramps / band functions the
 * terrain shader transcribes. Everything works on the **metre-space** heightmap
 * grid — never on the vertically-exaggerated mesh (vExag would corrupt slope by
 * `atan(vExag · tan θ)`).
 *
 * The GLSL in `src/features/map/terrain3d/terrainMaterial.ts` is a transcription
 * of the band functions here; keep them in lockstep (they're the unit-tested
 * source of truth for what the shader draws).
 */

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

export const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/** GLSL-equivalent smoothstep (mirrored so contour tests match the shader). */
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** GLSL-equivalent fract (result in [0,1) even for negative inputs). */
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

/**
 * Downslope compass direction in degrees (0 = north, 90 = east, [0, 360)) per
 * cell; `NaN` for flat cells (no defined aspect).
 */
export function aspectDegrees(
  data: ArrayLike<number>,
  grid: number,
  cellXm: number,
  cellZm: number,
): Float32Array {
  const out = new Float32Array(grid * grid);
  for (let gy = 0; gy < grid; gy++) {
    for (let gx = 0; gx < grid; gx++) {
      const { dzdx, dzdy } = hornGradient(data, grid, cellXm, cellZm, gx, gy);
      if (dzdx === 0 && dzdy === 0) {
        out[gy * grid + gx] = NaN;
        continue;
      }
      // Downslope = negative gradient. East component: -dzdx; north component:
      // -(dz/dnorth) = +dzdy (rows grow southward). Compass = atan2(E, N).
      const deg = Math.atan2(-dzdx, dzdy) * DEG;
      out[gy * grid + gx] = (deg + 360) % 360;
    }
  }
  return out;
}

/** Sun azimuths (compass deg) of the multidirectional hillshade, at 45° altitude. */
export const HILLSHADE_AZIMUTHS = [225, 270, 315, 360] as const;

/**
 * Soft multidirectional hillshade in [0, 1]: the mean of 4 Lambertian shades
 * (sun azimuths {@link HILLSHADE_AZIMUTHS}, altitude 45°) times a cavity term
 * that darkens concavities (local 4-neighbour Laplacian), so valleys read dark
 * and ridges pop — the FATMAP baked-relief look. Flat ground shades to
 * `sin(45°) ≈ 0.707`.
 */
export function multidirHillshade(
  data: ArrayLike<number>,
  grid: number,
  cellXm: number,
  cellZm: number,
): Float32Array {
  const alt = 45 * RAD;
  const sinAlt = Math.sin(alt);
  const cosAlt = Math.cos(alt);
  // Sun direction unit vectors in (east, north, up).
  const suns = HILLSHADE_AZIMUTHS.map((azDeg) => {
    const az = azDeg * RAD;
    return { e: cosAlt * Math.sin(az), n: cosAlt * Math.cos(az), u: sinAlt };
  });
  const cell = (cellXm + cellZm) / 2;
  const cl = (v: number) => Math.max(0, Math.min(grid - 1, v));
  const at = (x: number, y: number) => data[cl(y) * grid + cl(x)] as number;
  const out = new Float32Array(grid * grid);
  for (let gy = 0; gy < grid; gy++) {
    for (let gx = 0; gx < grid; gx++) {
      const { dzdx, dzdy } = hornGradient(data, grid, cellXm, cellZm, gx, gy);
      // Surface normal in (east, north, up); dz/dnorth = -dzdy.
      const len = Math.hypot(dzdx, dzdy, 1);
      const ne = -dzdx / len;
      const nn = dzdy / len;
      const nu = 1 / len;
      let sum = 0;
      for (const s of suns) sum += Math.max(0, ne * s.e + nn * s.n + nu * s.u);
      const shade = sum / suns.length;
      // Cavity: cell below its 4-neighbour mean = concave = darken (and the
      // inverse brightens ridges slightly).
      const lap =
        (at(gx - 1, gy) + at(gx + 1, gy) + at(gx, gy - 1) + at(gx, gy + 1)) / 4 - at(gx, gy);
      const cavity = Math.max(0.55, Math.min(1.25, 1 - (1.5 * lap) / cell));
      out[gy * grid + gx] = clamp01(shade * cavity);
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
 * band). Opacity is left to the map layer so 2D matches the 3D shader's blend.
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
 * A `size`×1 RGBA slope ramp texture spanning 0..90°, sampled at texel centres
 * — so band edges are data, not shader branches. Point-sample it (NEAREST).
 */
export function slopeRampRgba(size = 256): Uint8Array {
  const out = new Uint8Array(size * 4);
  for (let i = 0; i < size; i++) {
    const [r, g, b, a] = slopeBandColor(((i + 0.5) / size) * 90);
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = a;
  }
  return out;
}

/** Hypsometric tint stops (normalised elevation 0..1 → RGB 0..255). */
export const HYPSO_STOPS: readonly (readonly [number, number, number])[] = [
  [88, 128, 86], // valley green
  [140, 158, 96], // upland olive
  [189, 173, 123], // tan
  [160, 128, 99], // high brown
  [235, 235, 235], // snow
];

/** Interpolated hypsometric RGB (0..255) at normalised elevation `t` ∈ [0,1]. */
export function hypsoColor(t: number): [number, number, number] {
  const x = clamp01(t) * (HYPSO_STOPS.length - 1);
  const i = Math.min(HYPSO_STOPS.length - 2, Math.floor(x));
  const f = x - i;
  const a = HYPSO_STOPS[i]!;
  const b = HYPSO_STOPS[i + 1]!;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/** A `size`×1 RGBA hypsometric ramp texture (alpha 255 throughout). */
export function hypsoRampRgba(size = 256): Uint8Array {
  const out = new Uint8Array(size * 4);
  for (let i = 0; i < size; i++) {
    const [r, g, b] = hypsoColor((i + 0.5) / size);
    out[i * 4] = Math.round(r);
    out[i * 4 + 1] = Math.round(g);
    out[i * 4 + 2] = Math.round(b);
    out[i * 4 + 3] = 255;
  }
  return out;
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

/**
 * Anti-aliased contour line strengths at an elevation — the exact TS mirror of
 * the shader's fwidth-isoline math. `wpxM` is metres of elevation covered by
 * one screen pixel (`fwidth(vElevM)` in GLSL). Minor lines auto-fade as they
 * approach aliasing density (the key to the premium look).
 */
export function contourStrength(
  elevM: number,
  intervalM: number,
  majorEvery: number,
  wpxM: number,
): { minor: number; major: number; combined: number } {
  const w = Math.max(wpxM, 1e-4);
  const dMinor = Math.abs(fract(elevM / intervalM - 0.5) - 0.5) * intervalM;
  let minor = 1 - smoothstep(0.5 * w, 1.5 * w, dMinor);
  const majorI = intervalM * majorEvery;
  const dMajor = Math.abs(fract(elevM / majorI - 0.5) - 0.5) * majorI;
  const major = 1 - smoothstep(0.8 * w, 2.2 * w, dMajor);
  minor *= 1 - smoothstep(0.25, 0.5, w / intervalM);
  return { minor, major, combined: Math.max(major * 0.55, minor * 0.3) };
}

/**
 * Contrast-adaptive contour shade for the surface luminance under the line:
 * white over dark imagery (forest, shadow), black over bright imagery (snow,
 * bare rock), smooth in between — so contours stay readable on a satellite
 * drape. `lum` is Rec.601 luminance in [0,1]; returns the grey level [0,1]
 * (1 = white line). The 3D shader transcribes this; keep them in lockstep.
 */
export function contourShadeForLuminance(lum: number): number {
  return 1 - smoothstep(0.35, 0.65, clamp01(lum));
}

/** Rec.601 luminance of an RGB colour in [0,1] channels. */
export function luminance601(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Hypsometric band base elevation drawn at `elevM` (the shader tints by the
 * band's *start* elevation, giving flat "isobar-like" steps).
 */
export function hypsoBandStart(elevM: number, intervalM: number): number {
  return Math.floor(elevM / intervalM) * intervalM;
}

/**
 * Brightness factor a hillshade value maps to when baked into drape pixels /
 * vertex colours: flat ground (shade ≈ 0.707) stays ≈ unchanged, lit slopes
 * brighten a little, shaded slopes darken a lot.
 */
export function hillshadeFactor(shade: number, strength = 0.7): number {
  return Math.max(0, Math.min(1.35, 1 + strength * (1.4 * shade - 1)));
}

/**
 * Multiply a multidirectional hillshade (a `shadeGrid`×`shadeGrid` grid in
 * [0,1]) into an RGBA image in place — FATMAP-style baked relief, free at
 * render time. The shade grid is sampled bilinearly across the image.
 */
export function bakeHillshadeIntoRgba(
  rgba: Uint8Array,
  width: number,
  height: number,
  shade: ArrayLike<number>,
  shadeGrid: number,
  strength = 0.7,
): void {
  for (let y = 0; y < height; y++) {
    const fy = height > 1 ? y / (height - 1) : 0;
    for (let x = 0; x < width; x++) {
      const fx = width > 1 ? x / (width - 1) : 0;
      const s = sampleGridBilinear(shade, shadeGrid, shadeGrid, fx, fy);
      const f = hillshadeFactor(s, strength);
      const i = (y * width + x) * 4;
      rgba[i] = Math.min(255, Math.round(rgba[i]! * f));
      rgba[i + 1] = Math.min(255, Math.round(rgba[i + 1]! * f));
      rgba[i + 2] = Math.min(255, Math.round(rgba[i + 2]! * f));
    }
  }
}

/** Sky gradient stops (RGB 0..1) — horizon haze → mid → zenith blue. */
export const SKY_STOPS = {
  horizon: [0.875, 0.914, 0.949],
  mid: [0.659, 0.78, 0.91],
  zenith: [0.42, 0.6, 0.831],
} as const;

/**
 * 3-stop sky-dome gradient colour (RGB 0..1) for a view direction's normalised
 * height `y` ∈ [-1, 1] — the TS mirror of the sky dome's fragment shader.
 */
export function skyGradientColor(y: number): [number, number, number] {
  const a = smoothstep(0.02, 0.22, y);
  const b = smoothstep(0.22, 0.65, y);
  const out: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const lower = SKY_STOPS.horizon[i]! + (SKY_STOPS.mid[i]! - SKY_STOPS.horizon[i]!) * a;
    out[i] = lower + (SKY_STOPS.zenith[i]! - lower) * b;
  }
  return out;
}
