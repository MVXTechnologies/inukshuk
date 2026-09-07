/**
 * The map store's facet model — the data half of `StoreFilterSheet`.
 *
 * Everything here is derived from the REAL catalogue: `docs/catalog/v2` is
 * swept once by `scripts/build-store-facets.mjs` into `facets.generated.json`,
 * which holds a facet cube (one row per distinct source × region × language ×
 * distance bucket × size bucket, with its count) plus a sample of real sheets
 * for the list. 67 983 items collapse to ~200 cube rows, so every count in the
 * UI is an exact sum over the whole catalogue computed synchronously in the
 * browser, with no network and no 24 MB download.
 *
 * The counting rule is the one faceted search has to obey to be usable: within
 * a group the options are OR'd, across groups they are AND'd, and the number
 * beside an option is what you would get if you tapped it — i.e. it ignores its
 * OWN group's current selection. That is what makes it impossible to tap your
 * way into an empty list, which matters here because the catalogue is very
 * unevenly filled (nothing at all within 25 km of Québec City; 11 177 sheets in
 * Alaska).
 */
import rawFacets from './facets.generated.json';

// --------------------------------------------------------------- the file --

interface RawFacets {
  generatedAt: string;
  catalogGeneratedAt: string;
  origin: { lat: number; lng: number };
  total: number;
  derivedCaRegions: number;
  unplaceable: number;
  /** Upper edge (km) of each distance bucket; the last is `null` = unbounded. */
  distEdgesKm: (number | null)[];
  sizeEdgesBytes: (number | null)[];
  langs: string[];
  countries: { code: string; label: string; flag: string }[];
  sources: {
    id: string;
    name: string;
    short: string;
    country: string;
    /** Denominator of the map scale, e.g. 24000 for 1:24 000. */
    scale: number;
    licence: string;
    attribution: string;
  }[];
  regions: {
    code: string;
    label: string;
    country: string;
    count: number;
    /** True when the region was DERIVED here because the fetcher emits none. */
    derived: boolean;
  }[];
  /** `[sourceIdx, regionIdx (-1 = none), langIdx, distBucket, sizeBucket, n]`. */
  cells: number[][];
  items: {
    id: string;
    t: string;
    s: number;
    r: number;
    l: number;
    d: number | null;
    z: number | null;
    u: string | null;
    b: number[] | null;
    url: string;
    x: number;
  }[];
}

const F = rawFacets as unknown as RawFacets;

export interface FacetCell {
  source: number;
  region: number;
  lang: number;
  dist: number;
  size: number;
  n: number;
}

export interface StoreSheet {
  id: string;
  title: string;
  sourceIndex: number;
  regionIndex: number;
  langIndex: number;
  /** Kilometres from the fixed origin to the nearest edge of the sheet. */
  distanceKm: number | null;
  sizeBytes: number | null;
  updatedAt: string | null;
  bbox: [number, number, number, number] | null;
  url: string;
  /** The region was derived by the fixture generator, not published. */
  regionDerived: boolean;
}

const CELLS: FacetCell[] = F.cells.map((c) => ({
  source: c[0] ?? 0,
  region: c[1] ?? -1,
  lang: c[2] ?? 0,
  dist: c[3] ?? 0,
  size: c[4] ?? 0,
  n: c[5] ?? 0,
}));

const SHEETS: StoreSheet[] = F.items.map((i) => ({
  id: i.id,
  title: i.t,
  sourceIndex: i.s,
  regionIndex: i.r,
  langIndex: i.l,
  distanceKm: i.d,
  sizeBytes: i.z,
  updatedAt: i.u,
  bbox:
    i.b === null || i.b.length !== 4 ? null : [i.b[0] ?? 0, i.b[1] ?? 0, i.b[2] ?? 0, i.b[3] ?? 0],
  url: i.url,
  regionDerived: i.x === 1,
}));

export const CATALOG = {
  total: F.total,
  generatedAt: F.catalogGeneratedAt,
  origin: F.origin,
  derivedCaRegions: F.derivedCaRegions,
  unplaceable: F.unplaceable,
  sampleSize: SHEETS.length,
  langs: F.langs,
  countries: F.countries,
  sources: F.sources,
  regions: F.regions,
  distEdgesKm: F.distEdgesKm,
  sizeEdgesBytes: F.sizeEdgesBytes,
  sheets: SHEETS,
  cells: CELLS,
};

