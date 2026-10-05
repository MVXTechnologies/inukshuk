/**
 * A crag's topo: the detail document the NAS builds per crag
 * (`infra/tiles/nas/climbing/publish.py` `detail_doc`), served by the Worker
 * as /climbing/v1/d/{version}/{uid}.json and saved on the phone by a
 * download. Schema 1. Parsing is defensive: a malformed route is dropped, an
 * unknown field ignored, a missing access status reads "unknown".
 */
import type { AccessStatus, ClimbStyle, CragSource } from './crag';
import { STYLE_BITS, stylesOf } from './crag';
import type { GradeKind, GradedRoute } from './grades';

export const DETAIL_SCHEMA = 1;

export interface CragRoute extends GradedRoute {
  /** Source id: `ob:{uuid}`, `osm:n123`. */
  id: string;
  name: string;
  styles: ClimbStyle[];
  lengthM?: number;
  bolts?: number;
  pitches?: number;
  /** Route start [lng, lat] (OSM only). */
  pos?: [number, number];
  /** OSM `description` (ODbL); never OpenBeta text. */
  desc?: string;
}

export interface CragSector {
  name: string;
  src: 'ob' | 'osm' | string;
  /** Routes are in left-to-right order (OSM route starts): the wall can be drawn. */
  ordered: boolean;
  pt?: [number, number];
  /** OSM element of the wall ("way/123"), for "Help map this crag". */
  osm?: string;
  routes: CragRoute[];
}

export interface CragLink {
  kind: 'topo' | 'access' | 'info';
  url: string;
  src: string;
}

export interface CragSourceCredit {
  src: CragSource | string;
  role: string;
  name: string;
  licence: string;
  url: string;
  page?: string;
}

export interface CragApproach {
  min?: number;
  /** Verbatim text by language (camptocamp, CC BY-SA). */
  text?: Record<string, string>;
  src: string;
  url?: string;
}

export interface CragAccess {
  status: AccessStatus;
  src?: string;
  note?: string;
  url?: string;
}

export interface CragDetail {
  schema: number;
  uid: string;
  v: string;
  name: string;
  names?: Record<string, string>;
  lat: number;
  lng: number;
  region?: string;
  admin1?: string;
  country?: string;
  cc?: string;
  routeCount: number;
  /** Routes in the list (a camptocamp-only crag has a count but no list). */
  listed: number;
  styles: Partial<Record<ClimbStyle, number>>;
  bands: [number, number, number, number];
  grades: Partial<Record<GradeKind, [number, number]>>;
  sectors: CragSector[];
  access: CragAccess;
  links: CragLink[];
  sources: CragSourceCredit[];
  aliases: string[];
  rock?: string;
  aspect?: string;
  height?: number;
  approach?: CragApproach;
}

const STATUSES: readonly AccessStatus[] = ['open', 'restricted', 'closed', 'banned', 'unknown'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function point(v: unknown): [number, number] | undefined {
  if (!Array.isArray(v) || v.length < 2) return undefined;
  const [a, b] = v as unknown[];
  return typeof a === 'number' && typeof b === 'number' ? [a, b] : undefined;
}

function range(v: unknown): [number, number] | undefined {
  const p = point(v);
  return p !== undefined && p[0] <= p[1] ? p : undefined;
}

function parseRoute(raw: unknown): CragRoute | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  if (id === undefined) return null;
  const route: CragRoute = {
    id,
    name: str(raw.n) ?? 'Unnamed',
    styles: stylesOf(num(raw.st) ?? 0),
  };
  const g = str(raw.g);
  const gs = str(raw.gs);
  if (g !== undefined) route.g = g;
  if (gs !== undefined) route.gs = gs;
  const k = raw.k;
  const x = num(raw.x);
  if ((k === 'r' || k === 'b' || k === 'i') && x !== undefined) {
    route.k = k;
    route.x = x;
  }
  const len = num(raw.len);
  if (len !== undefined && len > 0) route.lengthM = len;
  const bolts = num(raw.bolts);
  if (bolts !== undefined && bolts > 0) route.bolts = bolts;
  const p = num(raw.p);
  if (p !== undefined && p > 1) route.pitches = p;
  const pos = point(raw.pos);
  if (pos !== undefined) route.pos = pos;
  const d = str(raw.d);
  if (d !== undefined) route.desc = d;
  return route;
}

function parseSector(raw: unknown): CragSector | null {
  if (!isRecord(raw) || !Array.isArray(raw.routes)) return null;
  const routes = raw.routes.map(parseRoute).filter((r): r is CragRoute => r !== null);
  const sector: CragSector = {
    name: str(raw.n) ?? 'Unnamed wall',
    src: str(raw.src) ?? 'unknown',
    // An order is only believed when every route has its start position.
    ordered: raw.ordered === true && routes.length >= 2 && routes.every((r) => r.pos),
    routes,
  };
  const pt = point(raw.pt);
  if (pt !== undefined) sector.pt = pt;
  const osm = str(raw.osm);
  if (osm !== undefined) sector.osm = osm;
  return sector;
}

function parseBandsArray(v: unknown): [number, number, number, number] {
  const a = Array.isArray(v) ? (v as unknown[]) : [];
  const at = (i: number) => num(a[i]) ?? 0;
  return [at(0), at(1), at(2), at(3)];
}

