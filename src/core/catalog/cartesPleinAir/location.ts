import type { CatalogBbox, CatalogBboxPrecision } from '../schema';
import type { CpaRiver } from './listing';

/**
 * Where a Cartes Plein-air map is (#680).
 *
 * The maps are LibreOffice PDFs with no georeferencing, and the listing gives
 * no coordinates: only each section's river name and the administrative
 * regions it crosses. (The site's own river geometry sits under `/api`, which
 * its robots.txt disallows, so the crawler never asks for it.) So a map is
 * located in two steps, and says how well:
 *
 * 1. **River** (`precision: 'river'`): the river's official name looked up in
 *    the Canadian Geographical Names Database (NRCan, OGL-Canada 2.0), whose
 *    entries carry the whole feature's bbox. A match must have the same
 *    specific name and the same generic (rivière, ruisseau, lac…) and lie in
 *    the listed regions; two different features matching is ambiguity, and
 *    ambiguity is never guessed away.
 * 2. **Region** (`precision: 'region'`): otherwise, the union of the listed
 *    administrative regions.
 *
 * The lookups are cached in a reviewed gazetteer
 * (`scripts/catalog/sources/cartespleinair-rivers.json`), so each river is
 * looked up once, and a wrong match can be corrected by hand.
 */

/**
 * Québec's administrative regions, by the site's code (the official region
 * number). Bounds of each region's OSM boundary relation (admin_level 5),
 * read from Overpass on 2026-10-14, rounded outward to 0.01°.
 */
export const QC_REGION_BBOX: Record<string, CatalogBbox> = {
  'qc:01': [-70.21, 47.06, -65.94, 49.19], // Bas-Saint-Laurent (r8137316)
  'qc:02': [-74.45, 47.94, -69.87, 52.7], // Saguenay–Lac-Saint-Jean (r8120111)
  'qc:03': [-72.55, 46.57, -69.54, 48.19], // Capitale-Nationale (r8114679)
  'qc:04': [-75.53, 46.15, -71.89, 49.01], // Mauricie (r8098985)
  'qc:05': [-73.14, 45.0, -70.38, 45.96], // Estrie (r8098121)
  'qc:06': [-74.0, 45.39, -73.47, 45.71], // Montréal (r1571328)
  'qc:07': [-77.94, 45.37, -74.69, 47.85], // Outaouais (r8100164)
  'qc:08': [-79.59, 46.2, -75.52, 49.02], // Abitibi-Témiscamingue (r8107213)
  'qc:09': [-70.08, 48.05, -57.1, 55.01], // Côte-Nord (r8126390)
  'qc:10': [-79.77, 48.92, -63.31, 62.59], // Nord-du-Québec (r8118159)
  'qc:11': [-67.67, 46.83, -60.4, 49.72], // Gaspésie–Îles-de-la-Madeleine (r7485821)
  'qc:12': [-72.06, 45.76, -69.62, 47.42], // Chaudière-Appalaches (r8138409)
  'qc:13': [-73.9, 45.51, -73.52, 45.71], // Laval (r3532125)
  'qc:14': [-74.9, 45.66, -72.95, 47.77], // Lanaudière (r8098959)
  'qc:15': [-76.15, 45.44, -73.73, 47.77], // Laurentides (r8098885)
  'qc:16': [-74.67, 44.99, -72.31, 46.12], // Montérégie (r8093332)
  'qc:17': [-72.99, 45.58, -71.37, 46.58], // Centre-du-Québec (r8100165)
};

/** Neighbouring provinces some routes cross (OSM admin_level 4 bounds, 2026-10-14). */
export const PROVINCE_BBOX: Record<string, CatalogBbox> = {
  'ca:qc': [-79.77, 44.99, -57.1, 62.59], // r61549
  'ca:on': [-95.16, 41.67, -74.32, 56.87], // r68841
  'ca:nb': [-69.06, 44.28, -63.32, 48.23], // r68942
  'ca:nl': [-67.83, 46.41, -52.32, 60.48], // r391196
};

/** CGNDB province codes (the `province=` query parameter). */
const GEONAMES_PROVINCE: Record<string, string> = {
  'ca:qc': '24',
  'ca:on': '35',
  'ca:nb': '13',
  'ca:nl': '10',
};

