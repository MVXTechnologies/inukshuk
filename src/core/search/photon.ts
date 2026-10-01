import type { Place, PlaceBbox } from './place';
import { placeTypeOf } from './placeTypes';

/**
 * Photon (https://github.com/komoot/photon) answers `/api` with a GeoJSON
 * FeatureCollection. Each feature's `properties` carries the OSM tag pair
 * (`osm_key`/`osm_value`), its coarse layer (`type`), the name in the
 * requested language, the address context (`city`, `county`, `state`,
 * `country`), an `extent` of `[minLon, maxLat, maxLon, minLat]` for areas,
 * and an `extra` object of extra tags on instances configured with them
 * (`ele` for summits on a self-hosted index). Our Worker adds `alt_name`, the
 * name in the other language, when it differs.
 *
 * This module turns that into {@link Place}s and drops anything malformed.
 */

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/** `extent` is [minLon, maxLat, maxLon, minLat] — note the odd order. */
function bboxOf(extent: unknown): PlaceBbox | undefined {
  if (!Array.isArray(extent) || extent.length !== 4) return undefined;
  const [w, n, e, s] = extent.map(num);
  if (w === undefined || n === undefined || e === undefined || s === undefined) return undefined;
  if (s > n || Math.abs(n) > 90 || Math.abs(s) > 90) return undefined;
  return [w, s, e, n];
}

/** "1 234 m", "1234", "4049 ft" → metres; undefined for anything else. */
export function parseElevation(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  const s = str(v);
  if (s === undefined) return undefined;
  const m = /^(-?\d+(?:[.,]\d+)?)\s*(m|ft|')?$/i.exec(s.replace(/\s(?=\d)/g, ''));
  if (m === null || m[1] === undefined) return undefined;
  const value = Number(m[1].replace(',', '.'));
  const feet = m[2] !== undefined && m[2].toLowerCase() !== 'm';
  return Math.round(feet ? value * 0.3048 : value);
}

/** The line under the name: nearest settlement, then province/state, then country. */
function contextOf(p: Record<string, unknown>, name: string): string | undefined {
  const parts: string[] = [];
  const add = (v: unknown) => {
    const s = str(v);
    if (s !== undefined && s !== name && !parts.includes(s)) parts.push(s);
  };
  add(p.city ?? p.district ?? p.county);
  add(p.state);
  add(p.country);
  return parts.length > 0 ? parts.join(', ') : undefined;
}

function placeOf(feature: unknown): Place | null {
  if (feature === null || typeof feature !== 'object') return null;
  const f = feature as { properties?: unknown; geometry?: unknown };
  if (f.properties === null || typeof f.properties !== 'object') return null;
  const p = f.properties as Record<string, unknown>;
  const g = f.geometry as { coordinates?: unknown } | null | undefined;
  const coords = Array.isArray(g?.coordinates) ? g.coordinates : [];
  const longitude = num(coords[0]);
  const latitude = num(coords[1]);
  const name = str(p.name);
  if (latitude === undefined || longitude === undefined || name === undefined) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;

  const type = placeTypeOf(str(p.osm_key) ?? '', str(p.osm_value) ?? '', str(p.type));
  const osmType = str(p.osm_type) ?? '?';
  const osmId = num(p.osm_id) ?? str(p.osm_id);
  const altName = str(p.alt_name);
  const extra =
    p.extra !== null && typeof p.extra === 'object' ? (p.extra as Record<string, unknown>) : {};
  const elevationM =
    type === 'peak' || type === 'mountain' || type === 'volcano' || type === 'pass'
      ? parseElevation(extra.ele)
      : undefined;

  const place: Place = {
    id:
      osmId !== undefined
        ? `osm:${osmType}${osmId}`
        : `osm:${name}@${latitude.toFixed(4)},${longitude.toFixed(4)}`,
    source: 'index',
    type,
    name,
    latitude,
    longitude,
  };
  if (altName !== undefined && altName !== name) place.altName = altName;
  const bbox = bboxOf(p.extent);
  if (bbox !== undefined) place.bbox = bbox;
  const context = contextOf(p, name);
  if (context !== undefined) place.context = context;
  if (elevationM !== undefined) place.elevationM = elevationM;
  return place;
}

/** Parse a Photon (GeoJSON) response body into places; junk yields []. */
export function parsePhotonResponse(body: unknown): Place[] {
  if (body === null || typeof body !== 'object') return [];
  const features = (body as { features?: unknown }).features;
  if (!Array.isArray(features)) return [];
  const out: Place[] = [];
  for (const f of features) {
    const place = placeOf(f);
    if (place !== null) out.push(place);
  }
  return out;
}
