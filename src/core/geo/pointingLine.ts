import type { PointingLineLength, PointingLineTicks } from '@core/map/pointingLineSettings';
import type { LatLng } from '@core/models';
import type { Feature, FeatureCollection, LineString, Point } from 'geojson';
import { metersPerPixel, niceBelow } from './scaleBar';

/**
 * The pointing line's geometry (#681): a line from you along a bearing, its
 * tick marks and their labels, as one GeoJSON feature collection drawn by
 * map layers — so 500 m is 500 m on the ground at any zoom.
 *
 * - The end point and every tick centre come from the spherical destination
 *   formula ({@link destinationPoint}), exact to well under a metre at the
 *   lengths drawn here (≤ {@link EDGE_MAX_M}).
 * - Tick marks are short segments across the line whose half-length is a
 *   fixed number of dp, converted to metres at the settled zoom: they keep
 *   their size on screen, and the caller recomputes them when the camera
 *   settles (never per frame).
 * - "Edge" clips the line where it leaves the settled visible bounds
 *   ({@link edgeDistanceM}), again computed from the idle camera.
 *
 * Pure: no platform imports. Per call O(ticks); ticks are capped.
 */

/** The mean Earth radius (IUGG), as `geomath`'s haversine uses. */
const EARTH_RADIUS_M = 6371008.8;
const RAD = Math.PI / 180;

/** "Edge" never draws further than this: a pitched camera's bounds can reach the horizon. */
export const EDGE_MAX_M = 50_000;
/** Auto ticks are at least this far apart on screen, dp. */
export const AUTO_TICK_MIN_DP = 24;
/** A fixed tick spacing closer than this on screen is dropped (the ticks would fuse into a bar). */
export const MIN_TICK_DP = 6;
/** The most ticks one line carries (a guard; the screen-spacing rule binds first). */
export const MAX_TICKS = 300;
/** Every 5th tick is a major one (longer; the one that may carry a label). */
export const MAJOR_EVERY = 5;
/** Tick half-lengths across the line, dp (mockup: 4.5 and 7). */
export const TICK_HALF_DP = 4.5;
export const MAJOR_HALF_DP = 7;
/** How far a label sits beside its tick, dp. */
export const LABEL_OFFSET_DP = 14;

/** The map's settled visible bounds, degrees (MapLibre's [w, s, e, n] as names). */
export interface ViewBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** Wrap a longitude into [-180, 180). */
function wrapLng(lng: number): number {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

/**
 * The point `distanceM` metres from `origin` along the initial great-circle
 * bearing `bearingDeg` (clockwise from true north). Spherical earth.
 */
export function destinationPoint(origin: LatLng, bearingDeg: number, distanceM: number): LatLng {
  const delta = distanceM / EARTH_RADIUS_M;
  const theta = bearingDeg * RAD;
  const phi1 = origin.latitude * RAD;
  const lambda1 = origin.longitude * RAD;
  const sinPhi2 =
    Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta);
  const phi2 = Math.asin(Math.max(-1, Math.min(1, sinPhi2)));
  const lambda2 =
    lambda1 +
    Math.atan2(
      Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
      Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2),
    );
  return { latitude: phi2 / RAD, longitude: wrapLng(lambda2 / RAD) };
}

/**
 * How far the ray from `origin` along `bearingDeg` runs before it leaves
 * `bounds`, in metres — the "Edge" length. Local flat-earth frame around the
 * origin (screen-sized areas; the error is far below a tick). A box across
 * the antimeridian (west > east) is unwrapped. Returns null when the ray
 * never crosses the box (you are off-screen and facing away), and the
 * distance is capped at {@link EDGE_MAX_M}.
 */
export function edgeDistanceM(
  origin: LatLng,
  bearingDeg: number,
  bounds: ViewBounds,
): number | null {
  const { south, north } = bounds;
  let { west, east } = bounds;
  if (![west, east, south, north, origin.latitude, origin.longitude].every(Number.isFinite)) {
    return null;
  }
  if (east < west) east += 360;
  // Bring the origin's longitude next to the box (it may sit across ±180°).
  let lng = origin.longitude;
  const mid = (west + east) / 2;
  while (lng - mid > 180) lng -= 360;
  while (mid - lng > 180) lng += 360;
  west -= lng;
  east -= lng;
  const mPerDegLat = EARTH_RADIUS_M * RAD;
  const mPerDegLng = mPerDegLat * Math.cos(Math.min(89.9, Math.abs(origin.latitude)) * RAD);
  const box = {
    x0: west * mPerDegLng,
    x1: east * mPerDegLng,
    y0: (south - origin.latitude) * mPerDegLat,
    y1: (north - origin.latitude) * mPerDegLat,
  };
  const dx = Math.sin(bearingDeg * RAD);
  const dy = Math.cos(bearingDeg * RAD);
  let tEnter = -Infinity;
  let tExit = Infinity;
  for (const [d, lo, hi] of [
    [dx, box.x0, box.x1],
    [dy, box.y0, box.y1],
  ] as const) {
    if (Math.abs(d) < 1e-12) {
      if (lo > 0 || hi < 0) return null; // parallel to this slab and outside it
      continue;
    }
    const a = lo / d;
    const b = hi / d;
    tEnter = Math.max(tEnter, Math.min(a, b));
    tExit = Math.min(tExit, Math.max(a, b));
  }
  if (!(tExit > 0) || tExit < tEnter) return null;
  return Math.min(EDGE_MAX_M, tExit);
}

