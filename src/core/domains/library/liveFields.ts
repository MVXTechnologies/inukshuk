import type { Json } from '@core/team/canonical';
import type { LngLat } from '@core/models';
import { BUILT_IN_CATEGORIES } from '@core/library/categories';
import { decodePolyline, encodePolyline } from '@core/trails/polyline';

import { isCatalogId, MAX_DESCRIPTION, MAX_INLINE_GEOMETRY, MAX_NAME } from './kinds';
import {
  decodeTrack,
  encodeTrack,
  MAX_TRACK_PARTS,
  MAX_TRACK_POINTS,
  PART_CHARS,
  trackRevision,
  type CodecPoint,
  type CodecTrack,
} from './trackCodec';

/**
 * Library items as `lit`/`lfo` fields and back (2.7.0 #712, Share live):
 * what a phone writes for one of its trails, waypoints, areas or maps, and
 * what it rebuilds from a record another phone wrote. Pure; the library
 * bridge (`src/data/sync/libraryBridge.ts`) reads GPX files and calls these.
 *
 * What travels in 2.7.0:
 * - a **trail** whole: every point with its elevation and time, and its
 *   segments (`trackCodec.ts`), in as many `lpt` parts as it needs, plus its
 *   built-in activity type, so it arrives as the same kind of trail;
 * - a **waypoint**: position, elevation, name, note, icon, colour, size;
 * - an **area**: ring, name, note, colour;
 * - a **map**: its catalog id only (each phone downloads it from its source).
 *   An imported PDF has none: written as a name only, "not shared yet".
 *
 * Photos stay on their phone (2.7.1).
 */

/** Library item kinds as this phone stores them. */
export type LocalKind = 'folder' | 'track' | 'waypoint' | 'area' | 'map';

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

/** Built-in activity types a trail's `ty` may name (custom ones stay on their phone). */
export const SHARED_TYPES: ReadonlySet<string> = new Set(BUILT_IN_CATEGORIES.map((c) => c.id));

export interface TrackLike {
  name: string;
  points: readonly CodecPoint[];
  segmentStarts?: readonly number[];
  category?: string;
}

/**
 * A trail's record fields and the encoded geometry its parts carry. A trail
 * past {@link MAX_TRACK_POINTS} points or {@link MAX_TRACK_PARTS} parts is
 * written by name only ("not shared yet" on other phones).
 */
export function trackFields(
  itemId: string,
  t: TrackLike,
): { fields: Record<string, Json>; encoded?: string } {
  const f: Record<string, Json> = { t: 'trk', n: name(t.name) };
  if (t.category !== undefined && SHARED_TYPES.has(t.category)) f['ty'] = t.category;
  if (t.points.length > MAX_TRACK_POINTS) return { fields: f };
  const encoded = encodeTrack({
    points: [...t.points],
    segmentStarts: [...(t.segmentStarts ?? [])],
  });
  if (encoded === undefined) return { fields: f };
  const count = Math.ceil(encoded.length / PART_CHARS);
  if (count > MAX_TRACK_PARTS) return { fields: f };
  f['tr'] = trackRevision(itemId, encoded);
  f['tc'] = count;
  return { fields: f, encoded };
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

/** A trail from its record and its assembled parts (undefined: not all in, or malformed). */
export function trackFrom(
  f: Readonly<Record<string, Json>>,
  encoded: string | undefined,
): (CodecTrack & { name: string; category?: string }) | undefined {
  if (encoded === undefined || typeof f['tr'] !== 'string') return undefined;
  const t = decodeTrack(encoded);
  if (t === undefined) return undefined;
  const out: CodecTrack & { name: string; category?: string } = {
    ...t,
    name: str(f['n']) ?? 'Trail',
  };
  const ty = str(f['ty']);
  if (ty !== undefined && SHARED_TYPES.has(ty)) out.category = ty;
  return out;
}

/**
 * Whether this phone can hold the record as a library item now: a trail or
 * an area with its geometry, a waypoint with a position. A map needs its
 * file (a catalog download, or 2.7.1 for an imported PDF), so never here.
 */
export function representable(f: Readonly<Record<string, Json>>): boolean {
  switch (localKindOf(f)) {
    case 'track':
      // A trail needs its parts, which the bridge assembles from the group.
      return false;
    case 'waypoint':
      return waypointFrom(f) !== undefined;
    case 'area':
      return areaFrom(f, '#000000') !== undefined;
    default:
      return false;
  }
}
