import type { Json } from '@core/team/canonical';
import type { LatLng, LngLat } from '@core/models';
import { simplifyIndices } from '@core/geo/track/simplify';
import { decodePolyline, encodePolyline } from '@core/trails/polyline';

import { isCatalogId, MAX_DESCRIPTION, MAX_INLINE_GEOMETRY, MAX_NAME } from './kinds';

/**
 * Library items as `lit`/`lfo` fields and back (2.7.0 #712, Share live):
 * what a phone writes for one of its trails, waypoints, areas or maps, and
 * what it rebuilds from a record another phone wrote. Pure; the library
 * bridge (`src/data/sync/libraryBridge.ts`) reads GPX files and calls these.
 *
 * What travels in 2.7.0:
 * - a **trail** as an encoded polyline (precision 5, ~1 m), simplified until
 *   it fits {@link MAX_INLINE_GEOMETRY}; one that never fits is written
 *   without geometry and reads "not shared yet" until blobs (2.7.1);
 * - a **waypoint**: position, elevation, name, note, icon, colour, size;
 * - an **area**: ring, name, note, colour;
 * - a **map**: its catalog id only (each phone downloads it from its source).
 *   An imported PDF has none: written as a name only, "not shared yet".
 *
 * Photos stay on their phone (2.7.1).
 */

/** Library item kinds as this phone stores them. */
export type LocalKind = 'folder' | 'track' | 'waypoint' | 'area' | 'map';

/** Simplification steps (metres) tried until a trail fits inline. */
export const TRACK_FIT_TOLERANCES_M: readonly number[] = [0, 2, 4, 8, 16, 32];

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);
const name = (s: string): string => clip(s.trim(), MAX_NAME) || 'Untitled';
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const COLOR = /^#[0-9A-Fa-f]{6}$/;
const ICON = /^[a-z0-9_-]{1,64}$/;

export function folderFields(f: { name: string }): Record<string, Json> {
  return { n: name(f.name) };
}

export interface WaypointLike {
  label: string;
  latitude: number;
  longitude: number;
  note?: string;
  icon?: string;
  color?: string;
  size?: 'S' | 'M' | 'L' | 'XL';
  elevation?: number;
}

export function waypointFields(w: WaypointLike): Record<string, Json> {
  const f: Record<string, Json> = { t: 'wpt', n: name(w.label), ll: [w.longitude, w.latitude] };
  if (w.note !== undefined && w.note !== '') f['d'] = clip(w.note, MAX_DESCRIPTION);
  if (w.icon !== undefined && ICON.test(w.icon)) f['ic'] = w.icon;
  if (finite(w.elevation) && Math.abs(w.elevation) <= 20_000) f['el'] = w.elevation;
  const sty: Record<string, Json> = {};
  if (w.color !== undefined && COLOR.test(w.color)) sty['c'] = w.color;
  if (w.size !== undefined) sty['s'] = w.size;
  if (Object.keys(sty).length > 0) f['sty'] = sty;
  return f;
}

export interface AreaLike {
  name: string;
  ring: readonly LngLat[];
  color: string;
  note?: string;
}

export function areaFields(a: AreaLike): Record<string, Json> {
  const f: Record<string, Json> = { t: 'area', n: name(a.name) };
  const g = encodePolyline(a.ring);
  if (a.ring.length >= 3 && g.length > 0 && g.length <= MAX_INLINE_GEOMETRY) f['g'] = g;
  if (a.note !== undefined && a.note !== '') f['d'] = clip(a.note, MAX_DESCRIPTION);
  if (COLOR.test(a.color)) f['sty'] = { c: a.color };
  return f;
}

/** A trail's polyline that fits one op, simplified only as much as needed; undefined if none does. */
export function fitTrack(points: readonly LatLng[]): string | undefined {
  const valid = points.filter(
    (p) =>
      finite(p.latitude) &&
      finite(p.longitude) &&
      Math.abs(p.latitude) <= 90 &&
      Math.abs(p.longitude) <= 180,
  );
  if (valid.length < 2) return undefined;
  for (const tol of TRACK_FIT_TOLERANCES_M) {
    const kept = tol === 0 ? valid : simplifyIndices(valid, tol).map((i) => valid[i]!);
    const g = encodePolyline(kept.map((p): LngLat => [p.longitude, p.latitude]));
    if (g.length <= MAX_INLINE_GEOMETRY) return g;
  }
  return undefined;
}

