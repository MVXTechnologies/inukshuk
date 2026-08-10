import type { FloatGrid } from './floatTiff';

/**
 * CHS NONNA raw-depth access over WCS (marine wave D, D1/D2): URL builders,
 * fetch-bbox logic and depth sampling for the client-rendered chart drape
 * and the tap-for-depth readout. All shapes verified live 2026-08-09:
 *
 * - Coverages `nonna__NONNA 10 Coverage` / `nonna__NONNA 100 Coverage`,
 *   world EPSG:3857 mosaics (19.0986 × 19.1202 m cells for NONNA 10 —
 *   ~13 m ground at 46.8°N, the hard data ceiling; ~153 m for NONNA 100).
 * - `subset=x(..)&subset=y(..)` in mercator metres; `format=image/tiff`
 *   answers an uncompressed big-endian tiled float32 GeoTIFF
 *   (`@core/geo/floatTiff` decodes it).
 * - GeoServer's scaling extension (`scalesize=i(..),j(..)`) is honored —
 *   a viewport fetch caps its grid instead of pulling megapixels.
 * - Nodata is the float32-max nilValue (3.4028234663852886e38); 1-px nodata
 *   seams run along every 0.01° source-granule boundary, so point queries
 *   fetch a 3×3 neighbourhood and take the nearest valid cell, never a bare
 *   pixel. Depths are NEGATIVE metres below chart datum (drying heights are
 *   positive) — the plan's reference point 46.78502°N 71.21338°W reads
 *   −26.47 m.
 */

export const NONNA_WCS_ENDPOINT = 'https://nonna-geoserver.data.chs-shc.ca/geoserver/nonna/ows';

export const NONNA_COVERAGE_IDS = {
  nonna10: 'nonna__NONNA 10 Coverage',
  nonna100: 'nonna__NONNA 100 Coverage',
} as const;

export type NonnaCoverage = keyof typeof NONNA_COVERAGE_IDS;

/** NONNA 10 native cell size, mercator metres (from DescribeCoverage). */
export const NONNA10_CELL_M = 19.0986;

/** The nilValue NONNA emits for "no survey here" (float32 max). */
export const NONNA_NODATA = 3.4028234663852886e38;

/** Is a sampled cell value unusable (nodata / junk)? */
export function isDepthNoData(v: number | undefined): boolean {
  return v === undefined || !Number.isFinite(v) || Math.abs(v) >= 3e38;
}

/** A geographic box, degrees (west < east, south < north). */
export interface GeoBbox {
  west: number;
  south: number;
  east: number;
  north: number;
}

const EARTH_HALF_CIRCUMFERENCE_M = 20037508.342789244;
/** Web-mercator latitude cut-off. */
const MERC_LAT_LIMIT = 85.05112878;

/** Longitude (degrees) → EPSG:3857 x (metres). */
export function lonToMercX(lon: number): number {
  return (lon * EARTH_HALF_CIRCUMFERENCE_M) / 180;
}

/** Latitude (degrees, clamped to the mercator limit) → EPSG:3857 y (metres). */
export function latToMercY(lat: number): number {
  const clamped = Math.max(-MERC_LAT_LIMIT, Math.min(MERC_LAT_LIMIT, lat));
  return (
    (Math.log(Math.tan(((90 + clamped) * Math.PI) / 360)) * EARTH_HALF_CIRCUMFERENCE_M) / Math.PI
  );
}

/** EPSG:3857 x (metres) → longitude (degrees). */
export function mercXToLon(x: number): number {
  return (x / EARTH_HALF_CIRCUMFERENCE_M) * 180;
}

/** EPSG:3857 y (metres) → latitude (degrees). */
export function mercYToLat(y: number): number {
  return (Math.atan(Math.exp((y * Math.PI) / EARTH_HALF_CIRCUMFERENCE_M)) * 360) / Math.PI - 90;
}

/**
 * Above this viewport span (degrees, either axis) the chart drape stays off:
 * NONNA cells are subpixel out there and the flat chart-blue water fill
 * carries the look by itself (the iBoating overview idiom).
 */
export const DEPTH_MAX_VIEW_SPAN_DEG = 6;

