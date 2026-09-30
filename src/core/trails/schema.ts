import type { LngLat } from '@core/models';

import { decodePolyline } from './polyline';

/**
 * The long-distance trail documents (#467), built from OpenStreetMap route
 * relations by `infra/tiles/nas/trails_build.py` and served by the tile
 * Worker:
 *
 * - the INDEX (`/trails/v1/index.json`), downloaded once and filtered on the
 *   device — compact keys, one row per trail;
 * - one DETAIL per trail (`/trails/v1/d/{version}/{id}.json`), fetched when a
 *   trail page opens: geometry and stages.
 *
 * Parsing is total and forgiving in the catalog's style: a malformed row is
 * dropped with a warning, never a reason to reject the document; a document
 * with the wrong shape parses to null.
 */

export const TRAIL_ACTIVITIES = ['hiking', 'cycling', 'skiing', 'paddling'] as const;
export type TrailActivity = (typeof TRAIL_ACTIVITIES)[number];

/** International, national, regional, or other (a named route with a long `distance`). */
export type TrailNetworkLevel = 'i' | 'n' | 'r' | 'o';

/** [west, south, east, north], degrees. */
export type TrailBbox = [number, number, number, number];

export interface LongTrail {
  /** OSM relation id, `r` + number. */
  id: string;
  name: string;
  nameFr?: string;
  nameEn?: string;
  activities: TrailActivity[];
  network: TrailNetworkLevel;
  lengthKm: number;
  bbox: TrailBbox;
  /** The point halfway along the trail (on it, unlike a centroid). */
  mid: LngLat;
  /** 0…1, see the build script's formula. */
  popularity: number;
  /** ISO 3166-1 alpha-2 codes, most-travelled first; empty when unknown. */
  countries: string[];
  /** Admin-1 region at the midpoint (a province, state, canton…). */
  region?: string;
  /** Number of stages; 0 when the trail has none. */
  stageCount: number;
  from?: string;
  to?: string;
  /** Thumbnail geometry, encoded polylines (precision 4), decoded on demand. */
  thumb: string[];
}

export interface TrailCountry {
  name: string;
  continent: string;
}

export interface TrailIndex {
  generated: string;
  /** Version of the detail documents this index was built with. */
  detailsVersion: string;
  attribution: string;
  countries: Record<string, TrailCountry>;
  trails: LongTrail[];
}

export interface TrailStage {
  id: string;
  name: string;
  from?: string;
  to?: string;
  lengthKm: number;
  geometry: LngLat[][];
}

export interface TrailDetail {
  id: string;
  name: string;
  names: { fr?: string; en?: string };
  activities: TrailActivity[];
  network: TrailNetworkLevel;
  lengthKm: number;
  bbox: TrailBbox;
  /** The whole trail: its own geometry, or its stages' in order. */
  geometry: LngLat[][];
  stages: TrailStage[];
  from?: string;
  to?: string;
  ref?: string;
  operator?: string;
  website?: string;
  wikipedia?: string;
  wikidata?: string;
  description?: string;
  roundtrip: boolean;
}

/** OSM `route=*` (or an already-mapped activity) → our activity. */
const ACTIVITY_ALIASES: Record<string, TrailActivity> = {
  hiking: 'hiking',
  foot: 'hiking',
  walking: 'hiking',
  cycling: 'cycling',
  bicycle: 'cycling',
  mtb: 'cycling',
  skiing: 'skiing',
  ski: 'skiing',
  paddling: 'paddling',
  canoe: 'paddling',
};

export function activityFromOsm(value: unknown): TrailActivity | null {
  return typeof value === 'string' ? (ACTIVITY_ALIASES[value.trim()] ?? null) : null;
}

