import type { Feature, FeatureCollection, Point } from 'geojson';
import type { FloatGrid } from './floatTiff';
import { isDepthNoData } from './marineDepth';
import { gridXToLon, gridYToLat, type MarineGridCrs } from './marineSources';

/**
 * Classic ENC chart rendering of the raw NONNA depth grid (marine wave D §D2,
 * owner spec 2026-08-09: "exactly the iBoating look"). Instead of the CHS
 * server's harsh rainbow mosaic, the client draws the paper-chart idiom:
 *
 * - QUANTIZED depth bands at standard chart breaks (0–2 m chart blue,
 *   2–5 m mid, 5–10 m pale, deeper white), the intertidal/drying zone in
 *   chart green;
 * - thin near-black CONTOUR lines where the depth crosses a chart level
 *   (band edges + the deeper 20/30/50/100 m lines through the white);
 * - SPOT SOUNDINGS — sparse depth numbers picked per grid block (the
 *   controlling/shallowest cell), exported as GeoJSON for a symbol layer.
 *
 * The pixel pipeline heals NONNA's 1-px nodata seam lines (every 0.01°
 * granule boundary), composites NONNA 100 under NONNA 10 (the coarse fringe
 * where the dense grid has no cells), samples depths bilinearly at 2× the
 * grid resolution (smooth curved band edges instead of the WMS stair-steps)
 * and quantizes to the band palette. Depth convention throughout: NONNA
 * values are NEGATIVE metres below chart datum; "depth d" here is the
 * positated −value (drying heights land at d < 0).
 *
 * Pure math + pixels — the PNG encoding, file writing and MapLibre wiring
 * live outside core.
 */

/** One chart band: depths in [min, max) get `color`. */
export interface DepthBand {
  /** Upper edge of the band, metres below chart datum (exclusive). */
  maxDepthM: number;
  /** Fill colour (chart palette, matched to the approved reference). */
  color: string;
}

/**
 * The chart band palette, shallow to deep. Depths below 0 (drying heights /
 * intertidal) take the green band; everything at 10 m+ is chart white.
 */
export const DEPTH_BANDS: readonly DepthBand[] = [
  { maxDepthM: 0, color: '#8FB491' }, // drying / intertidal green
  { maxDepthM: 2, color: '#A3C6E6' }, // 0–2 m chart blue
  { maxDepthM: 5, color: '#BDD8EF' }, // 2–5 m
  { maxDepthM: 10, color: '#D9E9F6' }, // 5–10 m
  { maxDepthM: Infinity, color: '#F8FBFE' }, // 10 m+ chart white
];

/** Band-edge depths for the legend pill, metres. */
export const DEPTH_BAND_BREAKS_M: readonly number[] = [0, 2, 5, 10];

/**
 * Contour levels, metres: the band edges plus the deeper lines that give the
 * white channel its classic look.
 */
export const DEPTH_CONTOUR_LEVELS_M: readonly number[] = [0, 2, 5, 10, 20, 30, 50, 100];

/** Contour ink: thin near-black lines, like the reference chart. */
const CONTOUR_R = 0x2a;
const CONTOUR_G = 0x36;
const CONTOUR_B = 0x40;

/** Flat chart-blue for uncharted water (the vector water fill under the drape). */
export const CHART_WATER_COLOR = '#A3C6E6';
/** Chart-tan wash for land in marine mode. */
export const CHART_LAND_COLOR = '#E7D7A9';
/** Spot-sounding text inks (regular / shallow-hazard). */
export const SOUNDING_INK = '#26343F';
export const SOUNDING_SHALLOW_INK = '#155CA8';
/** Soundings shallower than this take the hazard ink, metres. */
export const SOUNDING_SHALLOW_M = 5;

/** Band index for a depth (metres below datum; negative = drying). */
export function depthBandIndex(depthM: number): number {
  for (let i = 0; i < DEPTH_BANDS.length; i++) {
    const band = DEPTH_BANDS[i];
    if (band !== undefined && depthM < band.maxDepthM) return i;
  }
  return DEPTH_BANDS.length - 1;
}

/** Contour index: how many chart levels lie at or above this depth. */
function contourIndex(depthM: number): number {
  let n = 0;
  for (const level of DEPTH_CONTOUR_LEVELS_M) if (depthM >= level) n++;
  return n;
}

const hexChannel = (hex: string, i: number): number =>
  parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);

const BAND_RGB: readonly [number, number, number][] = DEPTH_BANDS.map((b) => [
  hexChannel(b.color, 0),
  hexChannel(b.color, 1),
  hexChannel(b.color, 2),
]);

