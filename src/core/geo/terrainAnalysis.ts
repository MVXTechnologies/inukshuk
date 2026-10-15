/**
 * Pure terrain-analysis math for the map's analytical overlays: slope, the
 * CalTopo-style slope bands and their anti-aliased colours, Web-Mercator pixel
 * geometry and the auto contour interval. The slope itself is measured by
 * `slopeField` (Horn, ellipsoidal Mercator pixels); this module colours it.
 */

import { aspectSector, blockMeanDegrees, NODATA_BELOW_M, slopeAspectField } from './slopeField';

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

export function clamp01(v: number): number {
  'worklet';
  return Math.max(0, Math.min(1, v));
}

/** GLSL-style smoothstep (the slope-band edge blend). */
export function smoothstep(e0: number, e1: number, x: number): number {
  'worklet';
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** GLSL-style fract (result in [0,1) even for negative inputs). */
export function fract(x: number): number {
  return x - Math.floor(x);
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
  'worklet';
  for (let i = SLOPE_BANDS.length - 1; i >= 0; i--) {
    const band = SLOPE_BANDS[i]!;
    if (slopeDeg >= band.minDeg) return [band.rgb[0], band.rgb[1], band.rgb[2], 255];
  }
  return [0, 0, 0, 0];
}

/** Degrees over which the 2D overlay blends one slope band into the next. */
export const SLOPE_BLEND_DEG = 1.5;

/**
 * Anti-aliased slope-band colour for the 2D overlay (#461): the CalTopo band
 * colours of {@link slopeBandColor}, but every threshold — each band edge, the
 * window's floor and (below 90°) its ceiling — is a blend over
 * {@link SLOPE_BLEND_DEG} CENTRED on the threshold. A hard step turned every
 * DEM-pixel edge into a visible stair; the blend keeps the legend's meaning:
 * exactly at a threshold the overlay is half-way (half-opaque at the floor,
 * the two band colours mixed 50/50 at an edge), and from threshold ± 0.75°
 * on it is fully the band's own (#722 — the floor used to fade in only ABOVE
 * it, so a 27.5° slope in the "27°+" yellow band drew at a quarter opacity).
 * NaN (no data) and anything outside the faded window: transparent.
 */
export function slopeOverlayColor(
  slopeDeg: number,
  minDeg: number,
  maxDeg = 90,
): [number, number, number, number] {
  'worklet';
  const half = SLOPE_BLEND_DEG / 2;
  const lo = Math.max(minDeg, SLOPE_BANDS[0]!.minDeg);
  if (!(slopeDeg >= lo - half) || slopeDeg > maxDeg + half) return [0, 0, 0, 0];
  // Below the floor (inside its fade) the colour is the floor's own.
  const deg = Math.max(slopeDeg, lo);
  let [r, g, b] = slopeBandColor(deg);
  for (let i = 1; i < SLOPE_BANDS.length; i++) {
    const edge = SLOPE_BANDS[i]!.minDeg;
    if (Math.abs(deg - edge) < half) {
      const t = (deg - (edge - half)) / SLOPE_BLEND_DEG;
      const from = SLOPE_BANDS[i - 1]!.rgb;
      const to = SLOPE_BANDS[i]!.rgb;
      r = Math.round(from[0] + (to[0] - from[0]) * t);
      g = Math.round(from[1] + (to[1] - from[1]) * t);
      b = Math.round(from[2] + (to[2] - from[2]) * t);
      break;
    }
  }
  let alpha = smoothstep(lo - half, lo + half, slopeDeg);
  if (maxDeg < 90) alpha *= 1 - smoothstep(maxDeg - half, maxDeg + half, slopeDeg);
  const a = Math.round(255 * alpha);
  return a === 0 ? [0, 0, 0, 0] : [r, g, b, a];
}

/**
 * The overlay's colours as a ≤ 256-entry PNG palette (#722): an 8-bit
 * indexed image is a quarter of the RGBA bytes to build, compress and upload.
 * `lut[k]` is the palette index for a slope of `k × lutStepDeg` degrees
 * (0..90, 0.005° steps); entry 0 is transparent.
 *
 * The colour of a slope is a curve through RGBA as the angle rises: flat on
 * each band's plateau, moving only across the blends. Walking the LUT in
 * order, a new entry starts whenever the drawn colour (alpha, and colour
 * premultiplied by alpha) strays more than `tol` from the current entry's —
 * plateaus cost one entry and stay exact; the smallest `tol` (in 0.25 / 255
 * steps) whose entries fit is used.
 *
 * With `withTrace`, the LUT has a second half: the same colours at
 * {@link SLOPE_TRACE_ALPHA} of their alpha — the faint trace drawn on steep
 * ground a {@link SlopeFilter} leaves out (#723).
 */
export interface SlopePalette {
  /** RGB triplets, `count` entries. */
  rgb: Uint8Array;
  /** Alpha per entry (PNG tRNS), `count` entries. */
  alpha: Uint8Array;
  count: number;
  /** `slots` entries (full colours), then `slots` more (trace) with a trace. */
  lut: Uint8Array;
  slots: number;
  lutStepDeg: number;
}

/** Opacity factor of the faint trace on filtered-out steep ground (#723). */
export const SLOPE_TRACE_ALPHA = 0.2;

export function slopePalette(minDeg: number, maxDeg = 90, withTrace = false): SlopePalette {
  'worklet';
  const lutStepDeg = 0.005;
  const slots = Math.round(90 / lutStepDeg) + 1;
  const n = withTrace ? slots * 2 : slots;
  const colours = new Uint8Array(n * 4);
  for (let k = 0; k < slots; k++) {
    const c = slopeOverlayColor(k * lutStepDeg, minDeg, maxDeg);
    colours[k * 4] = c[0];
    colours[k * 4 + 1] = c[1];
    colours[k * 4 + 2] = c[2];
    colours[k * 4 + 3] = c[3];
    if (withTrace) {
      const t = (slots + k) * 4;
      const a = Math.round(c[3] * SLOPE_TRACE_ALPHA);
      if (a > 0) {
        colours[t] = c[0];
        colours[t + 1] = c[1];
        colours[t + 2] = c[2];
        colours[t + 3] = a;
      }
    }
  }
  // Drawn-colour distance between LUT slots i and j.
  const dist = (i: number, j: number) => {
    const ai = colours[i * 4 + 3] as number;
    const aj = colours[j * 4 + 3] as number;
    let d = Math.abs(ai - aj);
    for (let ch = 0; ch < 3; ch++) {
      const pi = ((colours[i * 4 + ch] as number) * ai) / 255;
      const pj = ((colours[j * 4 + ch] as number) * aj) / 255;
      d = Math.max(d, Math.abs(pi - pj));
    }
    return d;
  };
  for (let tol = 0; ; tol += 0.25) {
    const lut = new Uint8Array(n);
    const rgb = new Uint8Array(256 * 3);
    const alpha = new Uint8Array(256);
    let count = 1;
    let start = -1; // first LUT slot of the open run (-1: none)
    let last = -1;
    // An entry wears the colour of its run's middle slot: a plateau's run
    // also catches the blend tail within `tol`, but its middle is exact.
    const close = () => {
      if (start < 0) return;
      const mid = (start + last) >> 1;
      const e = count - 1;
      rgb[e * 3] = colours[mid * 4] as number;
      rgb[e * 3 + 1] = colours[mid * 4 + 1] as number;
      rgb[e * 3 + 2] = colours[mid * 4 + 2] as number;
      alpha[e] = colours[mid * 4 + 3] as number;
      start = -1;
    };
    let fits = true;
    for (let k = 0; k < n; k++) {
      if (colours[k * 4 + 3] === 0) {
        close(); // lut[k] stays 0: transparent
        continue;
      }
      if (start < 0 || dist(start, k) > tol) {
        close();
        if (count === 256) {
          fits = false;
          break;
        }
        start = k;
        count++;
      }
      last = k;
      lut[k] = count - 1;
    }
    close();
    if (fits) {
      return {
        rgb: rgb.slice(0, count * 3),
        alpha: alpha.slice(0, count),
        count,
        lut,
        slots,
        lutStepDeg,
      };
    }
  }
}

/**
 * Palette index of a slope (degrees; NaN → 0, transparent); `trace` picks the
 * faint-trace colour (palettes built `withTrace` only).
 */
export function slopePaletteIndex(p: SlopePalette, slopeDeg: number, trace = false): number {
  'worklet';
  if (!(slopeDeg >= 0)) return 0;
  const k = Math.round(Math.min(slopeDeg, 90) / p.lutStepDeg);
  return p.lut[trace && p.lut.length > p.slots ? p.slots + k : k] as number;
}

/**
 * What the slope overlay shows at full colour (#723): steep ground whose
 * aspect sector is selected AND whose elevation is inside the altitude range.
 * Steep ground failing either test draws as the faint trace; ground outside
 * the steepness window stays transparent as before. Pass
 * {@link NO_SLOPE_FILTER} (all 8 sectors, no altitude bounds) for no filter.
 */
export interface SlopeFilter {
  /** Bit s set = aspect sector s selected (0 = N, 1 = NE … 7 = NW; see aspectSector). */
  aspectMask: number;
  /** Inclusive altitude bounds in metres; null = unbounded. */
  minAltM: number | null;
  maxAltM: number | null;
}

export const NO_SLOPE_FILTER: SlopeFilter = { aspectMask: 0xff, minAltM: null, maxAltM: null };

export function slopeFilterActive(f: SlopeFilter): boolean {
  'worklet';
  return (f.aspectMask & 0xff) !== 0xff || f.minAltM !== null || f.maxAltM !== null;
}

/**
 * Whether one DEM pixel passes the filter: its aspect (degrees, NaN = flat)
 * and elevation (m, NaN / void = no data → fails).
 */
export function slopeFilterPass(f: SlopeFilter, aspectDeg: number, elevationM: number): boolean {
  'worklet';
  if ((f.aspectMask & 0xff) !== 0xff) {
    const sector = aspectSector(aspectDeg);
    if (sector < 0 || ((f.aspectMask >> sector) & 1) === 0) return false;
  }
  if (f.minAltM !== null || f.maxAltM !== null) {
    if (!(elevationM >= NODATA_BELOW_M)) return false;
    if (f.minAltM !== null && elevationM < f.minAltM) return false;
    if (f.maxAltM !== null && elevationM > f.maxAltM) return false;
  }
  return true;
}

/** Web-Mercator circumference at the equator, metres (EPSG:3857). */
const EARTH_CIRCUMFERENCE_M = 40075016.686;

/**
 * Ground metres covered by one pixel of a Web-Mercator tile pyramid
 * (`tilePx`-pixel tiles) at a latitude and zoom, on the sphere. The slope
 * itself uses the ellipsoidal sizes of `mercatorPixelGroundM` (slopeField).
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

/** The same overlay as palette indices (see {@link SlopePalette}). */
export interface SlopeOverlayIndexed {
  indices: Uint8Array;
  palette: SlopePalette;
  width: number;
  height: number;
}

/**
 * The 2D map's slope-band overlay as an indexed image, computed at the DEM's
 * FULL resolution (#461) by {@link slopeAspectField} (Horn, true ellipsoidal
 * pixel size per row, exact edges, no-data aware — see slopeField). `data` is
 * a Web-Mercator elevation mosaic (metres, row-major, `width` × `height`,
 * row 0 = north) whose row 0 is global pixel row `topRow` of zoom `z`.
 *
 * Only then is the SLOPE averaged down by `step` × `step` blocks to keep the
 * image a sensible size. `step` must divide `width` and `height` for the image
 * to stay registered on the mosaic's corners (a ragged last block would be
 * stretched over a full image pixel); the 2D overlay's tile-multiple mosaics
 * and power-of-two steps always do.
 */
export function slopeOverlayIndexed(
  data: ArrayLike<number>,
  width: number,
  height: number,
  z: number,
  topRow: number,
  minDeg: number,
  maxDeg = 90,
  step = 1,
  filterArg?: SlopeFilter,
): SlopeOverlayIndexed {
  'worklet';
  // No default-parameter constant: worklet closures do not capture identifiers
  // used only in parameter defaults (on device: "NO_SLOPE_FILTER doesn't exist").
  const filter = filterArg ?? NO_SLOPE_FILTER;
  const active = slopeFilterActive(filter);
  // One pass: slope, and the aspect only when a sector filter needs it.
  const field = slopeAspectField(
    data,
    width,
    height,
    z,
    topRow,
    (filter.aspectMask & 0xff) !== 0xff,
  );
  const img = blockMeanDegrees(field.slope, width, height, step);
  // Filter verdict per DEM pixel (1 pass / 0 fail / NaN no data), averaged
  // over the same blocks: a block draws in full colour when at least half
  // of its pixels pass.
  let passFrac: Float32Array | null = null;
  if (active) {
    const pass = new Float32Array(width * height);
    const aspect = field.aspect;
    for (let i = 0; i < pass.length; i++) {
      const sl = field.slope[i] as number;
      pass[i] =
        sl !== sl
          ? NaN
          : slopeFilterPass(filter, aspect !== null ? (aspect[i] as number) : 0, data[i] as number)
            ? 1
            : 0;
    }
    passFrac = blockMeanDegrees(pass, width, height, step).data;
  }
  const palette = slopePalette(minDeg, maxDeg, active);
  const indices = new Uint8Array(img.width * img.height);
  const lut = palette.lut;
  const traceOffset = palette.slots;
  const inv = 1 / palette.lutStepDeg;
  for (let o = 0; o < indices.length; o++) {
    const d = img.data[o] as number;
    // Inlined slopePaletteIndex (hot loop).
    if (d >= 0) {
      const k = Math.round((d < 90 ? d : 90) * inv);
      const full = passFrac === null || (passFrac[o] as number) >= 0.5;
      indices[o] = lut[full ? k : traceOffset + k] as number;
    }
  }
  return { indices, palette, width: img.width, height: img.height };
}

/** {@link slopeOverlayIndexed} expanded to RGBA (map maker, tests). */
export function slopeOverlayMercator(
  data: ArrayLike<number>,
  width: number,
  height: number,
  z: number,
  topRow: number,
  minDeg: number,
  maxDeg = 90,
  step = 1,
  filter: SlopeFilter = NO_SLOPE_FILTER,
): SlopeOverlayImage {
  const ix = slopeOverlayIndexed(data, width, height, z, topRow, minDeg, maxDeg, step, filter);
  const { rgb, alpha } = ix.palette;
  const rgba = new Uint8Array(ix.indices.length * 4);
  for (let o = 0; o < ix.indices.length; o++) {
    const k = ix.indices[o] as number;
    if (k === 0) continue;
    rgba[o * 4] = rgb[k * 3] as number;
    rgba[o * 4 + 1] = rgb[k * 3 + 1] as number;
    rgba[o * 4 + 2] = rgb[k * 3 + 2] as number;
    rgba[o * 4 + 3] = alpha[k] as number;
  }
  return { rgba, width: ix.width, height: ix.height };
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
