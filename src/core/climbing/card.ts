/**
 * What the crag rows and cards say (mockups 01, 02, 05), from the tile
 * summary alone (offline anywhere the tiles are cached) or the saved topo.
 *
 * Access is safety-critical: a crag is "open" ONLY when a partner with the
 * authority says so (FQME, once agreed in writing). Anything else that is not
 * a known restriction reads "Access unknown", with where to check — never a
 * silent "open" from missing data.
 */
import type { AccessStatus, ClimbStyle, CragSource, CragSummary } from './crag';
import { mainKind, STYLE_LABELS } from './crag';
import type { CragDetail, CragSourceCredit } from './detail';
import type { Band, GradeKind, GradeSystem } from './grades';
import { bandLabels, gradeRangeLabel } from './grades';

export type AccessTone = 'ok' | 'warn' | 'danger' | 'unknown';

export interface AccessView {
  status: AccessStatus;
  tone: AccessTone;
  /** "Access unknown · check FQME". */
  label: string;
  /** Where to check, when we know (the FQME map in Québec, the partner's page). */
  url: string | null;
}

export const FQME_MAP_URL = 'https://fqme.qc.ca/carte/';

/** Roughly Québec (a hint for the tile-only card; the topo's admin1 is exact). */
export function inQuebec(lat: number, lng: number): boolean {
  if (lat < 45 || lat > 62.6 || lng < -79.8 || lng > -57.1) return false;
  if (lat < 47.4 && lng > -69.3) return false; // Maine, New Brunswick, Nova Scotia
  if (lat > 51.7 && lng > -64.5) return false; // Labrador
  return true;
}

export function accessView(
  status: AccessStatus,
  where: { lat: number; lng: number; cc?: string; admin1?: string },
  partner?: { src?: string; note?: string; url?: string },
): AccessView {
  const quebec =
    where.cc !== undefined
      ? where.cc === 'CA' && /qu[ée]bec/i.test(where.admin1 ?? '')
      : inQuebec(where.lat, where.lng);
  const by = partner?.src === 'fqme' ? ' · FQME' : '';
  switch (status) {
    case 'open':
      // Only ever from a partner's word: the pipeline never writes it otherwise.
      return { status, tone: 'ok', label: `Access open${by}`, url: partner?.url ?? null };
    case 'restricted':
      return {
        status,
        tone: 'warn',
        label: `Access restricted${by}${partner?.note ? ` · ${partner.note}` : ''}`,
        url: partner?.url ?? (quebec ? FQME_MAP_URL : null),
      };
    case 'closed':
      return {
        status,
        tone: 'danger',
        label: `Access closed${by}`,
        url: partner?.url ?? (quebec ? FQME_MAP_URL : null),
      };
    case 'banned':
      return {
        status,
        tone: 'danger',
        label: `Climbing banned${by}`,
        url: partner?.url ?? (quebec ? FQME_MAP_URL : null),
      };
    default:
      return quebec
        ? {
            status: 'unknown',
            tone: 'unknown',
            label: 'Access unknown · check FQME',
            url: FQME_MAP_URL,
          }
        : {
            status: 'unknown',
            tone: 'unknown',
            label: 'Access unknown · check locally before you go',
            url: null,
          };
  }
}

export interface BandSegment {
  band: Band;
  count: number;
  /** Share of the bar, 0–1. */
  share: number;
  label: string;
}

/** The four-colour bar and its legend ("≤ 5.7 · 4"), empty bands dropped. */
export function bandSegments(
  bands: readonly [number, number, number, number],
  system: GradeSystem,
): BandSegment[] {
  const total = bands.reduce((a, b) => a + b, 0);
  if (total === 0) return [];
  const labels = bandLabels(system);
  return ([0, 1, 2, 3] as Band[])
    .filter((b) => bands[b] > 0)
    .map((b) => ({ band: b, count: bands[b], share: bands[b] / total, label: labels[b] }));
}

/** "5.4 – 5.13a" in the crag's main discipline (ropes, else boulders, else ice). */
export function cragGradeRange(
  ranges: Partial<Record<GradeKind, [number, number]>>,
  styles: readonly ClimbStyle[],
  system: GradeSystem,
): string | null {
  const kind = mainKind({ ranges, styles: [...styles] });
  if (kind === null) return null;
  const r = ranges[kind];
  return r ? gradeRangeLabel(kind, r, system) : null;
}

/** "18 sport · 19 trad" (largest first, at most three). */
export function styleLine(counts: Partial<Record<ClimbStyle, number>>): string {
  return (Object.entries(counts) as [ClimbStyle, number][])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([s, n]) => `${n} ${STYLE_LABELS[s].toLowerCase()}`)
    .join(' · ');
}