/** Scales present in the catalogue, coarsest first. */
export const SCALES: { scale: number; label: string; sourceIds: string[] }[] = [
  ...new Set(F.sources.map((s) => s.scale)),
]
  .sort((a, b) => a - b)
  .map((scale) => ({
    scale,
    label: `1 : ${scale.toLocaleString('en-US').replace(/,/g, ' ')}`,
    sourceIds: F.sources.filter((s) => s.scale === scale).map((s) => s.id),
  }));

/** Languages that actually occur, in the order the fixture lists them. */
export const LANGS_PRESENT: string[] = F.langs.filter((_, i) =>
  CELLS.some((c) => c.lang === i && c.n > 0),
);

export const LANG_LABEL: Record<string, string> = {
  en: 'English',
  fr: 'Français',
  bilingual: 'Bilingual',
};

/**
 * The radius chips. Every value is a distance-bucket EDGE in the fixture, so
 * "within 500 km" is an exact sum and not an interpolation.
 */
export const RADII: { km: number; bucket: number }[] = [25, 100, 500, 2500]
  .map((km) => ({ km, bucket: F.distEdgesKm.indexOf(km) }))
  .filter((r) => r.bucket >= 0);

/** The size chips, likewise on bucket edges. */
export const SIZE_LIMITS: { bytes: number; bucket: number }[] = [10e6, 50e6]
  .map((bytes) => ({ bytes, bucket: F.sizeEdgesBytes.indexOf(bytes) }))
  .filter((s) => s.bucket >= 0);

// -------------------------------------------------------------- the filter --

export interface StoreFilter {
  /** ISO country codes; empty = every country. */
  countries: string[];
  /** ISO 3166-2 region codes; empty = every region. */
  regions: string[];
  /** Scale denominators; empty = every scale. */
  scales: number[];
  /** Language codes; empty = every language. */
  langs: string[];
  /** Inclusive upper distance bucket, or null for "anywhere". */
  maxDist: number | null;
  /** Inclusive upper size bucket, or null for "any size". */
  maxSize: number | null;
  /** Free text — matched against the sampled sheets only (see the panel). */
  query: string;
}

export const EMPTY_FILTER: StoreFilter = {
  countries: [],
  regions: [],
  scales: [],
  langs: [],
  maxDist: null,
  maxSize: null,
  query: '',
};

/** Which facet groups are narrowing the catalogue. Drives the badge + footer. */
export function activeGroups(f: StoreFilter): number {
  return (
    (f.countries.length > 0 ? 1 : 0) +
    (f.regions.length > 0 ? 1 : 0) +
    (f.scales.length > 0 ? 1 : 0) +
    (f.langs.length > 0 ? 1 : 0) +
    (f.maxDist === null ? 0 : 1) +
    (f.maxSize === null ? 0 : 1)
  );
}

export type FacetGroup = 'country' | 'region' | 'scale' | 'lang' | 'dist' | 'size';

/**
 * Does one cube row survive the filter, ignoring one group?
 *
 * `except` is what makes the per-option counts read as "tap this and you get
 * N": while counting a group's own options, that group's current selection is
 * lifted, so the numbers inside a group are alternatives to each other rather
 * than a description of what is already chosen.
 */
function cellMatches(cell: FacetCell, f: StoreFilter, except?: FacetGroup): boolean {
  const source = F.sources[cell.source];
  if (source === undefined) return false;
  const region = cell.region < 0 ? null : F.regions[cell.region];

  if (except !== 'country' && f.countries.length > 0 && !f.countries.includes(source.country)) {
    return false;
  }
  if (
    except !== 'region' &&
    f.regions.length > 0 &&
    (region === undefined || region === null || !f.regions.includes(region.code))
  ) {
    return false;
  }
  if (except !== 'scale' && f.scales.length > 0 && !f.scales.includes(source.scale)) return false;
  if (except !== 'lang' && f.langs.length > 0) {
    const lang = F.langs[cell.lang];
    if (lang === undefined || !f.langs.includes(lang)) return false;
  }
  if (except !== 'dist' && f.maxDist !== null && cell.dist > f.maxDist) return false;
  if (except !== 'size' && f.maxSize !== null && cell.size > f.maxSize) return false;
  return true;
}

