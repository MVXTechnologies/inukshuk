/**
 * A crag as the tiles carry it (`crags.pmtiles`, layer `crags`, built by
 * `infra/tiles/nas/climbing/publish.py`): everything the Explore list row,
 * the map badge and the crag card need, so they work offline wherever the
 * tiles are cached.
 *
 *   i uid · n name · r routes · s sectors · st style bits · b band counts
 *   "easy,mid,hard,elite" · g0/g1 rope ladder · v0/v1 boulder · w0/w1 ice ·
 *   a access (absent = unknown) · src source bits · ord 1 = a wall diagram ·
 *   ap approach minutes · rg region · v topo version
 */
import type { Band, GradeKind } from './grades';

export const STYLE_BITS = {
  sport: 1,
  trad: 2,
  tr: 4,
  boulder: 8,
  ice: 16,
  mixed: 32,
  alpine: 64,
  aid: 128,
} as const;
export type ClimbStyle = keyof typeof STYLE_BITS;
export const STYLES = Object.keys(STYLE_BITS) as ClimbStyle[];

export const STYLE_LABELS: Record<ClimbStyle, string> = {
  sport: 'Sport',
  trad: 'Trad',
  tr: 'Top rope',
  boulder: 'Boulder',
  ice: 'Ice',
  mixed: 'Mixed',
  alpine: 'Alpine',
  aid: 'Aid',
};

export type AccessStatus = 'open' | 'restricted' | 'closed' | 'banned' | 'unknown';
const ACCESS_CODES: readonly AccessStatus[] = ['open', 'restricted', 'closed', 'banned'];

export const SOURCE_BITS = { ob: 1, osm: 2, c2c: 4, fqme: 8 } as const;
export type CragSource = keyof typeof SOURCE_BITS;

export interface CragSummary {
  uid: string;
  name: string;
  lat: number;
  lng: number;
  routes: number;
  sectors: number;
  styles: ClimbStyle[];
  /** Route counts per band (easy, mid, hard, elite). */
  bands: [number, number, number, number];
  /** Ladder ranges per discipline, when known. */
  ranges: Partial<Record<GradeKind, [number, number]>>;
  access: AccessStatus;
  sources: CragSource[];
  /** A sector has its left-to-right order: the topo can draw the wall. */
  diagram: boolean;
  approachMin: number | null;
  region: string | null;
  version: string;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

export function stylesOf(bits: number): ClimbStyle[] {
  return STYLES.filter((s) => (bits & STYLE_BITS[s]) !== 0);
}

export function parseBands(raw: unknown): [number, number, number, number] {
  const parts = typeof raw === 'string' ? raw.split(',').map((p) => Number(p)) : [];
  const at = (i: number) => {
    const v = parts[i];
    return v !== undefined && Number.isFinite(v) && v > 0 ? v : 0;
  };
  return [at(0), at(1), at(2), at(3)];
}

/** A tile feature (`crags` layer) → a crag summary; null when it isn't one. */
export function parseCragTile(feature: {
  properties?: Record<string, unknown> | null;
  geometry?: { type: string; coordinates?: unknown } | null;
}): CragSummary | null {
  const p = feature.properties ?? {};
  const uid = str(p.i);
  const name = str(p.n);
  const coords = feature.geometry?.type === 'Point' ? feature.geometry.coordinates : null;
  if (uid === null || name === null || !Array.isArray(coords)) return null;
  const [lng, lat] = coords as unknown[];
  if (typeof lng !== 'number' || typeof lat !== 'number') return null;
  const ranges: CragSummary['ranges'] = {};
  for (const [kind, lo, hi] of [
    ['r', 'g0', 'g1'],
    ['b', 'v0', 'v1'],
    ['i', 'w0', 'w1'],
  ] as const) {
    const a = num(p[lo]);
    const b = num(p[hi]);
    if (a !== null && b !== null) ranges[kind] = [a, b];
  }
  const a = num(p.a);
  const srcBits = num(p.src) ?? 0;
  return {
    uid,
    name,
    lat,
    lng,
    routes: num(p.r) ?? 0,
    sectors: num(p.s) ?? 0,
    styles: stylesOf(num(p.st) ?? 0),
    bands: parseBands(p.b),
    ranges,
    access: a !== null ? (ACCESS_CODES[a] ?? 'unknown') : 'unknown',
    sources: (Object.keys(SOURCE_BITS) as CragSource[]).filter(
      (s) => (srcBits & SOURCE_BITS[s]) !== 0,
    ),
    diagram: num(p.ord) === 1,
    approachMin: num(p.ap),
    region: str(p.rg),
    version: str(p.v) ?? '',
  };
}

/** The discipline whose grades describe a crag best (most routes in it). */
export function mainKind(c: Pick<CragSummary, 'ranges' | 'styles'>): GradeKind | null {
  if (c.ranges.r) return 'r';
  if (c.ranges.b) return 'b';
  if (c.ranges.i) return 'i';
  return null;
}

/** Bands whose count is non-zero, for the legend under the bar. */
export function nonEmptyBands(bands: readonly number[]): Band[] {
  return ([0, 1, 2, 3] as Band[]).filter((b) => (bands[b] ?? 0) > 0);
}

/** Whether a crag may be downloaded: never a closed or banned one. */
export function downloadable(access: AccessStatus): boolean {
  return access !== 'closed' && access !== 'banned';
}