/** "Sport · Trad" from the tile's style bits (no counts there). */
export function styleNames(styles: readonly ClimbStyle[]): string {
  return styles
    .slice(0, 3)
    .map((s) => STYLE_LABELS[s])
    .join(' · ');
}

export function routesLabel(n: number): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? 'route' : 'routes'}`;
}

/** The list row's second line: "34 routes · 5.4 – 5.13+ · 10 km". */
export function cragRowMeta(
  crag: Pick<CragSummary, 'routes' | 'ranges' | 'styles'>,
  system: GradeSystem,
  distance: string | null,
): string {
  return [
    crag.routes > 0 ? routesLabel(crag.routes) : 'No route list yet',
    cragGradeRange(crag.ranges, crag.styles, system),
    distance,
  ]
    .filter((p): p is string => p !== null && p !== '')
    .join(' · ');
}

/** "15 min approach" / "1 h 30 approach". */
export function approachLabel(min: number | null | undefined): string | null {
  if (min == null || min <= 0) return null;
  if (min < 60) return `${min} min approach`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h} h${m > 0 ? ` ${String(m).padStart(2, '0')}` : ''} approach`;
}

const SOURCE_NAMES: Record<string, string> = {
  ob: 'OpenBeta (CC0)',
  osm: '© OpenStreetMap contributors (ODbL)',
  c2c: 'camptocamp.org (CC BY-SA)',
  fqme: 'FQME',
};

/**
 * The card's credit line, from the tile's source bits:
 * "Route data: OpenBeta (CC0)", "Crag: OpenBeta (CC0) · routes © OpenStreetMap
 * contributors (ODbL)", "+ camptocamp.org (CC BY-SA)".
 */
export function attributionLine(sources: readonly (CragSource | string)[]): string {
  const has = (s: string) => sources.includes(s as CragSource);
  const parts: string[] = [];
  if (has('ob') && has('osm')) {
    parts.push(`Crag: ${SOURCE_NAMES.ob} · routes ${SOURCE_NAMES.osm}`);
  } else if (has('ob')) {
    parts.push(`Route data: ${SOURCE_NAMES.ob}`);
  } else if (has('osm')) {
    parts.push(`Route data ${SOURCE_NAMES.osm}`);
  }
  if (has('c2c')) parts.push(`${parts.length ? '' : 'Crag: '}${SOURCE_NAMES.c2c}`);
  if (has('fqme')) parts.push('Access: FQME');
  return parts.join(' · ');
}

/** The topo footer: every source with its role, then the diagram credit. */
export function topoCredits(sources: readonly CragSourceCredit[], diagram: boolean): string[] {
  const roles: Record<string, string> = {
    routes: 'Routes',
    crag: 'Crag',
    approach: 'Approach',
  };
  const lines = sources.map((s) => {
    const name = s.src === 'osm' ? '© OpenStreetMap contributors' : s.name;
    return `${roles[s.role] ?? 'Data'}: ${name} (${licenceName(s.licence)})`;
  });
  if (diagram) lines.push('Diagram generated by Inukshuk from the route starts, not to scale');
  return lines;
}

export function licenceName(spdx: string): string {
  const names: Record<string, string> = {
    'CC0-1.0': 'CC0',
    'ODbL-1.0': 'ODbL',
    'CC-BY-SA-3.0': 'CC BY-SA 3.0',
  };
  return names[spdx] ?? spdx;
}

/** The safety line on every topo. */
export const SAFETY_LINE =
  'Route information can be wrong or out of date. Check access and conditions before you climb.';

/** "Black and White · Club Sandwich · Ionescu · +9 more". */
export function sectorList(names: readonly string[], max = 3): string {
  if (names.length <= max) return names.join(' · ');
  return `${names.slice(0, max).join(' · ')} · +${names.length - max} more`;
}

/** A tile-shaped summary of a saved topo (so saved crags render with the same card). */
export function summaryFromDetail(d: CragDetail): CragSummary {
  return {
    uid: d.uid,
    name: d.name,
    lat: d.lat,
    lng: d.lng,
    routes: d.routeCount,
    sectors: d.sectors.length,
    styles: (Object.keys(d.styles) as ClimbStyle[]).filter((s) => (d.styles[s] ?? 0) > 0),
    bands: d.bands,
    ranges: d.grades,
    access: d.access.status,
    sources: d.sources.map((s) => s.src as CragSource),
    diagram: d.sectors.some((s) => s.ordered),
    approachMin: d.approach?.min ?? null,
    region: d.region ?? d.admin1 ?? null,
    version: d.v,
  };
}