export function parseCragDetail(raw: unknown): CragDetail | null {
  if (!isRecord(raw) || raw.schema !== DETAIL_SCHEMA) return null;
  const uid = str(raw.uid);
  const name = str(raw.name);
  const lat = num(raw.lat);
  const lng = num(raw.lng);
  if (uid === undefined || name === undefined || lat === undefined || lng === undefined) {
    return null;
  }
  const sectors = (Array.isArray(raw.sectors) ? raw.sectors : [])
    .map(parseSector)
    .filter((s): s is CragSector => s !== null);
  const access: CragAccess = { status: 'unknown' };
  if (isRecord(raw.access)) {
    const s = raw.access.status;
    access.status = STATUSES.includes(s as AccessStatus) ? (s as AccessStatus) : 'unknown';
    const src = str(raw.access.src);
    const note = str(raw.access.note);
    const url = str(raw.access.url);
    if (src !== undefined) access.src = src;
    if (note !== undefined) access.note = note;
    if (url !== undefined) access.url = url;
  }
  const styles: CragDetail['styles'] = {};
  if (isRecord(raw.styles)) {
    for (const s of Object.keys(STYLE_BITS) as ClimbStyle[]) {
      const n = num(raw.styles[s]);
      if (n !== undefined && n > 0) styles[s] = n;
    }
  }
  const grades: CragDetail['grades'] = {};
  if (isRecord(raw.grades)) {
    for (const k of ['r', 'b', 'i'] as const) {
      const r = range(raw.grades[k]);
      if (r !== undefined) grades[k] = r;
    }
  }
  const links = (Array.isArray(raw.links) ? raw.links : []).flatMap((l): CragLink[] => {
    if (!isRecord(l)) return [];
    const url = str(l.url);
    const kind = l.kind;
    if (url === undefined || !/^https:\/\//.test(url)) return [];
    if (kind !== 'topo' && kind !== 'access' && kind !== 'info') return [];
    return [{ kind, url, src: str(l.src) ?? 'web' }];
  });
  const sources = (Array.isArray(raw.sources) ? raw.sources : []).flatMap(
    (s): CragSourceCredit[] => {
      if (!isRecord(s)) return [];
      const src = str(s.src);
      const credit = str(s.name);
      const licence = str(s.licence);
      if (src === undefined || credit === undefined || licence === undefined) return [];
      const out: CragSourceCredit = {
        src,
        role: str(s.role) ?? 'crag',
        name: credit,
        licence,
        url: str(s.url) ?? '',
      };
      const page = str(s.page);
      if (page !== undefined) out.page = page;
      return [out];
    },
  );
  const listed = sectors.reduce((n, s) => n + s.routes.length, 0);
  const detail: CragDetail = {
    schema: DETAIL_SCHEMA,
    uid,
    v: str(raw.v) ?? '',
    name,
    lat,
    lng,
    routeCount: num(raw.routeCount) ?? listed,
    listed,
    styles,
    bands: parseBandsArray(raw.bands),
    grades,
    sectors,
    access,
    links,
    sources,
    aliases: (Array.isArray(raw.aliases) ? raw.aliases : []).filter(
      (a): a is string => typeof a === 'string',
    ),
  };
  if (isRecord(raw.names)) {
    const names: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.names)) if (typeof v === 'string') names[k] = v;
    detail.names = names;
  }
  for (const k of ['region', 'admin1', 'country', 'cc', 'rock', 'aspect'] as const) {
    const v = str(raw[k]);
    if (v !== undefined) detail[k] = v;
  }
  const height = num(raw.height);
  if (height !== undefined) detail.height = height;
  if (isRecord(raw.approach)) {
    const a = raw.approach;
    const approach: CragApproach = { src: str(a.src) ?? 'unknown' };
    const min = num(a.min);
    if (min !== undefined) approach.min = min;
    const url = str(a.url);
    if (url !== undefined) approach.url = url;
    if (isRecord(a.text)) {
      const text: Record<string, string> = {};
      for (const [k, v] of Object.entries(a.text)) if (typeof v === 'string') text[k] = v;
      if (Object.keys(text).length > 0) approach.text = text;
    }
    if (approach.min !== undefined || approach.text !== undefined) detail.approach = approach;
  }
  return detail;
}

/** The approach text in the reader's language, else English, else any. */
export function approachText(
  approach: CragApproach | undefined,
  lang: string,
): { text: string; lang: string } | null {
  const texts = approach?.text;
  if (!texts) return null;
  for (const l of [lang, 'en', 'fr']) {
    const t = texts[l];
    if (t !== undefined) return { text: t, lang: l };
  }
  const first = Object.entries(texts)[0];
  return first ? { text: first[1], lang: first[0] } : null;
}

/** Routes in a sector matching a search ("5.10", "dièdre"), diacritics folded. */
export function filterRoutes(
  routes: readonly CragRoute[],
  query: string,
  fold: (s: string) => string,
): CragRoute[] {
  const q = fold(query.trim());
  if (q === '') return [...routes];
  return routes.filter((r) => fold(r.name).includes(q) || fold(r.g ?? '').startsWith(q));
}