/** Sheets in the whole catalogue matching the filter. Exact, not a sample. */
export function countMatching(f: StoreFilter): number {
  let n = 0;
  for (const cell of CELLS) if (cellMatches(cell, f)) n += cell.n;
  return n;
}

/**
 * All the per-option counts the sheet needs, in one pass over ~200 rows.
 *
 * One pass rather than one per chip: with 67 regions on screen the naive
 * version is 70-odd sweeps per keystroke, and the whole point of the cube is
 * that a count is cheap enough to put on every option without thinking about it.
 */
export interface FacetCounts {
  country: Map<string, number>;
  region: Map<string, number>;
  scale: Map<number, number>;
  lang: Map<string, number>;
  /** Cumulative: `dist[i]` = sheets in bucket 0…i. */
  dist: number[];
  size: number[];
  total: number;
}

export function facetCounts(f: StoreFilter): FacetCounts {
  const country = new Map<string, number>();
  const region = new Map<string, number>();
  const scale = new Map<number, number>();
  const lang = new Map<string, number>();
  const dist = new Array<number>(F.distEdgesKm.length).fill(0);
  const size = new Array<number>(F.sizeEdgesBytes.length).fill(0);

  for (const cell of CELLS) {
    const source = F.sources[cell.source];
    if (source === undefined) continue;
    const regionCode = cell.region < 0 ? null : (F.regions[cell.region]?.code ?? null);
    const langCode = F.langs[cell.lang] ?? 'en';

    if (cellMatches(cell, f, 'country')) {
      country.set(source.country, (country.get(source.country) ?? 0) + cell.n);
    }
    if (cellMatches(cell, f, 'region') && regionCode !== null) {
      region.set(regionCode, (region.get(regionCode) ?? 0) + cell.n);
    }
    if (cellMatches(cell, f, 'scale')) {
      scale.set(source.scale, (scale.get(source.scale) ?? 0) + cell.n);
    }
    if (cellMatches(cell, f, 'lang')) {
      lang.set(langCode, (lang.get(langCode) ?? 0) + cell.n);
    }
    // Distance and size are single-select upper bounds, so their option counts
    // are cumulative: "within 500 km" includes everything nearer.
    if (cellMatches(cell, f, 'dist')) {
      for (let i = cell.dist; i < dist.length; i += 1) dist[i] = (dist[i] ?? 0) + cell.n;
    }
    if (cellMatches(cell, f, 'size')) {
      for (let i = cell.size; i < size.length; i += 1) size[i] = (size[i] ?? 0) + cell.n;
    }
  }

  return { country, region, scale, lang, dist, size, total: countMatching(f) };
}

/**
 * The distance histogram drawn above the radius chips.
 *
 * Per-bucket (not cumulative) counts under everything EXCEPT the radius, which
 * is what lets the strip show where the catalogue actually is while you move
 * the radius across it.
 */
export function distanceHistogram(f: StoreFilter): number[] {
  const bars = new Array<number>(F.distEdgesKm.length).fill(0);
  for (const cell of CELLS) {
    if (!cellMatches(cell, f, 'dist')) continue;
    bars[cell.dist] = (bars[cell.dist] ?? 0) + cell.n;
  }
  return bars;
}

// --------------------------------------------------------------- the list --

function sheetMatches(sheet: StoreSheet, f: StoreFilter): boolean {
  const source = F.sources[sheet.sourceIndex];
  if (source === undefined) return false;
  const region = sheet.regionIndex < 0 ? null : F.regions[sheet.regionIndex];

  if (f.countries.length > 0 && !f.countries.includes(source.country)) return false;
  if (f.regions.length > 0 && (region == null || !f.regions.includes(region.code))) return false;
  if (f.scales.length > 0 && !f.scales.includes(source.scale)) return false;
  if (f.langs.length > 0) {
    const lang = F.langs[sheet.langIndex];
    if (lang === undefined || !f.langs.includes(lang)) return false;
  }
  if (f.maxDist !== null) {
    const edge = F.distEdgesKm[f.maxDist];
    if (edge !== null && edge !== undefined && (sheet.distanceKm ?? Infinity) >= edge) return false;
  }
  if (f.maxSize !== null) {
    const edge = F.sizeEdgesBytes[f.maxSize];
    if (edge !== null && edge !== undefined && (sheet.sizeBytes ?? Infinity) >= edge) return false;
  }
  const q = f.query.trim().toLowerCase();
  if (q !== '' && !sheet.title.toLowerCase().includes(q)) return false;
  return true;
}

