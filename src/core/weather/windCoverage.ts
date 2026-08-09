import { GEOMET_WMS_ENDPOINT } from '@core/geo/weatherLayers';
import type { WeatherModelId } from './weatherModels';

/**
 * GeoMet WCS wind-coverage catalog + fetch-bbox logic (weather M3). The wind
 * particle layer pulls raw float32 grids per (model, bbox, time) — speed and
 * direction always, gust when the model has one — via WCS GetCoverage
 * (`format=image/tiff`, EPSG:4326 subsets). All nine coverage ids verified
 * live 2026-08-09 (HTTP 200, parseable single-band float32 GeoTIFFs;
 * `&TIME=` selects timesteps; out-of-range TIME answers XML, which the TIFF
 * parser rejects). Note the HRDPS gust is the post-processed WEonG product —
 * raw HRDPS has no gust coverage; its grid matched HRDPS.CONTINENTAL exactly
 * in the live probe, and a mismatch degrades to gust-less (see windField).
 */

export interface WindCoverageIds {
  speed: string;
  dir: string;
  /** Gust coverage; models without one would set null (all three have one). */
  gust: string | null;
}

export const WIND_COVERAGES: Record<WeatherModelId, WindCoverageIds> = {
  hrdps: {
    speed: 'HRDPS.CONTINENTAL_WSPD',
    dir: 'HRDPS.CONTINENTAL_WD',
    gust: 'HRDPS-WEonG_2.5km_WindGust',
  },
  rdps: {
    speed: 'RDPS_10km_WindSpeed_10m',
    dir: 'RDPS_10km_WindDir_10m',
    gust: 'RDPS_10km_WindGust_10m',
  },
  gdps: {
    speed: 'GDPS_15km_WindSpeed_10m',
    dir: 'GDPS_15km_WindDir_10m',
    gust: 'GDPS_15km_WindGust_10m',
  },
};

/** A geographic fetch box, degrees (west < east, south < north). */
export interface WindBbox {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** WCS GetCoverage URL for one coverage over a bbox, optionally at a TIME. */
export function wcsCoverageUrl(coverageId: string, bbox: WindBbox, timeIso?: string): string {
  const params = [
    'service=WCS',
    'version=2.0.1',
    'request=GetCoverage',
    `coverageid=${encodeURIComponent(coverageId)}`,
    `subset=lat(${bbox.south},${bbox.north})`,
    `subset=long(${bbox.west},${bbox.east})`,
    'format=image/tiff',
    ...(timeIso !== undefined ? [`TIME=${encodeURIComponent(timeIso)}`] : []),
  ];
  return `${GEOMET_WMS_ENDPOINT}?${params.join('&')}`;
}

/**
 * Particle activation gate: above this viewport span (degrees, either axis)
 * the wind overlay stays gradient-only — a continental grid would be
 * megabytes per frame, and streaks at that zoom read as noise anyway.
 */
export const PARTICLES_MAX_VIEW_SPAN_DEG = 12;
/** Above this camera pitch the overlay fades out (no pitched projection yet). */
export const PARTICLES_MAX_PITCH_DEG = 20;

/** Padding factor: fetch ~1.5× the viewport so pans don't refetch instantly. */
const BBOX_PAD_FACTOR = 1.5;
/** Bbox edges snap to this grid so nearby anchors share a cache entry. */
const BBOX_QUANT_DEG = 0.25;
/** Hard cap on the fetched span per axis, degrees. */
const BBOX_MAX_SPAN_DEG = 16;
/** Floor on the fetched span — keeps the WCS subset non-degenerate. */
const BBOX_MIN_SPAN_DEG = 0.5;
/** Mercator maps break down at the poles; clamp fetches inside this. */
const LAT_LIMIT = 84;

const quantNear = (v: number): number => Math.round(v / BBOX_QUANT_DEG) * BBOX_QUANT_DEG;
const quantUp = (v: number): number => Math.ceil(v / BBOX_QUANT_DEG) * BBOX_QUANT_DEG;

/**
 * The padded, quantized fetch bbox for a viewport, or null when the viewport
 * is out of scope for particles (spans the antimeridian, degenerate, or
 * wider than the activation gate). The CENTER is snapped to the quantization
 * grid (not the edges) so nearby viewports resolve to the same bbox — that
 * stability is what makes the field cache and re-anchor check useful.
 */
export function windFetchBbox(view: WindBbox): WindBbox | null {
  const lonSpan = view.east - view.west;
  const latSpan = view.north - view.south;
  if (!(lonSpan > 0) || !(latSpan > 0)) return null;
  if (lonSpan > PARTICLES_MAX_VIEW_SPAN_DEG || latSpan > PARTICLES_MAX_VIEW_SPAN_DEG) return null;
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
 * Should the particle layer re-anchor (fetch a new bbox + re-seed)?
 * - the viewport escaped the anchored bbox (pan/zoom-out past the padding);
 * - or the viewport shrank far below the anchor (zoom-in ≥ ~2 levels): a
 *   fresh, tighter subset buys real grid resolution from the WCS.
 */
export function needsReanchor(anchor: WindBbox, view: WindBbox): boolean {
  if (view.west < anchor.west || view.east > anchor.east) return true;
  if (view.south < anchor.south || view.north > anchor.north) return true;
  const anchorSpan = Math.max(anchor.east - anchor.west, anchor.north - anchor.south);
  const viewSpan = Math.max(view.east - view.west, view.north - view.south);
  return viewSpan > 0 && anchorSpan / viewSpan > 4 * BBOX_PAD_FACTOR;
}

/** Cache key for a fetched wind field. */
export function windFieldCacheKey(
  model: WeatherModelId,
  bbox: WindBbox,
  timeIso: string | undefined,
): string {
  const fmt = (v: number): string => v.toFixed(2);
  return `${model}|${fmt(bbox.west)},${fmt(bbox.south)},${fmt(bbox.east)},${fmt(bbox.north)}|${timeIso ?? 'latest'}`;
}