/** ISO 3166-2 code of the first region, for the catalog's `region` field. */
export function isoRegion(regions: readonly string[]): string | undefined {
  const first = regions[0];
  if (first === undefined) return undefined;
  if (first.startsWith('qc:')) return 'CA-QC';
  return first.startsWith('ca:') ? `CA-${first.slice(3).toUpperCase()}` : undefined;
}

export function unionBbox(boxes: readonly CatalogBbox[]): CatalogBbox | null {
  if (boxes.length === 0) return null;
  let [w, s, e, n] = boxes[0] as CatalogBbox;
  for (const [bw, bs, be, bn] of boxes) {
    w = Math.min(w, bw);
    s = Math.min(s, bs);
    e = Math.max(e, be);
    n = Math.max(n, bn);
  }
  return [w, s, e, n];
}

/**
 * The area the listed regions cover: the union of the Québec regions, or of
 * the provinces when only provinces are listed (a route wholly in Ontario).
 * A province listed beside Québec regions adds nothing: the route touches it,
 * but the whole of Ontario says less than the Québec regions do.
 */
export function regionsBbox(regions: readonly string[]): CatalogBbox | null {
  const qc = regions.flatMap((r) => (QC_REGION_BBOX[r] !== undefined ? [QC_REGION_BBOX[r]] : []));
  if (qc.length > 0) return unionBbox(qc);
  return unionBbox(
    regions.flatMap((r) => (PROVINCE_BBOX[r] !== undefined ? [PROVINCE_BBOX[r]] : [])),
  );
}

/* ---------------------------------------------------------------- names --- */

/** Generic terms a hydronym starts with, normalised (CGNDB generics). */
const GENERICS = [
  'riviere',
  'river',
  'ruisseau',
  'fleuve',
  'lac',
  'reservoir',
  'chenal',
  'bras',
  'branche',
  'canal',
  'decharge',
] as const;
type Generic = (typeof GENERICS)[number] | 'none';

/** Parenthesised generics the site uses as hints: "Bryson (ruisseau)". */
const HINT_GENERICS: ReadonlySet<string> = new Set(GENERICS);

/** Linking particles between a generic and the specific name. */
const PARTICLES = ['de la', 'de l', 'des', 'du', 'de', 'd', 'aux', 'au', 'a la', 'a l', 'a'];

/** Lower case, no accents, apostrophes and hyphens as spaces, single spaces. */
export function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’'`‐-―-]/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripParticle(text: string): string {
  for (const p of PARTICLES) {
    if (text.startsWith(`${p} `)) return text.slice(p.length + 1);
  }
  return text;
}

/** A hydronym split into its generic and its specific name ("rivière du Nord" → riviere / "nord"). */
export function splitHydronym(name: string): { generic: Generic; specific: string } {
  let text = normalizeName(name);
  let generic: Generic = 'none';
  for (const g of GENERICS) {
    if (text === g) return { generic: g, specific: '' };
    if (text.startsWith(`${g} `)) {
      generic = g;
      text = text.slice(g.length + 1);
      break;
    }
  }
  if (generic === 'none' && text.endsWith(' river')) {
    generic = 'river';
    text = text.slice(0, -' river'.length);
  }
  return { generic, specific: stripParticle(text) };
}

/** English "river" and French "rivière" are the same generic. */
function sameGeneric(a: Generic, b: Generic): boolean {
  const norm = (g: Generic) => (g === 'river' ? 'riviere' : g);
  return norm(a) === norm(b);
}

/**
 * How the site's river name reads as an official name: "Du Nord (Dumoine)" →
 * generic rivière (implied), specific "nord"; "Bryson (ruisseau)" → ruisseau
 * "bryson". Parenthesised disambiguators other than a generic are dropped.
 * Null when nothing nameable is left ("(sans nom) (René-Lévesque)").
 */
export function siteRiverName(
  name: string,
): { query: string; generic: Generic; specific: string } | null {
  const hints = [...name.matchAll(/\(([^)]*)\)/g)]
    .map((m) => normalizeName(m[1] ?? ''))
    .filter((word) => HINT_GENERICS.has(word)) as Generic[];
  const hint = hints[0];
  const bare = name
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (bare === '') return null;
  const split = splitHydronym(bare);
  if (split.specific === '') return null;
  // No generic written and no hint: 'none', read as "a watercourse" (the site
  // lists rivers, so "Désert" is Rivière Désert and "Bullard" Ruisseau Bullard).
  const generic = split.generic !== 'none' ? split.generic : (hint ?? 'none');
  return { query: bare, generic, specific: split.specific };
}

