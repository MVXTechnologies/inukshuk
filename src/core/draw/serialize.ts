import { buildGpx } from '@core/geo/gpx';
import type { Area, LngLat, RoutePlan, TrackPoint } from '@core/models';

import { polygonAreaM2, polygonPerimeterM } from './geometry';
import { fitModes, isLegMode, type LegMode } from './legs';

/**
 * Serialization for drawn routes and areas (#502/#503).
 *
 * A route is stored the way the app already stores an untimed imported
 * route: a GPX 1.1 `<trk>` whose points carry no `<time>` (`hasTime: false`)
 * — so the trail view, Follow, the profile and "Share GPX" all work on it
 * unchanged — with `<ele>` from the DEM where it was available.
 *
 * An area exports as a GeoJSON Feature (Polygon, ring closed, RFC 7946
 * right-hand winding) carrying its name, note, colour, tags and measured
 * size; the whole set as one FeatureCollection.
 */

/** Untimed track points for the densified line, with DEM elevation where known. */
export function plannedRoutePoints(
  samples: readonly LngLat[],
  elevations?: readonly (number | undefined)[],
): TrackPoint[] {
  return samples.map(([longitude, latitude], i) => {
    const altitude = elevations?.[i];
    return {
      latitude,
      longitude,
      time: 0,
      hasTime: false,
      ...(altitude !== undefined && Number.isFinite(altitude) ? { altitude } : {}),
    };
  });
}

/** The GPX text a drawn route is saved as. */
export function plannedRouteGpx(name: string, points: TrackPoint[]): string {
  return buildGpx({ points, metadata: { name, description: 'Route drawn in Inukshuk' } });
}

const isLngLat = (p: unknown): p is LngLat =>
  Array.isArray(p) &&
  p.length >= 2 &&
  typeof p[0] === 'number' &&
  typeof p[1] === 'number' &&
  Number.isFinite(p[0]) &&
  Number.isFinite(p[1]) &&
  Math.abs(p[0]) <= 180 &&
  Math.abs(p[1]) <= 90;

/** Keep only well-formed `[lng, lat]` pairs (persisted data is never trusted). */
export function sanitizeVertices(raw: unknown): LngLat[] {
  return Array.isArray(raw) ? raw.filter(isLngLat).map((p) => [p[0], p[1]] as LngLat) : [];
}

/**
 * A persisted route plan, sanitized; null for junk or fewer than 2 vertices.
 * Leg modes survive only when there is exactly one valid mode per leg (a
 * mismatch would pair modes with the wrong legs: Freehand is the safe reading).
 */
export function sanitizeRoutePlan(raw: unknown): RoutePlan | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const {
    vertices: rawVertices,
    mode: rawMode,
    legModes: rawLegs,
    backAndForth,
  } = raw as Record<string, unknown>;
  const vertices = sanitizeVertices(rawVertices);
  if (vertices.length < 2) return null;
  const mode = isLegMode(rawMode) ? rawMode : 'freehand';
  const legModes =
    Array.isArray(rawLegs) && rawLegs.length === vertices.length - 1 && rawLegs.every(isLegMode)
      ? (rawLegs as LegMode[])
      : null;
  const plan: RoutePlan =
    legModes !== null && legModes.some((m) => m !== 'freehand')
      ? { mode, vertices, legModes: [...legModes] }
      : { mode, vertices };
  // Only an explicit true turns it on: older plans are one-way.
  return backAndForth === true ? { ...plan, backAndForth: true } : plan;
}

/** The plan saved with a drawn route: leg modes only when some leg is not Freehand. */
export function buildRoutePlan(
  vertices: readonly LngLat[],
  legModes: readonly LegMode[],
  mode: LegMode,
  backAndForth = false,
): RoutePlan {
  const copy = vertices.map((v) => [v[0], v[1]] as LngLat);
  const legs = fitModes(legModes, vertices.length);
  const plan: RoutePlan = legs.some((m) => m !== 'freehand')
    ? { mode, vertices: copy, legModes: legs }
    : { mode, vertices: copy };
  return backAndForth ? { ...plan, backAndForth: true } : plan;
}

/** Signed planar area (shoelace, degrees²): > 0 when counter-clockwise. */
function signedArea(ring: readonly LngLat[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if (a !== undefined && b !== undefined) sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

/** The closed, counter-clockwise exterior ring GeoJSON (RFC 7946 §3.1.6) expects. */
export function closedCcwRing(ring: readonly LngLat[]): LngLat[] {
  const ccw = signedArea(ring) < 0 ? [...ring].reverse() : [...ring];
  const first = ccw[0];
  return first === undefined ? [] : [...ccw, first];
}

export interface AreaFeature {
  type: 'Feature';
  id: string;
  geometry: { type: 'Polygon'; coordinates: LngLat[][] };
  properties: {
    name: string;
    note?: string;
    color: string;
    tags?: string[];
    areaM2: number;
    perimeterM: number;
    createdAt: string;
  };
}

/** One area as a GeoJSON Feature. */
export function areaToFeature(area: Area): AreaFeature {
  const note = area.note?.trim();
  return {
    type: 'Feature',
    id: area.id,
    geometry: { type: 'Polygon', coordinates: [closedCcwRing(area.ring)] },
    properties: {
      name: area.name,
      ...(note ? { note } : {}),
      color: area.color,
      ...(area.tags && area.tags.length > 0 ? { tags: [...area.tags] } : {}),
      areaM2: Math.round(polygonAreaM2(area.ring)),
      perimeterM: Math.round(polygonPerimeterM(area.ring)),
      createdAt: new Date(area.createdAt).toISOString(),
    },
  };
}

/** Every area as one GeoJSON FeatureCollection, pretty-printed. */
export function areasToGeoJson(areas: readonly Area[]): string {
  return JSON.stringify({ type: 'FeatureCollection', features: areas.map(areaToFeature) }, null, 2);
}

/** A file-name-safe stem for one area's export ("Blueberry slope" → "Blueberry_slope"). */
export function areaFileStem(name: string): string {
  const clean = name
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[._]+|_+$/g, '');
  return clean || 'area';
}
