/**
 * Filtering the geodetic points by their attributes (overlays menu →
 * Geodetic points → filter). The filter is persisted in settings and turned
 * into MapLibre filter expressions on the TILE properties (see `./record`
 * for the keys), applied live on every geodetic layer.
 *
 * Only attributes the tiles really carry are offered:
 *   type `k` · legacy datum `l` · source `s` · vertical datums `hd`/`hd2` ·
 *   condition `c` (absent = good; destroyed / not-found marks are never in
 *   the tiles) · position precision `p` (decimetres, only when ≥ 1 m) ·
 *   heights `H` · published coordinates `gc`/`g1` · last visit `v`.
 *
 * OpenStreetMap points (their own layer) carry only type, heights and the
 * source: any filter on an attribute they lack hides them, rather than
 * guessing.
 *
 * MapLibre rules: no `["zoom"]` anywhere in here (filters are property-only).
 */
import type { ExpressionSpecification } from '@maplibre/maplibre-gl-style-spec';
import { GEODETIC_CATALOG, OSM_SOURCE_INDEX } from './catalog';
import type { MarkStatus, MarkType } from './record';

export const FILTER_TYPES: readonly MarkType[] = ['3d', 'h', 'v', 'gnss', 'u'];
export const FILTER_STATUSES: readonly MarkStatus[] = ['ok', 'damaged', 'unknown'];
export type DatumFilter = 'all' | 'modern' | 'legacy';
/** Position precision: any · within 10 m · within 2 m · better than 1 m. */
export type PrecisionFilter = 'any' | '10' | '2' | '1';
export const PRECISION_FILTERS: readonly PrecisionFilter[] = ['any', '10', '2', '1'];
export const VISITED_SINCE_CHOICES: readonly number[] = [0, 2000, 2010, 2020];

export interface GeodeticFilter {
  /** Types shown. */
  types: MarkType[];
  datum: DatumFilter;
  /** Conditions shown. */
  status: MarkStatus[];
  precision: PrecisionFilter;
  /** Only marks with at least one published height. */
  hasHeights: boolean;
  /** Only marks with the agency's published coordinates (datasheet details). */
  hasDetails: boolean;
  /** Only marks visited in or after this year; 0 = any. */
  visitedSince: number;
  /** Vertical-datum indices: a mark shows if it has a height on any of them; [] = any. */
  vdatums: number[];
  /** Source indices hidden. */
  hiddenSources: number[];
}

export const DEFAULT_GEODETIC_FILTER: GeodeticFilter = {
  types: [...FILTER_TYPES],
  datum: 'all',
  status: [...FILTER_STATUSES],
  precision: 'any',
  hasHeights: false,
  hasDetails: false,
  visitedSince: 0,
  vdatums: [],
  hiddenSources: [],
};

const STATUS_CODE: Record<MarkStatus, number> = { ok: 0, damaged: 1, unknown: 4 };
/** `p` (decimetres) a precision level admits; null = no bound. */
const PRECISION_MAX_DM: Record<PrecisionFilter, number | null> = {
  any: null,
  '10': 100,
  '2': 20,
  '1': 9,
};

function pickList<T>(raw: unknown, allowed: readonly T[]): T[] | null {
  if (!Array.isArray(raw)) return null;
  return allowed.filter((a) => raw.includes(a));
}

function indexList(raw: unknown, size: number): number[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<number>();
  for (const v of raw) if (Number.isInteger(v) && v >= 0 && v < size) out.add(v as number);
  return [...out].sort((a, b) => a - b);
}

/** Total: any junk from settings.json becomes a valid filter (unknown keys dropped). */
export function sanitizeGeodeticFilter(raw: unknown): GeodeticFilter {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_GEODETIC_FILTER };
  const r = raw as Record<string, unknown>;
  const d = DEFAULT_GEODETIC_FILTER;
  const datum = r.datum === 'modern' || r.datum === 'legacy' ? r.datum : 'all';
  const precision = PRECISION_FILTERS.includes(r.precision as PrecisionFilter)
    ? (r.precision as PrecisionFilter)
    : 'any';
  const year = r.visitedSince;
  return {
    types: pickList(r.types, FILTER_TYPES) ?? [...d.types],
    datum,
    status: pickList(r.status, FILTER_STATUSES) ?? [...d.status],
    precision,
    hasHeights: r.hasHeights === true,
    hasDetails: r.hasDetails === true,
    visitedSince:
      typeof year === 'number' && Number.isInteger(year) && year >= 1800 && year <= 2200 ? year : 0,
    vdatums: indexList(r.vdatums, GEODETIC_CATALOG.vdatums.length),
    hiddenSources: indexList(r.hiddenSources, GEODETIC_CATALOG.sources.length),
  };
}