/** Generics an unqualified site name ("Désert") can stand for. */
const WATERCOURSE: ReadonlySet<Generic> = new Set<Generic>([
  'riviere',
  'river',
  'ruisseau',
  'none',
]);

/** Does an official name's generic fit what the site wrote? */
function genericFits(official: Generic, wanted: Generic): boolean {
  if (wanted === 'none') return WATERCOURSE.has(official);
  return sameGeneric(official, wanted);
}

/* ------------------------------------------------------------- geonames --- */

/** One CGNDB answer row (the fields we read). */
export interface GeonameCandidate {
  /** Feature id: two names of one feature are one place. */
  featureId: string;
  name: string;
  /** "official", "previouslyOfficial", … */
  status?: string;
  /** Feature type: RIV, LAKE, CHAN, CITY… */
  concise?: string;
  latitude: number;
  longitude: number;
  bbox?: CatalogBbox;
}

/** Parse a CGNDB `geonames.json` answer. Never throws; malformed rows are skipped. */
export function parseGeonames(raw: unknown): GeonameCandidate[] {
  const items =
    typeof raw === 'object' && raw !== null && Array.isArray((raw as { items?: unknown }).items)
      ? (raw as { items: unknown[] }).items
      : [];
  const out: GeonameCandidate[] = [];
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue;
    const r = item as Record<string, unknown>;
    const feature = r.feature as Record<string, unknown> | undefined;
    const featureId =
      typeof feature?.id === 'string' ? feature.id : typeof r.id === 'string' ? r.id : null;
    if (featureId === null || typeof r.name !== 'string') continue;
    if (typeof r.latitude !== 'number' || typeof r.longitude !== 'number') continue;
    const status = (r.status as Record<string, unknown> | undefined)?.code;
    const concise = (r.concise as Record<string, unknown> | undefined)?.code;
    const b = r.bbox;
    const bbox =
      Array.isArray(b) &&
      b.length === 4 &&
      b.every((n) => typeof n === 'number' && Number.isFinite(n)) &&
      (b[0] as number) < (b[2] as number) &&
      (b[1] as number) < (b[3] as number)
        ? (b as CatalogBbox)
        : undefined;
    out.push({
      featureId,
      name: r.name,
      ...(typeof status === 'string' ? { status } : {}),
      ...(typeof concise === 'string' ? { concise } : {}),
      latitude: r.latitude,
      longitude: r.longitude,
      ...(bbox !== undefined ? { bbox } : {}),
    });
  }
  return out;
}

/** CGNDB concise type for a generic: watercourses are RIV, lakes and reservoirs LAKE. */
function conciseFor(generic: Generic): string | undefined {
  if (generic === 'lac' || generic === 'reservoir') return 'LAKE';
  if (generic === 'chenal' || generic === 'canal') return undefined;
  return 'RIV';
}

/** Feature types a canoe route can be named after. */
const HYDRO_CONCISE: ReadonlySet<string> = new Set(['RIV', 'LAKE', 'CHAN']);

/** Rows asked of CGNDB per lookup: common names ("Noire") have dozens. */
const GEONAMES_ROWS = 100;

/**
 * The CGNDB query for a river: its bare name, restricted to the province of
 * its regions and to the feature type its generic implies (so "Rimouski"
 * returns the river, not the city).
 */
export function geonamesQueryUrl(river: CpaRiver): string | null {
  const name = siteRiverName(river.name);
  if (name === null) return null;
  const province = river.regions.some((r) => r.startsWith('qc:'))
    ? 'ca:qc'
    : (river.regions.find((r) => GEONAMES_PROVINCE[r] !== undefined) ?? 'ca:qc');
  const concise = conciseFor(name.generic);
  const params = [
    `q=${encodeURIComponent(name.query)}`,
    `province=${GEONAMES_PROVINCE[province] ?? '24'}`,
    ...(concise !== undefined ? [`concise=${concise}`] : []),
    `num=${GEONAMES_ROWS}`,
  ].join('&');
  return `https://geogratis.gc.ca/services/geoname/en/geonames.json?${params}`;
}

/** Degrees a candidate's point may sit outside the listed regions (border rivers). */
const REGION_SLACK_DEG = 0.1;

