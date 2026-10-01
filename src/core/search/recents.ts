import type { Place, PlaceSource } from './place';
import { PLACE_TYPES, type PlaceType } from './placeTypes';

/**
 * Recent searches: the last places the user chose, newest first, kept on the
 * device only. A recent is the chosen {@link Place} itself, so tapping it again
 * flies there without asking the index (it works offline too).
 */

export const MAX_RECENTS = 10;

/** Put `place` first, drop its older copy, cap the list. */
export function pushRecent(list: readonly Place[], place: Place, max = MAX_RECENTS): Place[] {
  return [place, ...list.filter((p) => p.id !== place.id)].slice(0, max);
}

const SOURCES: readonly PlaceSource[] = [
  'index',
  'coordinates',
  'waypoint',
  'track',
  'map',
  'catalog',
  'longTrail',
];

const isStr = (v: unknown): v is string => typeof v === 'string' && v !== '';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function sanitizePlace(v: unknown): Place | null {
  if (v === null || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (!isStr(r.id) || !isStr(r.name) || !isNum(r.latitude) || !isNum(r.longitude)) return null;
  if (!isStr(r.type) || !(r.type in PLACE_TYPES)) return null;
  if (!isStr(r.source) || !SOURCES.includes(r.source as PlaceSource)) return null;
  if (Math.abs(r.latitude) > 90 || Math.abs(r.longitude) > 180) return null;
  const place: Place = {
    id: r.id,
    source: r.source as PlaceSource,
    type: r.type as PlaceType,
    name: r.name,
    latitude: r.latitude,
    longitude: r.longitude,
  };
  if (isStr(r.altName)) place.altName = r.altName;
  if (isStr(r.context)) place.context = r.context;
  if (isNum(r.elevationM)) place.elevationM = r.elevationM;
  if (Array.isArray(r.bbox) && r.bbox.length === 4 && r.bbox.every(isNum)) {
    place.bbox = r.bbox as [number, number, number, number];
  }
  return place;
}

/** Whatever was on disk → a clean recents list (junk entries dropped). */
export function sanitizeRecents(raw: unknown): Place[] {
  if (!Array.isArray(raw)) return [];
  const out: Place[] = [];
  for (const v of raw) {
    const p = sanitizePlace(v);
    if (p !== null && !out.some((o) => o.id === p.id)) out.push(p);
  }
  return out.slice(0, MAX_RECENTS);
}