/**
 * Heal NONNA's 1-px nodata seam lines: a nodata cell flanked by valid cells
 * on opposite sides (left/right or up/down) takes their mean. The second
 * pass closes the intersection cell where two granule seams cross (all four
 * of its neighbours are seam cells until the first pass heals them). Coast
 * edges (valid on one side only) are deliberately NOT filled — the chart
 * must not grow water over land. Returns a new grid; the input is untouched.
 */
export function infillSeams(grid: FloatGrid, passes = 2): FloatGrid {
  const { width, height } = grid;
  let data = grid.data;
  for (let p = 0; p < passes; p++) {
    const next = Float32Array.from(data);
    let filled = 0;
    for (let r = 0; r < height; r++) {
      for (let c = 0; c < width; c++) {
        const i = r * width + c;
        if (!isDepthNoData(data[i])) continue;
        const left = c > 0 ? data[i - 1] : undefined;
        const right = c < width - 1 ? data[i + 1] : undefined;
        const up = r > 0 ? data[i - width] : undefined;
        const down = r < height - 1 ? data[i + width] : undefined;
        if (
          left !== undefined &&
          right !== undefined &&
          !isDepthNoData(left) &&
          !isDepthNoData(right)
        ) {
          next[i] = (left + right) / 2;
          filled++;
        } else if (
          up !== undefined &&
          down !== undefined &&
          !isDepthNoData(up) &&
          !isDepthNoData(down)
        ) {
          next[i] = (up + down) / 2;
          filled++;
        }
      }
    }
    data = next;
    if (filled === 0) break;
  }
  return { ...grid, data };
}

/**
 * Validity-weighted bilinear sample at fractional pixel coords (pixel-centre
 * convention), or null when every neighbour is nodata. Nodata neighbours
 * just drop out of the weighting, so band edges stay smooth right up to the
 * coast without bleeding the nilValue into the interpolation.
 */
function sampleDepthValue(grid: FloatGrid, fx: number, fy: number): number | null {
  if (fx < -0.5 || fy < -0.5 || fx > grid.width - 0.5 || fy > grid.height - 0.5) return null;
  const w = grid.width;
  const data = grid.data;
  const x0 = Math.max(0, Math.min(w - 1, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(grid.height - 1, Math.floor(fy)));
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(grid.height - 1, y0 + 1);
  const tx = Math.max(0, Math.min(1, fx - x0));
  const ty = Math.max(0, Math.min(1, fy - y0));
  let sum = 0;
  let weight = 0;
  // Unrolled (no per-sample closure): this runs once per OUTPUT PIXEL of the
  // drape — ~1 Mpx per camera settle — so an allocation here is a frame.
  const r0 = y0 * w;
  const r1 = y1 * w;
  const w00 = (1 - tx) * (1 - ty);
  const w10 = tx * (1 - ty);
  const w01 = (1 - tx) * ty;
  const w11 = tx * ty;
  let v = data[r0 + x0];
  if (w00 > 0 && v !== undefined && !isDepthNoData(v)) {
    sum += v * w00;
    weight += w00;
  }
  v = data[r0 + x1];
  if (w10 > 0 && v !== undefined && !isDepthNoData(v)) {
    sum += v * w10;
    weight += w10;
  }
  v = data[r1 + x0];
  if (w01 > 0 && v !== undefined && !isDepthNoData(v)) {
    sum += v * w01;
    weight += w01;
  }
  v = data[r1 + x1];
  if (w11 > 0 && v !== undefined && !isDepthNoData(v)) {
    sum += v * w11;
    weight += w11;
  }
  // Under a quarter of the full weight = an isolated corner touching the
  // sample — treat as no data so coasts keep a crisp edge.
  return weight >= 0.25 ? sum / weight : null;
}

/**
 * The composite chart value (NONNA metres, negative below datum) at a
 * mercator point: the dense grid wins; the coarse grid fills its fringe.
 */
function compositeValueAtMerc(
  grid10: FloatGrid,
  grid100: FloatGrid | null,
  xMerc: number,
  yMerc: number,
): number | null {
  const fx10 = (xMerc - grid10.x0) / grid10.dx - 0.5;
  const fy10 = (grid10.y0 - yMerc) / grid10.dy - 0.5;
  const v10 = sampleDepthValue(grid10, fx10, fy10);
  if (v10 !== null) return v10;
  if (grid100 === null) return null;
  const fx = (xMerc - grid100.x0) / grid100.dx - 0.5;
  const fy = (grid100.y0 - yMerc) / grid100.dy - 0.5;
  return sampleDepthValue(grid100, fx, fy);
}

/**
 * Mask the dry land out of an ELEVATION grid (marine wave D §D3): NONNA and
 * EMODnet publish depth with a nodata value over land, but the NOAA NCEI
 * mosaic is a continuous terrain model — without this every hill above the
 * shore would render as a vast drying flat. Values at or above `cutoffM`
 * metres above chart datum become NaN, which the sampler already reads as
 * "no data" (small positive values survive: those are real drying heights).
 * Returns a new grid unless nothing needed masking.
 */
export function maskLandAbove(grid: FloatGrid, cutoffM: number): FloatGrid {
  let hit = false;
  for (let i = 0; i < grid.data.length; i++) {
    const v = grid.data[i];
    if (v !== undefined && Number.isFinite(v) && v >= cutoffM) {
      hit = true;
      break;
    }
  }
  if (!hit) return grid;
  const data = Float32Array.from(grid.data);
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v !== undefined && Number.isFinite(v) && v >= cutoffM) data[i] = NaN;
  }
  return { ...grid, data };
}

