/**
 * Tile feature → geodetic mark. The tile schema (one/two-letter keys, see
 * `infra/tiles/nas/geodetic/tiles.py`):
 *
 * | key | meaning |
 * |-----|---------|
 * | `i` | the agency's id | `s` source index | `k` type (3d, h, v, gnss, u) |
 * | `c` | status (absent ok, 1 damaged, 4 unknown) | `l` 1 = legacy datum |
 * | `y`/`x` | the display lat / lng (the geometry is quantized; these are not) |
 * | `d` | datum index | `n` name / designation |
 * | `gc` | the agency's published geographic coordinates, verbatim text |
 * | `g1`, `g2` | the agency's published grid coordinates, "system;E;N", verbatim |
 * | `H`/`hd`, `H2`/`hd2` | heights as published (text) and their vertical-datum index |
 * | `h` | ellipsoidal height as published | `m`/`mt` monument code / agency wording |
 * | `v` | last visit | `p` how far our position may be off, decimetres |
 * | `w` | page URL (OSM) | `z` enters at z14 |
 *
 * Agency values stay strings end to end: the card prints the agency's digits
 * (a trailing zero is information), never a recomputed value. Every field but
 * `i`, `s` and a position is optional: a mark with nothing else still makes a
 * card (type, source, display position, datasheet link).
 */
import { parseTidalHeight, type TidalHeight } from '@core/tides/tidalBenchmark';
import { OSM_SOURCE_INDEX } from './catalog';

export type MarkType = '3d' | 'h' | 'v' | 'gnss' | 'u';
export type MarkStatus = 'ok' | 'damaged' | 'unknown';

export interface MarkHeight {
  /** As published, e.g. "77.660". */
  text: string;
  /** Vertical-datum index into the catalogue; undefined = not stated (OSM `ele`). */
  vdatum?: number;
}

/** A published grid coordinate pair, verbatim. */
export interface MarkGrid {
  system: string;
  e: string;
  n: string;
}

export interface GeodeticMark {
  id: string;
  source: number;
  osm: boolean;
  type: MarkType;
  status: MarkStatus;
  legacy: boolean;
  lat: number;
  lng: number;
  datum?: number;
  name?: string;
  heights: MarkHeight[];
  /** Ellipsoidal height as published. */
  hEll?: string;
  /** Published geographic coordinates in the native datum, verbatim. */
  geo?: string;
  grids: MarkGrid[];
  monumentCode?: string;
  monumentText?: string;
  lastVisit?: string;
  /** Metres our displayed position may be off (bulk layers, scaled benchmarks). */
  posAccM?: number;
  /** A per-mark page (OSM `website`/`url`). */
  url?: string;
  /** A tidal benchmark's chart-datum height (`@core/tides/tidalBenchmark`). */
  tidal?: TidalHeight;
}

const TYPES: readonly string[] = ['3d', 'h', 'v', 'gnss', 'u'];

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** A published number kept as text (old tiles may carry it as a number). */
function published(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim() !== '') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

function grid(v: unknown): MarkGrid | null {
  if (typeof v !== 'string') return null;
  const [system, e, n] = v.split(';');
  return system && e && n ? { system, e, n } : null;
}

function str(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim() !== '') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

/**
 * Parse one tile feature's properties. `fallback` is the feature geometry's
 * [lng, lat], used only when the exact `x`/`y` are missing. Null when the
 * feature isn't a geodetic mark.
 */
export function parseGeodeticFeature(
  props: Readonly<Record<string, unknown>> | null | undefined,
  fallback?: readonly [number, number] | null,
): GeodeticMark | null {
  if (!props) return null;
  const id = str(props.i);
  const source = num(props.s);
  if (id === undefined || source === undefined) return null;
  const lat = num(props.y) ?? fallback?.[1];
  const lng = num(props.x) ?? fallback?.[0];
  if (lat === undefined || lng === undefined || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return null;
  }
  const k = str(props.k);
  const type: MarkType = k !== undefined && TYPES.includes(k) ? (k as MarkType) : 'u';
  const c = num(props.c);
  const status: MarkStatus = c === 1 ? 'damaged' : c === 4 ? 'unknown' : 'ok';
  const heights: MarkHeight[] = [];
  for (const [hk, dk] of [
    ['H', 'hd'],
    ['H2', 'hd2'],
  ] as const) {
    const text = published(props[hk]);
    if (text === undefined) continue;
    const vdatum = num(props[dk]);
    heights.push(vdatum === undefined ? { text } : { text, vdatum });
  }
  const mark: GeodeticMark = {
    id,
    source,
    osm: source === OSM_SOURCE_INDEX,
    type,
    status,
    legacy: num(props.l) === 1,
    lat,
    lng,
    heights,
    grids: [grid(props.g1), grid(props.g2)].filter((g): g is MarkGrid => g !== null),
  };
  const datum = num(props.d);
  if (datum !== undefined) mark.datum = datum;
  const name = str(props.n);
  if (name !== undefined && name !== id) mark.name = name;
  const hEll = published(props.h);
  if (hEll !== undefined) mark.hEll = hEll;
  const geo = str(props.gc);
  if (geo !== undefined) mark.geo = geo;
  const m = str(props.m);
  if (m !== undefined) mark.monumentCode = m;
  const mt = str(props.mt);
  if (mt !== undefined) mark.monumentText = mt;
  const v = str(props.v);
  if (v !== undefined) mark.lastVisit = v;
  const p = num(props.p);
  if (p !== undefined && p > 0) mark.posAccM = p / 10;
  const w = str(props.w);
  if (w !== undefined && /^https?:\/\//.test(w)) mark.url = w;
  const tidal = parseTidalHeight(props);
  if (tidal) mark.tidal = tidal;
  return mark;
}

/** Stable identity for selection (the same id can exist in two sources). */
export function markKey(m: Pick<GeodeticMark, 'source' | 'id'>): string {
  return `${m.source}:${m.id}`;
}

interface FeatureLike {
  properties?: Readonly<Record<string, unknown>> | null;
  geometry?: { type?: string; coordinates?: unknown } | null;
}

function pointOf(f: FeatureLike): [number, number] | null {
  const c = f.geometry?.type === 'Point' ? f.geometry.coordinates : null;
  if (!Array.isArray(c)) return null;
  const [lng, lat] = c as unknown[];
  return typeof lng === 'number' && typeof lat === 'number' ? [lng, lat] : null;
}

/**
 * The mark a tap meant, from the features MapLibre found in the hit box: the
 * nearest to the tapped point, official marks winning ties over OSM ones.
 */
export function pickTappedMark(
  features: readonly unknown[],
  tap: readonly [number, number],
): GeodeticMark | null {
  let best: { mark: GeodeticMark; d: number } | null = null;
  const cos = Math.cos((tap[1] * Math.PI) / 180);
  for (const raw of features) {
    if (typeof raw !== 'object' || raw === null) continue;
    const f = raw as FeatureLike;
    const mark = parseGeodeticFeature(f.properties, pointOf(f));
    if (!mark) continue;
    const d = Math.hypot((mark.lng - tap[0]) * cos, mark.lat - tap[1]) * (mark.osm ? 1.15 : 1);
    const better = best === null || d < best.d || (d === best.d && best.mark.osm && !mark.osm);
    if (better) best = { mark, d };
  }
  return best?.mark ?? null;
}