/** The smallest 1/2/5 × 10ⁿ value that is ≥ `value` (`niceAtLeast(437) === 500`). */
export function niceAtLeast(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const below = niceBelow(value);
  if (below >= value) return below;
  const pow = Math.pow(10, Math.floor(Math.log10(below)));
  const f = Math.round(below / pow);
  return (f === 1 ? 2 : f === 2 ? 5 : 10) * pow;
}

/**
 * Auto ticks: the round step (1/2/5 × 10ⁿ m, at least 1 m) that puts ticks at
 * least {@link AUTO_TICK_MIN_DP} apart at this zoom and latitude.
 */
export function autoTickStepM(zoom: number, latitude: number): number | null {
  const mpp = metersPerPixel(zoom, latitude);
  if (mpp === null) return null;
  return Math.max(1, niceAtLeast(AUTO_TICK_MIN_DP * mpp));
}

/**
 * The tick spacing to draw, metres, or null for none: Off, no settled zoom
 * yet (ticks are sized in dp), or a fixed step that would sit closer than
 * {@link MIN_TICK_DP} on screen.
 */
export function resolveTickStepM(
  ticks: PointingLineTicks,
  zoom: number | null,
  latitude: number,
): number | null {
  if (ticks === 'off' || zoom === null) return null;
  if (ticks === 'auto') return autoTickStepM(zoom, latitude);
  const mpp = metersPerPixel(zoom, latitude);
  if (mpp === null || ticks / mpp < MIN_TICK_DP) return null;
  return ticks;
}

/** The length to draw, metres: the setting, or the edge distance (null: not on screen / no bounds yet). */
export function resolveLengthM(
  length: PointingLineLength,
  origin: LatLng,
  bearingDeg: number,
  bounds: ViewBounds | null,
): number | null {
  if (length !== 'edge') return length;
  return bounds === null ? null : edgeDistanceM(origin, bearingDeg, bounds);
}

/** Distances of the ticks along a line, metres: step, 2·step, … ≤ length, at most {@link MAX_TICKS}. */
export function tickDistances(lengthM: number, stepM: number): number[] {
  if (!(stepM > 0) || !(lengthM >= stepM)) return [];
  const n = Math.min(MAX_TICKS, Math.floor(lengthM / stepM + 1e-9));
  return Array.from({ length: n }, (_, i) => (i + 1) * stepM);
}

/** A tick's label: "100 m", "1 km", "1.5 km". */
export function tickLabel(m: number): string {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${Number((m / 1000).toFixed(2))} km`;
}

/** The kinds of feature the layers style: the line, ticks, the end dot, labels. */
export type PointingFeatureKind = 'line' | 'tick' | 'major' | 'end' | 'label';

export interface PointingLineInput {
  origin: LatLng;
  bearingDeg: number;
  lengthM: number;
  /** Tick spacing in metres, or null for no ticks. */
  tickStepM: number | null;
  /** The settled zoom: sizes the ticks and offsets the labels (no zoom: no ticks, no labels). */
  zoom: number | null;
  /** Label every {@link MAJOR_EVERY}th tick with its distance. */
  labelMajors: boolean;
  /** A word beside the end point ("COG"), or null. */
  endLabel: string | null;
}

type Props = { kind: PointingFeatureKind; text?: string };

const lngLat = (p: LatLng): [number, number] => [p.longitude, p.latitude];

/**
 * The whole line as one feature collection: the line itself, a segment per
 * tick (`tick` / `major`), the end point, and label points (`text`). Ticks
 * and labels need the zoom; without it only the line and its end are drawn.
 */
export function pointingLineFeatures(
  input: PointingLineInput,
): FeatureCollection<LineString | Point, Props> {
  const { origin, bearingDeg, lengthM, tickStepM, zoom, labelMajors, endLabel } = input;
  const end = destinationPoint(origin, bearingDeg, lengthM);
  const features: Feature<LineString | Point, Props>[] = [
    {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [lngLat(origin), lngLat(end)] },
      properties: { kind: 'line' },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: lngLat(end) },
      properties: { kind: 'end' },
    },
  ];
  const mpp = zoom === null ? null : metersPerPixel(zoom, origin.latitude);
  if (mpp === null) return { type: 'FeatureCollection', features };

  // Across the line, to its right: the bearing turned 90° clockwise, in a
  // local metric frame at the origin (offsets are a few metres to a few km).
  const theta = bearingDeg * RAD;
  const px = Math.cos(theta); // east
  const py = -Math.sin(theta); // north
  const mPerDegLat = EARTH_RADIUS_M * RAD;
  const mPerDegLng = mPerDegLat * Math.cos(Math.min(89.9, Math.abs(origin.latitude)) * RAD);
  const offset = (p: LatLng, dp: number): [number, number] => [
    p.longitude + (px * dp * mpp) / mPerDegLng,
    p.latitude + (py * dp * mpp) / mPerDegLat,
  ];

  if (tickStepM !== null) {
    const distances = tickDistances(lengthM, tickStepM);
    distances.forEach((d, i) => {
      const at = destinationPoint(origin, bearingDeg, d);
      const major = (i + 1) % MAJOR_EVERY === 0;
      const half = major ? MAJOR_HALF_DP : TICK_HALF_DP;
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [offset(at, -half), offset(at, half)] },
        properties: { kind: major ? 'major' : 'tick' },
      });
      if (major && labelMajors) {
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: offset(at, LABEL_OFFSET_DP + half) },
          properties: { kind: 'label', text: tickLabel(d) },
        });
      }
    });
  }
  if (endLabel !== null) {
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: offset(end, -(LABEL_OFFSET_DP + MAJOR_HALF_DP)) },
      properties: { kind: 'label', text: endLabel },
    });
  }
  return { type: 'FeatureCollection', features };
}