/** OSM `network=*` (or an already-mapped level) → our level. */
export function networkLevelFromOsm(value: unknown): TrailNetworkLevel {
  if (typeof value !== 'string') return 'o';
  const v = value.trim();
  if (v === 'i' || v === 'iwn' || v === 'icn') return 'i';
  if (v === 'n' || v === 'nwn' || v === 'ncn') return 'n';
  if (v === 'r' || v === 'rwn' || v === 'rcn') return 'r';
  return 'o';
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

function str(v: unknown, max = 400): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s === '' ? undefined : s.slice(0, max);
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function bboxOf(v: unknown): TrailBbox | null {
  if (!Array.isArray(v) || v.length !== 4) return null;
  const [w, s, e, n] = v.map(num);
  if (w == null || s == null || e == null || n == null) return null;
  if (w > e || s > n || s < -90 || n > 90 || w < -180 || e > 180) return null;
  return [w, s, e, n];
}

function lngLatOf(v: unknown): LngLat | null {
  if (!Array.isArray(v) || v.length < 2) return null;
  const lon = num(v[0]);
  const lat = num(v[1]);
  if (lon === null || lat === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return [lon, lat];
}

function activitiesOf(v: unknown): TrailActivity[] {
  if (!Array.isArray(v)) return [];
  const out: TrailActivity[] = [];
  for (const raw of v) {
    const a = activityFromOsm(raw);
    if (a !== null && !out.includes(a)) out.push(a);
  }
  return out;
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s !== '') : [];
}

function parseRow(row: unknown): LongTrail | null {
  if (!isRec(row)) return null;
  const id = str(row.id, 40);
  const name = str(row.n, 200);
  const bbox = bboxOf(row.b);
  const mid = lngLatOf(row.c);
  const km = num(row.km);
  const activities = activitiesOf(row.a);
  if (id === undefined || name === undefined || bbox === null || mid === null) return null;
  if (km === null || km <= 0 || activities.length === 0) return null;
  const nameFr = str(row.nf, 200);
  const nameEn = str(row.ne, 200);
  const region = str(row.rg, 120);
  const from = str(row.fr, 120);
  const to = str(row.to, 120);
  const stages = num(row.st);
  const pop = num(row.p);
  return {
    id,
    name,
    ...(nameFr !== undefined ? { nameFr } : {}),
    ...(nameEn !== undefined ? { nameEn } : {}),
    activities,
    network: networkLevelFromOsm(row.net),
    lengthKm: km,
    bbox,
    mid,
    popularity: pop === null ? 0 : Math.max(0, Math.min(1, pop)),
    countries: stringList(row.cc),
    ...(region !== undefined ? { region } : {}),
    stageCount: stages !== null && stages > 0 ? Math.floor(stages) : 0,
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    thumb: stringList(row.t),
  };
}

export interface ParseResult<T> {
  value: T | null;
  warnings: string[];
}

export function parseTrailIndex(raw: unknown): ParseResult<TrailIndex> {
  const warnings: string[] = [];
  if (!isRec(raw) || raw.schema !== 1 || !Array.isArray(raw.trails)) {
    return { value: null, warnings: ['not a v1 trail index'] };
  }
  const detailsVersion = str(raw.details, 40);
  if (detailsVersion === undefined || !/^[A-Za-z0-9_-]+$/.test(detailsVersion)) {
    return { value: null, warnings: ['trail index names no details version'] };
  }
  const countries: Record<string, TrailCountry> = {};
  if (isRec(raw.countries)) {
    for (const [code, v] of Object.entries(raw.countries)) {
      if (Array.isArray(v) && typeof v[0] === 'string') {
        countries[code] = { name: v[0], continent: typeof v[1] === 'string' ? v[1] : '' };
      }
    }
  }
  const trails: LongTrail[] = [];
  const seen = new Set<string>();
  raw.trails.forEach((row, i) => {
    const trail = parseRow(row);
    if (trail === null) warnings.push(`trail row ${i} dropped`);
    else if (seen.has(trail.id)) warnings.push(`duplicate trail ${trail.id} dropped`);
    else {
      seen.add(trail.id);
      trails.push(trail);
    }
  });
  return {
    value: {
      generated: str(raw.generated, 40) ?? '',
      detailsVersion,
      attribution: str(raw.attribution, 200) ?? '© OpenStreetMap contributors (ODbL)',
      countries,
      trails,
    },
    warnings,
  };
}

function geometryOf(v: unknown): LngLat[][] {
  return stringList(v)
    .map((s) => decodePolyline(s, 5))
    .filter((part) => part.length >= 2);
}

export function parseTrailDetail(raw: unknown): TrailDetail | null {
  if (!isRec(raw) || raw.schema !== 1) return null;
  const id = str(raw.id, 40);
  const name = str(raw.name, 200);
  const bbox = bboxOf(raw.bbox);
  const km = num(raw.km);
  if (id === undefined || name === undefined || bbox === null || km === null) return null;
  const stages: TrailStage[] = [];
  if (Array.isArray(raw.stages)) {
    raw.stages.forEach((s, i) => {
      if (!isRec(s)) return;
      const geometry = geometryOf(s.geom);
      const stageKm = num(s.km);
      if (geometry.length === 0) return;
      const from = str(s.from, 120);
      const to = str(s.to, 120);
      stages.push({
        id: str(s.id, 40) ?? `${id}-${i + 1}`,
        name: str(s.name, 200) ?? `Stage ${i + 1}`,
        ...(from !== undefined ? { from } : {}),
        ...(to !== undefined ? { to } : {}),
        lengthKm: stageKm !== null && stageKm > 0 ? stageKm : 0,
        geometry,
      });
    });
  }
  const own = geometryOf(raw.geom);
  const geometry = stages.length > 0 ? stages.flatMap((s) => s.geometry) : own;
  if (geometry.length === 0) return null;
  const names = isRec(raw.names) ? raw.names : {};
  const fr = str(names.fr, 200);
  const en = str(names.en, 200);
  const optional = (key: string, max: number) => {
    const value = str(raw[key], max);
    return value !== undefined ? { [key]: value } : {};
  };
  return {
    id,
    name,
    names: { ...(fr !== undefined ? { fr } : {}), ...(en !== undefined ? { en } : {}) },
    activities: activitiesOf(raw.acts),
    network: networkLevelFromOsm(raw.net),
    lengthKm: km,
    bbox,
    geometry,
    stages,
    ...optional('from', 120),
    ...optional('to', 120),
    ...optional('ref', 40),
    ...optional('operator', 120),
    ...optional('website', 300),
    ...optional('wikipedia', 200),
    ...optional('wikidata', 20),
    ...optional('description', 400),
    roundtrip: raw.roundtrip === true,
  };
}

const thumbCache = new WeakMap<LongTrail, LngLat[][]>();

/** The trail's thumbnail geometry, decoded once per row. */
export function trailThumb(trail: LongTrail): LngLat[][] {
  const hit = thumbCache.get(trail);
  if (hit !== undefined) return hit;
  const parts = trail.thumb.map((s) => decodePolyline(s, 4)).filter((p) => p.length >= 2);
  thumbCache.set(trail, parts);
  return parts;
}

/** The trail's name in the user's language when OSM has one. */
export function trailDisplayName(
  trail: Pick<LongTrail, 'name' | 'nameFr' | 'nameEn'>,
  lang: string,
): string {
  if (lang.startsWith('fr') && trail.nameFr !== undefined) return trail.nameFr;
  if (lang.startsWith('en') && trail.nameEn !== undefined) return trail.nameEn;
  return trail.name;
}