/** Smallest box a point-only feature is given (≈ 2 km each way). */
const POINT_HALF_SPAN_DEG = 0.02;

export interface RiverLocation {
  bbox: CatalogBbox;
  precision: CatalogBboxPrecision;
  /** Why we believe it, for reviewers ("CGNDB EGNTM 'Rivière Désert'", "regions qc:07"). */
  evidence: string;
}

function inside([w, s, e, n]: CatalogBbox, lat: number, lon: number, slack: number): boolean {
  return lon >= w - slack && lon <= e + slack && lat >= s - slack && lat <= n + slack;
}

/**
 * Pick the one official feature a river name means, or null.
 *
 * Same specific name and same generic (a site name with no generic means a
 * watercourse), a hydrographic feature type, point inside the listed regions.
 * Several features left → a rivière beats a ruisseau for an unqualified name,
 * then keep the `official` ones; still several → ambiguous, null.
 */
export function matchGeoname(
  river: CpaRiver,
  candidates: readonly GeonameCandidate[],
): RiverLocation | null {
  const wanted = siteRiverName(river.name);
  const area = regionsBbox(river.regions);
  if (wanted === null || area === null) return null;
  const matching = candidates.filter((c) => {
    if (c.concise !== undefined && !HYDRO_CONCISE.has(c.concise)) return false;
    const split = splitHydronym(c.name);
    return (
      split.specific === wanted.specific &&
      genericFits(split.generic, wanted.generic) &&
      inside(area, c.latitude, c.longitude, REGION_SLACK_DEG)
    );
  });
  const features = new Map<string, GeonameCandidate>();
  for (const c of matching) {
    const seen = features.get(c.featureId);
    if (seen === undefined || (seen.status !== 'official' && c.status === 'official')) {
      features.set(c.featureId, c);
    }
  }
  let pool = [...features.values()];
  // An unqualified name means the rivière before the ruisseau of the same name.
  if (pool.length > 1 && wanted.generic === 'none') {
    const rivers = pool.filter((c) => sameGeneric(splitHydronym(c.name).generic, 'riviere'));
    if (rivers.length > 0) pool = rivers;
  }
  if (pool.length > 1) pool = pool.filter((c) => c.status === 'official');
  if (pool.length !== 1) return null;
  const hit = pool[0] as GeonameCandidate;
  const bbox: CatalogBbox = hit.bbox ?? [
    hit.longitude - POINT_HALF_SPAN_DEG,
    hit.latitude - POINT_HALF_SPAN_DEG,
    hit.longitude + POINT_HALF_SPAN_DEG,
    hit.latitude + POINT_HALF_SPAN_DEG,
  ];
  return {
    bbox: roundBbox(bbox),
    precision: 'river',
    evidence: `CGNDB feature ${hit.featureId} "${hit.name}"${hit.bbox === undefined ? ' (point only)' : ''}`,
  };
}

/** The region fallback for a river, or null when its regions are unknown codes. */
export function regionLocation(regions: readonly string[]): RiverLocation | null {
  const bbox = regionsBbox(regions);
  return bbox === null
    ? null
    : { bbox, precision: 'region', evidence: `administrative regions ${regions.join(', ')}` };
}

/** Outward to 4 decimals (≈ 10 m): stable diffs, never a box that shrank. */
export function roundBbox([w, s, e, n]: CatalogBbox): CatalogBbox {
  // `toFixed(6)` first: 47.9 − 0.02 is 47.879999…, which must not floor to 47.8799.
  const scaled = (v: number) => Number((v * 1e4).toFixed(6));
  const down = (v: number) => Math.floor(scaled(v)) / 1e4;
  const up = (v: number) => Math.ceil(scaled(v)) / 1e4;
  return [down(w), down(s), up(e), up(n)];
}

/**
 * A map's location from its rivers': the union of the rivers located by name
 * (precision `river`), else the union of the map's regions (`region`).
 */
export function mapLocation(
  rivers: readonly (RiverLocation | null)[],
  regions: readonly string[],
): RiverLocation | null {
  const located = rivers.filter((r): r is RiverLocation => r !== null && r.precision === 'river');
  if (located.length > 0) {
    return {
      bbox: unionBbox(located.map((r) => r.bbox)) as CatalogBbox,
      precision: 'river',
      evidence: located.map((r) => r.evidence).join('; '),
    };
  }
  return regionLocation(regions);
}