export function trackFields(t: { name: string; points: readonly LatLng[] }): Record<string, Json> {
  const f: Record<string, Json> = { t: 'trk', n: name(t.name) };
  const g = fitTrack(t.points);
  if (g !== undefined) f['g'] = g;
  return f;
}

export function mapFields(m: { name: string; sourceItemId?: string }): Record<string, Json> {
  const f: Record<string, Json> = { t: 'map', n: name(m.name) };
  if (isCatalogId(m.sourceItemId)) f['cat'] = m.sourceItemId;
  return f;
}

/** The local kind an item record becomes (undefined: a newer app's type). */
export function localKindOf(fields: Readonly<Record<string, Json>>): LocalKind | undefined {
  switch (fields['t']) {
    case 'trk':
      return 'track';
    case 'wpt':
      return 'waypoint';
    case 'area':
      return 'area';
    case 'map':
      return 'map';
    default:
      return undefined;
  }
}

const str = (v: Json | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

/** A waypoint from its record (undefined: no valid position). */
export function waypointFrom(f: Readonly<Record<string, Json>>): WaypointLike | undefined {
  const ll = f['ll'];
  if (!Array.isArray(ll) || ll.length !== 2 || !finite(ll[0]) || !finite(ll[1])) return undefined;
  const w: WaypointLike = {
    label: str(f['n']) ?? 'Waypoint',
    longitude: ll[0] as number,
    latitude: ll[1] as number,
  };
  const d = str(f['d']);
  if (d !== undefined && d !== '') w.note = d;
  const ic = str(f['ic']);
  if (ic !== undefined) w.icon = ic;
  if (finite(f['el'])) w.elevation = f['el'];
  const sty = f['sty'];
  if (sty !== null && typeof sty === 'object' && !Array.isArray(sty)) {
    const c = str(sty['c']);
    if (c !== undefined && COLOR.test(c)) w.color = c;
    const s = sty['s'];
    if (s === 'S' || s === 'M' || s === 'L' || s === 'XL') w.size = s;
  }
  return w;
}

/** An area from its record (undefined: no ring of 3 or more). */
export function areaFrom(
  f: Readonly<Record<string, Json>>,
  defaultColor: string,
): AreaLike | undefined {
  const g = str(f['g']);
  if (g === undefined) return undefined;
  const ring = decodePolyline(g);
  if (ring.length < 3) return undefined;
  const a: AreaLike = { name: str(f['n']) ?? 'Area', ring, color: defaultColor };
  const sty = f['sty'];
  if (sty !== null && typeof sty === 'object' && !Array.isArray(sty)) {
    const c = str(sty['c']);
    if (c !== undefined && COLOR.test(c)) a.color = c;
  }
  const d = str(f['d']);
  if (d !== undefined && d !== '') a.note = d;
  return a;
}

/** A trail from its record (undefined: no geometry yet, "not shared yet"). */
export function trackFrom(
  f: Readonly<Record<string, Json>>,
): { name: string; points: LngLat[] } | undefined {
  const g = str(f['g']);
  if (g === undefined) return undefined;
  const points = decodePolyline(g);
  return points.length < 2 ? undefined : { name: str(f['n']) ?? 'Trail', points };
}

/**
 * Whether this phone can hold the record as a library item now: a trail or
 * an area with its geometry, a waypoint with a position. A map needs its
 * file (a catalog download, or 2.7.1 for an imported PDF), so never here.
 */
export function representable(f: Readonly<Record<string, Json>>): boolean {
  switch (localKindOf(f)) {
    case 'track':
      return trackFrom(f) !== undefined;
    case 'waypoint':
      return waypointFrom(f) !== undefined;
    case 'area':
      return areaFrom(f, '#000000') !== undefined;
    default:
      return false;
  }
}