/** How many filter groups differ from the default (the funnel's badge). */
export function activeFilterCount(f: GeodeticFilter): number {
  let n = 0;
  if (f.types.length !== FILTER_TYPES.length) n++;
  if (f.datum !== 'all') n++;
  if (f.status.length !== FILTER_STATUSES.length) n++;
  if (f.precision !== 'any') n++;
  if (f.hasHeights) n++;
  if (f.hasDetails) n++;
  if (f.visitedSince > 0) n++;
  if (f.vdatums.length > 0) n++;
  if (f.hiddenSources.length > 0) n++;
  return n;
}

export interface GeodeticLayerFilters {
  /** For the official layer; null = no filter. */
  official: ExpressionSpecification | null;
  /** For the OSM layer; null = no filter; 'hidden' = draw no OSM point at all. */
  osm: ExpressionSpecification | 'hidden' | null;
}

function all(parts: ExpressionSpecification[]): ExpressionSpecification | null {
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0] ?? null;
  return ['all', ...parts];
}

/** A filter nothing passes (an empty multi-select). */
const NOTHING: ExpressionSpecification = ['boolean', false];

function typeClause(types: readonly MarkType[]): ExpressionSpecification {
  return ['match', ['get', 'k'], [...types], true, false];
}

/** The filter expressions for both geodetic layers. */
export function buildGeodeticFilters(f: GeodeticFilter): GeodeticLayerFilters {
  const official: ExpressionSpecification[] = [];
  const osm: ExpressionSpecification[] = [];
  let osmHidden = f.types.length === 0;

  if (f.types.length !== FILTER_TYPES.length) {
    if (f.types.length === 0) {
      official.push(NOTHING);
    } else {
      official.push(typeClause(f.types));
      osm.push(typeClause(f.types));
    }
  }
  if (f.datum !== 'all') {
    official.push(f.datum === 'legacy' ? ['has', 'l'] : ['!', ['has', 'l']]);
    osmHidden = true;
  }
  if (f.status.length !== FILTER_STATUSES.length) {
    const codes = f.status.map((s) => STATUS_CODE[s]);
    official.push(
      codes.length === 0 ? NOTHING : ['match', ['coalesce', ['get', 'c'], 0], codes, true, false],
    );
    osmHidden = true;
  }
  const maxDm = PRECISION_MAX_DM[f.precision];
  if (maxDm !== null) {
    official.push(['any', ['!', ['has', 'p']], ['<=', ['to-number', ['get', 'p'], 0], maxDm]]);
    osmHidden = true;
  }
  if (f.hasHeights) {
    official.push(['has', 'H']);
    osm.push(['has', 'H']);
  }
  if (f.hasDetails) {
    official.push(['any', ['has', 'gc'], ['has', 'g1']]);
    osmHidden = true;
  }
  if (f.visitedSince > 0) {
    official.push(['>=', ['to-string', ['coalesce', ['get', 'v'], '']], String(f.visitedSince)]);
    osmHidden = true;
  }
  if (f.vdatums.length > 0) {
    const list: ExpressionSpecification = ['literal', [...f.vdatums]];
    official.push([
      'any',
      ['in', ['coalesce', ['get', 'hd'], -1], list],
      ['in', ['coalesce', ['get', 'hd2'], -1], list],
    ]);
    osmHidden = true;
  }
  const hiddenOfficial = f.hiddenSources.filter((s) => s !== OSM_SOURCE_INDEX);
  if (hiddenOfficial.length > 0) {
    official.push(['!', ['in', ['get', 's'], ['literal', hiddenOfficial]]]);
  }
  if (f.hiddenSources.includes(OSM_SOURCE_INDEX)) osmHidden = true;

  return { official: all(official), osm: osmHidden ? 'hidden' : all(osm) };
}