/** The visible rows: real sheets from the fixture sample, nearest first. */
export function matchingSheets(f: StoreFilter): StoreSheet[] {
  return SHEETS.filter((s) => sheetMatches(s, f));
}

// ---------------------------------------------------------------- the URL --

/**
 * `?near=500&country=CA&scale=50000` → a {@link StoreFilter}, and back.
 *
 * The URL speaks the UI's units (km, MB, ISO codes) rather than the fixture's
 * bucket indices: a capture link has to survive a regenerated fixture whose
 * bucket edges have moved, and it has to be legible in a bug report.
 */
export function filterFromUrl(u: {
  countries: string[];
  regions: string[];
  scales: number[];
  langs: string[];
  near: number | null;
  maxSizeMb: number | null;
  query: string;
}): StoreFilter {
  const radius = u.near === null ? undefined : RADII.find((r) => r.km === u.near);
  const size =
    u.maxSizeMb === null
      ? undefined
      : SIZE_LIMITS.find((s) => Math.round(s.bytes / 1e6) === Math.round(u.maxSizeMb ?? 0));
  return {
    countries: u.countries.filter((c) => CATALOG.countries.some((x) => x.code === c)),
    regions: u.regions.filter((r) => CATALOG.regions.some((x) => x.code === r)),
    scales: u.scales.filter((s) => SCALES.some((x) => x.scale === s)),
    langs: u.langs.filter((l) => CATALOG.langs.includes(l)),
    maxDist: radius?.bucket ?? null,
    maxSize: size?.bucket ?? null,
    query: u.query,
  };
}

/** The inverse, as a `syncUrl` patch (null removes the parameter). */
export function filterToUrlPatch(
  f: StoreFilter,
  sheetOpen: boolean,
): Record<string, string | null> {
  const km = f.maxDist === null ? null : (RADII.find((r) => r.bucket === f.maxDist)?.km ?? null);
  const mb =
    f.maxSize === null ? null : (SIZE_LIMITS.find((s) => s.bucket === f.maxSize)?.bytes ?? null);
  return {
    country: f.countries.length === 0 ? null : f.countries.join(','),
    region: f.regions.length === 0 ? null : f.regions.join(','),
    scale: f.scales.length === 0 ? null : f.scales.join(','),
    lang: f.langs.length === 0 ? null : f.langs.join(','),
    near: km === null ? null : String(km),
    maxsize: mb === null ? null : String(Math.round(mb / 1e6)),
    q: f.query.trim() === '' ? null : f.query,
    sheet: sheetOpen ? '1' : null,
  };
}

// ------------------------------------------------------------- formatting --

export function formatCount(n: number): string {
  return n.toLocaleString('en-US').replace(/,/g, ' ');
}

export function formatKm(km: number | null): string {
  if (km === null) return '—';
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${formatCount(Math.round(km))} km`;
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  return bytes < 1_048_576
    ? `${Math.round(bytes / 1024)} KB`
    : `${(bytes / 1_048_576).toFixed(bytes < 10 * 1_048_576 ? 1 : 0)} MB`;
}

export function scaleLabel(scale: number): string {
  return `1 : ${scale.toLocaleString('en-US').replace(/,/g, ' ')}`;
}

export function sourceOf(sheet: StoreSheet) {
  return F.sources[sheet.sourceIndex];
}

export function regionOf(sheet: StoreSheet) {
  return sheet.regionIndex < 0 ? undefined : F.regions[sheet.regionIndex];
}

export function countryOf(code: string) {
  return F.countries.find((c) => c.code === code);
}

export function regionByCode(code: string) {
  return F.regions.find((r) => r.code === code);
}