export interface DepthChartImage {
  width: number;
  height: number;
  /** RGBA pixels, row 0 = the grid's top (max-y) edge. */
  rgba: Uint8Array;
}

/** Output upsampling vs the source grid (crisper band edges + contours). */
const RENDER_SCALE = 2;
/**
 * Hard cap on the rendered bitmap's larger axis. Every output pixel costs a
 * bilinear composite in JS on the camera-settle path, so this is a
 * responsiveness budget: paired with `DEPTH_MAX_GRID_DIM` (384) a full
 * viewport renders ~0.4 Mpx, the same order as the 2D terrain pipeline's
 * per-settle analysis.
 */
const MAX_RENDER_DIM = 1152;

/**
 * Render the chart bands + contour lines for the (seam-healed, composited)
 * grids. Output pixels align with `grid10`'s georeference at RENDER_SCALE×
 * its resolution; cells with no data in either grid stay transparent (the
 * flat chart-blue water fill shows through). Null on degenerate grids.
 */
export function renderDepthChart(
  grid10: FloatGrid,
  grid100: FloatGrid | null,
): DepthChartImage | null {
  if (grid10.width < 2 || grid10.height < 2) return null;
  const scale = Math.min(RENDER_SCALE, MAX_RENDER_DIM / Math.max(grid10.width, grid10.height));
  const outW = Math.max(1, Math.round(grid10.width * scale));
  const outH = Math.max(1, Math.round(grid10.height * scale));
  const g10 = infillSeams(grid10);
  const g100 = grid100 !== null ? infillSeams(grid100, 1) : null;
  const rgba = new Uint8Array(outW * outH * 4);
  // Contour index per output pixel for the current and previous row — contour
  // lines compare each pixel's index against its left/top neighbours. Stored
  // as the INDEX (not the depth) so `contourIndex` runs once per pixel
  // instead of three times; -1 marks "no data here".
  const rowCi = new Int16Array(outW).fill(-1);
  const prevCi = new Int16Array(outW).fill(-1);
  // Column mercator coordinates are row-invariant — hoist them out of the
  // inner loop (one multiply per pixel saved over ~1 Mpx).
  const xs = new Float64Array(outW);
  for (let px = 0; px < outW; px++) xs[px] = g10.x0 + ((px + 0.5) / scale) * g10.dx;
  for (let py = 0; py < outH; py++) {
    prevCi.set(rowCi);
    rowCi.fill(-1);
    const yMerc = g10.y0 - ((py + 0.5) / scale) * g10.dy;
    let o = py * outW * 4;
    for (let px = 0; px < outW; px++, o += 4) {
      // `?? 0` would silently sample column zero for the whole row; px is
      // always in range, so an out-of-range read is a bug, not a pixel.
      const xMerc = xs[px];
      if (xMerc === undefined) continue;
      const value = compositeValueAtMerc(g10, g100, xMerc, yMerc);
      if (value === null) continue; // transparent — uncharted
      const d = -value; // metres below datum; drying lands negative
      const band = BAND_RGB[depthBandIndex(d)] ?? [255, 255, 255];
      let [r, g, b] = band;
      // Contour: this pixel crossed a chart level vs its left or top
      // neighbour → draw the thin near-black line instead of the band fill.
      const ci = contourIndex(d);
      rowCi[px] = ci;
      const leftCi = px > 0 ? rowCi[px - 1] : -1;
      const topCi = prevCi[px];
      if (
        (leftCi !== undefined && leftCi >= 0 && leftCi !== ci) ||
        (topCi !== undefined && topCi >= 0 && topCi !== ci)
      ) {
        r = CONTOUR_R;
        g = CONTOUR_G;
        b = CONTOUR_B;
      }
      rgba[o] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = b;
      rgba[o + 3] = 255;
    }
  }
  return { width: outW, height: outH, rgba };
}

/**
 * Geographic corners of the rendered chart image, MapLibre ImageSource
 * order: top-left, top-right, bottom-right, bottom-left ([lng, lat]).
 * The grid is axis-aligned in mercator, so the corners are exact.
 */
