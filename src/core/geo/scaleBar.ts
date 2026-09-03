import type { Units } from '@core/format';

/**
 * Map scale-bar geometry: how much ground a run of screen pixels covers, and
 * which "nice" round distance to draw a bar for.
 *
 * Two things make this more than a division:
 *
 * 1. **Latitude matters.** Web Mercator stretches everything by 1/cos(lat), so
 *    one screen pixel is ~1400 m of ground at the equator at z7 but only
 *    ~700 m at 60°N and ~170 m at 83°N — the top of the map sheets this app
 *    ships. A scale bar that ignored latitude would be wrong by a factor of 8
 *    over the Arctic archipelago.
 * 2. **Round numbers.** A bar is only readable if it is labelled 1/2/5 × 10ⁿ
 *    ("500 m", "2 km", "5 mi"). We therefore pick the largest such distance
 *    that FITS the allotted pixel width and shrink the bar to match, rather
 *    than drawing a fixed-width bar labelled "437 m".
 *
 * Pure: the unit system is an argument (see `@core/format`'s note on why no
 * module-level units global exists).
 */

/** Earth's equatorial circumference in metres (the Web-Mercator constant). */
const EARTH_CIRCUMFERENCE_M = 40075016.686;

/**
 * MapLibre's world size at zoom 0, in logical pixels: the 512-px tile
 * convention shared by MapLibre GL JS and the native SDKs (the same constant
 * `zoomForVisibleWidth` inverts).
 */
const WORLD_PX_AT_ZOOM_0 = 512;

/** Web-Mercator's usable latitude domain; beyond it cos(lat) → 0 and the math degenerates. */
const MAX_MERCATOR_LAT = 85;

const M_PER_FT = 0.3048;
/** Feet in a statute mile — the threshold where an imperial bar switches units. */
const FT_PER_MI = 5280;

/**
 * Ground metres covered by one logical pixel at a given Web-Mercator zoom and
 * latitude. Returns `null` for junk input rather than NaN/Infinity, so callers
 * can simply not draw a bar.
 */
export function metersPerPixel(zoom: number, latitude: number): number | null {
  if (!Number.isFinite(zoom) || !Number.isFinite(latitude)) return null;
  const lat = Math.min(MAX_MERCATOR_LAT, Math.max(-MAX_MERCATOR_LAT, latitude));
  const mpp =
    (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180)) /
    (WORLD_PX_AT_ZOOM_0 * Math.pow(2, zoom));
  return Number.isFinite(mpp) && mpp > 0 ? mpp : null;
}

/**
 * The largest 1/2/5 × 10ⁿ value that is ≤ `value`. `niceBelow(437) === 200`,
 * `niceBelow(0.7) === 0.5`. Returns 0 for non-positive/non-finite input.
 */
export function niceBelow(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const pow = Math.pow(10, Math.floor(Math.log10(value)));
  const f = value / pow;
  const mult = f >= 5 ? 5 : f >= 2 ? 2 : 1;
  return mult * pow;
}

/** Drop float noise from a nice number: 2 -> "2", 2.5 -> "2.5", 0.30000000004 -> "0.3". */
function trim(n: number): string {
  return String(Number(n.toFixed(3)));
}

/** One drawable scale bar. */
export interface ScaleBar {
  /** Ground distance the bar represents, in metres. */
  meters: number;
  /** Bar length in logical pixels — always ≤ the requested maximum. */
  widthPx: number;
  /** Ready-to-draw label in the requested unit system, e.g. "500 m" / "2 mi". */
  label: string;
}

/**
 * Pick the scale bar to draw inside `maxWidthPx` pixels of screen.
 *
 * Metric bars are round metres below 1 km and round kilometres above it;
 * imperial bars are round feet below one mile and round miles above it (the
 * Leaflet/Google convention — nobody reads "0.19 mi").
 *
 * Returns `null` when no sane bar exists (junk camera state, zero width, or a
 * zoom so deep that even the smallest nice distance overflows the allowance).
 */
export function scaleBar(
  zoom: number,
  latitude: number,
  maxWidthPx: number,
  units: Units,
): ScaleBar | null {
  if (!Number.isFinite(maxWidthPx) || maxWidthPx <= 0) return null;
  const mpp = metersPerPixel(zoom, latitude);
  if (mpp === null) return null;

  const maxMeters = mpp * maxWidthPx;
  let meters: number;
  let label: string;

  if (units === 'imperial') {
    const maxFeet = maxMeters / M_PER_FT;
    if (maxFeet >= FT_PER_MI) {
      const miles = niceBelow(maxFeet / FT_PER_MI);
      meters = miles * FT_PER_MI * M_PER_FT;
      label = `${trim(miles)} mi`;
    } else {
      const feet = niceBelow(maxFeet);
      meters = feet * M_PER_FT;
      label = `${trim(feet)} ft`;
    }
  } else if (maxMeters >= 1000) {
    const km = niceBelow(maxMeters / 1000);
    meters = km * 1000;
    label = `${trim(km)} km`;
  } else {
    meters = niceBelow(maxMeters);
    label = `${trim(meters)} m`;
  }

  const widthPx = meters / mpp;
  if (!Number.isFinite(widthPx) || widthPx <= 0 || widthPx > maxWidthPx) return null;
  return { meters, widthPx, label };
}