/** Padding factor: fetch ~1.5× the viewport so pans don't refetch instantly. */
const BBOX_PAD_FACTOR = 1.5;
/** Bbox edges snap to this grid so nearby anchors share a cache entry. */
const BBOX_QUANT_DEG = 0.05;
/** Hard cap on the fetched span per axis, degrees. */
const BBOX_MAX_SPAN_DEG = 9;
/** Floor on the fetched span — keeps the WCS subset non-degenerate. */
const BBOX_MIN_SPAN_DEG = 0.01;
/** Mercator maps break down at the poles; clamp fetches inside this. */
const LAT_LIMIT = 84;

/**
 * Cap on the fetched grid's larger axis: past this the URL adds a
 * `scalesize` reduction. Sized against the RENDER cost, not the wire — the
 * chart bitmap is drawn pixel-by-pixel in JS on every camera settle, so the
 * budget is the same order as the terrain pipeline's 256-cell analysis grid.
 * 384² float32 ≈ 0.6 MB on the wire (an unreduced viewport subset measured
 * 5.3 MB) and ~0.4 Mpx of output at the renderer's 2× upsample.
 */
export const DEPTH_MAX_GRID_DIM = 576;

const quantNear = (v: number): number => Math.round(v / BBOX_QUANT_DEG) * BBOX_QUANT_DEG;
const quantUp = (v: number): number => Math.ceil(v / BBOX_QUANT_DEG) * BBOX_QUANT_DEG;

/**
 * The padded, quantized fetch bbox for a viewport, or null when the chart
 * drape is out of scope (over-wide, degenerate, antimeridian). Centre-snapped
 * like `windFetchBbox` so nearby viewports share a cache entry.
 */
export function depthFetchBbox(view: GeoBbox): GeoBbox | null {
  const lonSpan = view.east - view.west;
  const latSpan = view.north - view.south;
  if (!(lonSpan > 0) || !(latSpan > 0)) return null;
  if (lonSpan > DEPTH_MAX_VIEW_SPAN_DEG || latSpan > DEPTH_MAX_VIEW_SPAN_DEG) return null;
  if (view.west < -180 || view.east > 180) return null;
  const cx = quantNear((view.west + view.east) / 2);
  const cy = quantNear((view.south + view.north) / 2);
  const half = (span: number): number =>
    quantUp(
      Math.min(
        Math.max((span * BBOX_PAD_FACTOR) / 2, BBOX_MIN_SPAN_DEG / 2),
        BBOX_MAX_SPAN_DEG / 2,
      ),
    );
  const halfLon = half(lonSpan);
  const halfLat = half(latSpan);
  const west = Math.max(-180, cx - halfLon);
  const east = Math.min(180, cx + halfLon);
  const south = Math.max(-LAT_LIMIT, cy - halfLat);
  const north = Math.min(LAT_LIMIT, cy + halfLat);
  if (!(east > west) || !(north > south)) return null;
  return { west, south, east, north };
}

/**
 * Should the drape re-anchor (fetch a new bbox + re-render)? Same rule as
 * the wind field: the viewport escaped the anchored bbox, or shrank so far
 * below it that a tighter subset buys real grid resolution.
 */
export function needsDepthReanchor(anchor: GeoBbox, view: GeoBbox): boolean {
  if (view.west < anchor.west || view.east > anchor.east) return true;
  if (view.south < anchor.south || view.north > anchor.north) return true;
  const anchorSpan = Math.max(anchor.east - anchor.west, anchor.north - anchor.south);
  const viewSpan = Math.max(view.east - view.west, view.north - view.south);
  return viewSpan > 0 && anchorSpan / viewSpan > 4 * BBOX_PAD_FACTOR;
}

/** Cache key for a fetched depth chart (bbox-quantized, so stable). */
export function depthChartCacheKey(bbox: GeoBbox): string {
  const fmt = (v: number): string => v.toFixed(2);
  return `${fmt(bbox.west)},${fmt(bbox.south)},${fmt(bbox.east)},${fmt(bbox.north)}`;
}

/**
 * WCS GetCoverage URL for a NONNA coverage over a geographic bbox. The
 * subset is expressed in mercator metres; when the native cell count would
 * exceed `maxDim` on either axis, a proportional `scalesize` reduction is
 * appended (GeoServer honors it — verified live).
 */