export function depthChartCorners(
  grid10: FloatGrid,
  crs: MarineGridCrs = 'EPSG:3857',
): [[number, number], [number, number], [number, number], [number, number]] {
  const west = gridXToLon(crs, grid10.x0);
  const east = gridXToLon(crs, grid10.x0 + grid10.dx * grid10.width);
  const north = gridYToLat(crs, grid10.y0);
  const south = gridYToLat(crs, grid10.y0 - grid10.dy * grid10.height);
  return [
    [west, north],
    [east, north],
    [east, south],
    [west, south],
  ];
}

/** One spot sounding: position + metres below chart datum (negative = drying). */
export interface Sounding {
  lon: number;
  lat: number;
  depthM: number;
}

/** Grid cells per sounding block (≈ every 60–80 screen px at drape zooms). */
const SOUNDING_BLOCK_CELLS = 26;
/** Safety cap on soundings per chart (MapLibre collision thins on screen). */
const MAX_SOUNDINGS = 400;

/**
 * Thinned spot soundings: per block of the dense grid, the CONTROLLING
 * (shallowest) valid cell — the chart convention; in the deep channel the
 * block minimum is simply the local depth, so numbers appear everywhere the
 * reference shows them. Positions are cell centres.
 */
export function selectSoundings(
  grid10: FloatGrid,
  grid100: FloatGrid | null,
  crs: MarineGridCrs = 'EPSG:3857',
): Sounding[] {
  const out: Sounding[] = [];
  const block = SOUNDING_BLOCK_CELLS;
  const g10 = infillSeams(grid10, 1);
  for (let by = 0; by < grid10.height && out.length < MAX_SOUNDINGS; by += block) {
    for (let bx = 0; bx < grid10.width && out.length < MAX_SOUNDINGS; bx += block) {
      let best: { c: number; r: number; v: number } | null = null;
      const rEnd = Math.min(by + block, grid10.height);
      const cEnd = Math.min(bx + block, grid10.width);
      for (let r = by; r < rEnd; r++) {
        for (let c = bx; c < cEnd; c++) {
          const v = g10.data[r * grid10.width + c];
          if (v === undefined || isDepthNoData(v)) continue;
          // Shallowest = largest NONNA value (values are negative-down).
          if (best === null || v > best.v) best = { c, r, v };
        }
      }
      if (best === null && grid100 !== null) {
        // Coarse-fringe block: sample the NONNA 100 composite at the centre.
        const xMerc = grid10.x0 + (bx + (cEnd - bx) / 2) * grid10.dx;
        const yMerc = grid10.y0 - (by + (rEnd - by) / 2) * grid10.dy;
        const v = compositeValueAtMerc(grid10, grid100, xMerc, yMerc);
        if (v !== null) {
          out.push({ lon: gridXToLon(crs, xMerc), lat: gridYToLat(crs, yMerc), depthM: -v });
        }
        continue;
      }
      if (best !== null) {
        const xMerc = grid10.x0 + (best.c + 0.5) * grid10.dx;
        const yMerc = grid10.y0 - (best.r + 0.5) * grid10.dy;
        out.push({ lon: gridXToLon(crs, xMerc), lat: gridYToLat(crs, yMerc), depthM: -best.v });
      }
    }
  }
  return out;
}

const M_TO_FT = 3.28084;

/**
 * Sounding label, chart-style: one decimal below 30 m (ENC keeps decimals on
 * shallow soundings), whole numbers beyond; drying heights are bracketed
 * ("(1.2)") like drying soundings on paper charts.
 */
export function soundingLabel(depthM: number, imperial: boolean): string {
  const mag = Math.abs(depthM) * (imperial ? M_TO_FT : 1);
  const text = mag < 30 ? (Math.round(mag * 10) / 10).toString() : Math.round(mag).toString();
  return depthM < 0 ? `(${text})` : text;
}

export type SoundingProperties = {
  label: string;
  /** 1 = shallower than the hazard threshold (blue ink, wins collisions). */
  shallow: 0 | 1;
  /** Symbol sort key — shallowest first. */
  sort: number;
};

/** The soundings as a GeoJSON FeatureCollection for a symbol layer. */
export function soundingsFeatureCollection(
  soundings: readonly Sounding[],
  imperial: boolean,
): FeatureCollection<Point, SoundingProperties> {
  const features: Feature<Point, SoundingProperties>[] = soundings.map((s) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
    properties: {
      label: soundingLabel(s.depthM, imperial),
      shallow: s.depthM < SOUNDING_SHALLOW_M ? 1 : 0,
      sort: s.depthM,
    },
  }));
  return { type: 'FeatureCollection', features };
}