export function depthCoverageUrl(
  coverage: NonnaCoverage,
  bbox: GeoBbox,
  maxDim: number = DEPTH_MAX_GRID_DIM,
): string {
  const x0 = lonToMercX(bbox.west);
  const x1 = lonToMercX(bbox.east);
  const y0 = latToMercY(bbox.south);
  const y1 = latToMercY(bbox.north);
  const cell = coverage === 'nonna10' ? NONNA10_CELL_M : NONNA10_CELL_M * 8;
  const nativeW = Math.max(1, Math.round((x1 - x0) / cell));
  const nativeH = Math.max(1, Math.round((y1 - y0) / cell));
  const scale = Math.min(1, maxDim / Math.max(nativeW, nativeH));
  const params = [
    'service=WCS',
    'version=2.0.1',
    'request=GetCoverage',
    `coverageId=${encodeURIComponent(NONNA_COVERAGE_IDS[coverage])}`,
    `subset=x(${x0.toFixed(1)},${x1.toFixed(1)})`,
    `subset=y(${y0.toFixed(1)},${y1.toFixed(1)})`,
    'format=image/tiff',
    ...(scale < 1
      ? [
          `scalesize=i(${Math.max(1, Math.round(nativeW * scale))}),j(${Math.max(
            1,
            Math.round(nativeH * scale),
          )})`,
        ]
      : []),
  ];
  return `${NONNA_WCS_ENDPOINT}?${params.join('&')}`;
}

/**
 * WCS GetCoverage URL for the 3×3-cell neighbourhood around a point (the
 * tap-for-depth query). ±1.5 cells so the answer is exactly 3×3 — wide
 * enough to step over a 1-px granule seam, small enough to stay ~1.4 KB.
 */
export function depthPointUrl(coverage: NonnaCoverage, lat: number, lon: number): string {
  const cell = coverage === 'nonna10' ? NONNA10_CELL_M : NONNA10_CELL_M * 8;
  const half = cell * 1.5;
  const x = lonToMercX(lon);
  const y = latToMercY(lat);
  const params = [
    'service=WCS',
    'version=2.0.1',
    'request=GetCoverage',
    `coverageId=${encodeURIComponent(NONNA_COVERAGE_IDS[coverage])}`,
    `subset=x(${(x - half).toFixed(1)},${(x + half).toFixed(1)})`,
    `subset=y(${(y - half).toFixed(1)},${(y + half).toFixed(1)})`,
    'format=image/tiff',
  ];
  return `${NONNA_WCS_ENDPOINT}?${params.join('&')}`;
}

/**
 * The valid cell nearest the grid's centre, or null when every cell is
 * nodata (the seam-line fallback for point queries: the centre pixel can sit
 * exactly on a 0.01° granule seam).
 */
export function nearestValidDepth(grid: FloatGrid): number | null {
  const cx = (grid.width - 1) / 2;
  const cy = (grid.height - 1) / 2;
  let best: number | null = null;
  let bestD = Infinity;
  for (let r = 0; r < grid.height; r++) {
    for (let c = 0; c < grid.width; c++) {
      const v = grid.data[r * grid.width + c];
      if (v === undefined || isDepthNoData(v)) continue;
      const d = Math.hypot(c - cx, r - cy);
      if (d < bestD) {
        bestD = d;
        best = v;
      }
    }
  }
  return best;
}

const M_TO_FT = 3.28084;

/**
 * Chip line for a sampled NONNA value (negative = below chart datum,
 * positive = drying height): "Depth 26.5 m · chart datum" /
 * "Drying 3.8 m · chart datum" (feet under imperial units).
 */
export function formatDepthReadout(valueM: number, imperial: boolean): string {
  const drying = valueM > 0;
  const magnitude = Math.abs(valueM) * (imperial ? M_TO_FT : 1);
  const rounded = Math.round(magnitude * 10) / 10;
  const unit = imperial ? 'ft' : 'm';
  return `${drying ? 'Drying' : 'Depth'} ${rounded} ${unit} · chart datum`;
}
