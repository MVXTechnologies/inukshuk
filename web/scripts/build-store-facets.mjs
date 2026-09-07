/**
 * Build the map-store filter mockup's facet fixture from the REAL catalogue.
 *
 *   node scripts/build-store-facets.mjs
 *
 * Reads `docs/catalog/v2/index.json` and every shard in `docs/catalog/v2/shards/`
 * (the same documents the phone fetches — 24 MB, 67 983 items) and writes
 * `src/store/facets.generated.json`, which is what the playground imports. The
 * playground never touches the network for this and never ships 24 MB: the
 * fixture is ~200 KB.
 *
 * Two things come out of the sweep.
 *
 * 1. A **facet cube** — one row per distinct
 *    `(source, region, language, distance bucket, size bucket)` combination with
 *    the number of sheets in it. Every count the sheet shows is a sum over this
 *    cube, so "1 : 50k · 214" is the true number of 1:50k sheets matching
 *    everything else that is selected, over all 67 983 items — not a sample.
 *    The bucket edges ARE the radius/size options offered in the UI, so the
 *    cumulative sums are exact rather than interpolated.
 *
 * 2. A **sample of real items** for the result list — the 400 sheets nearest
 *    Québec City plus the 6 nearest in every region, so no filter combination
 *    the chips can express lands on an empty list. The list is a sample; the
 *    header count is not, and the UI says so.
 *
 * Distances are measured once, here, from the playground's fixed Québec City
 * position (`HOME_VIEW` in `src/map/MapCanvas.tsx`) to the sheet's bbox — the
 * playground has no device GPS by design, and a fixed origin is what makes a
 * screenshot reproducible.
 *
 * ── The Canadian region gap ────────────────────────────────────────────────
 * `scripts/catalog/fetch-cantopo.ts` emits no `region` at all, so all 2 234
 * CanTopo sheets are region-less in the live catalogue (issue #250). A region
 * facet with a 2 234-item "?" bucket cannot be judged, so this generator
 * DERIVES `CA-<province>` from each sheet's bbox centroid with the coarse
 * boxes below, and marks every derived region `derived: true`. The UI badges
 * them "≈" and says why. This is mockup scaffolding — the fix belongs in the
 * fetcher, where the NTS index polygons are already loaded.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOG = join(HERE, '../../docs/catalog/v2');
const OUT = join(HERE, '../src/store/facets.generated.json');

/** The playground's fixed origin — `HOME_VIEW.center`, Québec City. */
const ORIGIN = { lat: 46.8139, lng: -71.2075 };

/**
 * Scale is not a catalogue field yet; it is a per-source constant (issue #250
 * phase 1 asks for it to be written into the fragments). Encoded here so the
 * mockup can show the badge the real build would carry.
 */
const SOURCE_META = {
  'usgs-ustopo': { country: 'US', scale: 24000, short: 'USGS US Topo' },
  'nrcan-cantopo': { country: 'CA', scale: 50000, short: 'NRCan CanTopo' },
  'ga-austopo': { country: 'AU', scale: 250000, short: 'GA AUSTopo' },
};

/** Radius options, in km. Also the distance bucket edges — see the header. */
const DIST_EDGES = [25, 50, 100, 250, 500, 1000, 2500, 5000, Infinity];
/** Download-size bucket edges, in bytes. Also the size options. */
const SIZE_EDGES = [10e6, 50e6, Infinity];

// ---------------------------------------------------------------- geometry --

function haversineKm(aLat, aLng, bLat, bLng) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Distance from the origin to the nearest point of a sheet's bbox (0 inside). */
function distanceToBboxKm(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return Infinity;
  const [w, s, e, n] = bbox;
  const lat = Math.min(Math.max(ORIGIN.lat, s), n);
  const lng = Math.min(Math.max(ORIGIN.lng, w), e);
  return haversineKm(ORIGIN.lat, ORIGIN.lng, lat, lng);
}

// ------------------------------------------------- derived CA-<province> ----

/**
 * Coarse province/territory boxes, tried in order — the specific and coastal
 * ones first so an overlap resolves to the smaller jurisdiction. Deliberately
 * crude: this is a stand-in for the fetcher fix, not a gazetteer.
 */
const CA_BOXES = [
  // Newfoundland (island) and Labrador (coastal strip + the north).
  ['CA-NL', -59.6, 46.5, -52.4, 52.0],
  ['CA-NL', -64.6, 53.4, -55.2, 60.5],
  ['CA-NL', -61.2, 51.2, -55.4, 53.5],
  ['CA-QC', -79.6, 44.9, -57.1, 62.7],
  ['CA-ON', -95.3, 41.5, -74.3, 57.0],
  ['CA-MB', -102.1, 48.9, -88.9, 60.1],
  ['CA-SK', -110.1, 48.9, -101.3, 60.1],
  ['CA-AB', -120.1, 48.9, -109.9, 60.1],
  ['CA-BC', -139.2, 47.9, -113.9, 60.1],
  ['CA-YT', -141.2, 59.9, -123.7, 69.8],
  ['CA-NT', -136.6, 59.9, -101.9, 70.2],
  ['CA-NT', -125.5, 70.0, -117.0, 75.0],
  ['CA-NU', -121.0, 59.9, -60.0, 84.0],
];

/**
 * The Ottawa River leg of the ON/QC border, which no rectangle can express and
 * which decides where Gatineau/Ottawa sheets land: QC is north of the line from
 * (-74.4, 45.5) to (-79.5, 46.3).
 */
function ottawaRiverLat(lng) {
  return 45.5 - (lng + 74.4) * (0.8 / 5.1);
}

/**
 * The Maritimes, where rectangles are hopeless: NB and NS interlock across the
 * Bay of Fundy and meet at the 20 km-wide Isthmus of Chignecto, and PEI is a
 * WNW–ESE sliver inside NB's bounding box. Plain boxes put Saint John, Minto
 * and Port Elgin in Nova Scotia, which is visibly wrong in the result list.
 *
 * So two diagonals are modelled instead — the Fundy/isthmus line through
 * (-64.95, 45.55) with slope 0.444, and PEI's south shore through
 * (-64.4, 46.45) with slope 0.229 — and east of the isthmus NS is everything
 * below 47.2°N as far as -59.0 (Cape Breton in, the Burin Peninsula out).
 *
 * It is still wrong for a sheet whose centroid lands on the isthmus itself
 * (Amherst), and it always will be: a 1:50k sheet is 0.25° ≈ 20 km, i.e. the
 * width of the border it is straddling. That is the argument for doing this in
 * the fetcher against the real NTS polygons rather than anywhere in a UI.
 */
function deriveMaritimes(lat, lng) {
  if (lat < 43.3 || lat > 48.2 || lng < -69.2 || lng > -59.0) return null;
  const peiShore = 46.45 - (lng + 64.4) * 0.229;
  if (lng > -64.45 && lng < -61.9 && lat > peiShore && lat < 47.2) return 'CA-PE';
  const fundy = 45.55 + (lng + 64.95) * 0.4444;
  if (lng > -67.5 && lng <= -63.2 && lat < fundy) return 'CA-NS';
  if (lng > -63.2 && lat < 47.2) return 'CA-NS';
  if (lng > -69.1 && lng < -63.6 && lat >= 44.5) return 'CA-NB';
  return null;
}

function deriveCaRegion(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return null;
  const [w, s, e, n] = bbox;
  const lat = (s + n) / 2;
  const lng = (w + e) / 2;
  const maritime = deriveMaritimes(lat, lng);
  if (maritime !== null) return maritime;
  for (const [code, bw, bs, be, bn] of CA_BOXES) {
    if (lng < bw || lng > be || lat < bs || lat > bn) continue;
    if (code === 'CA-QC' && lng >= -79.6 && lng <= -74.4 && lat < 46.4) {
      return lat > ottawaRiverLat(lng) ? 'CA-QC' : 'CA-ON';
    }
    return code;
  }
  return null;
}

// ------------------------------------------------------------------ names ---

const US_STATES = {
  AK: 'Alaska',
  AL: 'Alabama',
  AR: 'Arkansas',
  AS: 'American Samoa',
  AZ: 'Arizona',
  CA: 'California',
  CO: 'Colorado',
  CT: 'Connecticut',
  DC: 'District of Columbia',
  DE: 'Delaware',
  FL: 'Florida',
  GA: 'Georgia',
  GU: 'Guam',
  HI: 'Hawaii',
  IA: 'Iowa',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  MA: 'Massachusetts',
  MD: 'Maryland',
  ME: 'Maine',
  MI: 'Michigan',
  MN: 'Minnesota',
  MO: 'Missouri',
  MP: 'Northern Mariana Islands',
  MS: 'Mississippi',
  MT: 'Montana',
  NC: 'North Carolina',
  ND: 'North Dakota',
  NE: 'Nebraska',
  NH: 'New Hampshire',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NV: 'Nevada',
  NY: 'New York',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  PR: 'Puerto Rico',
  RI: 'Rhode Island',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VA: 'Virginia',
  VI: 'U.S. Virgin Islands',
  VT: 'Vermont',
  WA: 'Washington',
  WI: 'Wisconsin',
  WV: 'West Virginia',
  WY: 'Wyoming',
};

const CA_NAMES = {
  AB: 'Alberta',
  BC: 'British Columbia',
  MB: 'Manitoba',
  NB: 'New Brunswick',
  NL: 'Newfoundland and Labrador',
  NS: 'Nova Scotia',
  NT: 'Northwest Territories',
  NU: 'Nunavut',
  ON: 'Ontario',
  PE: 'Prince Edward Island',
  QC: 'Québec',
  SK: 'Saskatchewan',
  YT: 'Yukon',
};

const AU_NAMES = {
  ACT: 'Australian Capital Territory',
  NSW: 'New South Wales',
  NT: 'Northern Territory',
  QLD: 'Queensland',
  SA: 'South Australia',
  TAS: 'Tasmania',
  VIC: 'Victoria',
  WA: 'Western Australia',
};

function regionLabel(code) {
  const [country, sub] = code.split('-');
  if (country === 'US') return US_STATES[sub] ?? code;
  if (country === 'CA') return CA_NAMES[sub] ?? code;
  if (country === 'AU') return AU_NAMES[sub] ?? code;
  return code;
}

const COUNTRY_LABEL = { US: 'United States', CA: 'Canada', AU: 'Australia' };
const COUNTRY_FLAG = { US: '🇺🇸', CA: '🇨🇦', AU: '🇦🇺' };

// ------------------------------------------------------------------- main ---

function bucket(value, edges) {
  for (let i = 0; i < edges.length; i += 1) if (value < edges[i]) return i;
  return edges.length - 1;
}

const index = JSON.parse(readFileSync(join(CATALOG, 'index.json'), 'utf8'));
const sources = index.sources
  .map((s) => ({ ...s, ...(SOURCE_META[s.id] ?? { country: '??', scale: 0, short: s.name }) }))
  .sort((a, b) => a.country.localeCompare(b.country));
const sourceIdx = new Map(sources.map((s, i) => [s.id, i]));

const LANGS = ['en', 'fr', 'bilingual'];
const regionIds = [];
const regionIdx = new Map();
const regionDerived = new Set();

function regionKey(code) {
  if (code === null) return -1;
  let i = regionIdx.get(code);
  if (i === undefined) {
    i = regionIds.length;
    regionIds.push(code);
    regionIdx.set(code, i);
  }
  return i;
}

/** cellKey -> count, keyed `s|r|l|d|z`. */
const cells = new Map();
const sampled = [];
let total = 0;
let derivedCount = 0;
let unplaceable = 0;

const shardFiles = readdirSync(join(CATALOG, 'shards')).filter((f) => f.endsWith('.json'));
for (const file of shardFiles.sort()) {
  const shard = JSON.parse(readFileSync(join(CATALOG, 'shards', file), 'utf8'));
  for (const item of shard.items) {
    const meta = SOURCE_META[item.sourceId];
    if (meta === undefined) continue;
    total += 1;

    let region = item.region ?? null;
    let derived = false;
    if (region === null && meta.country === 'CA') {
      region = deriveCaRegion(item.bbox);
      derived = region !== null;
      if (derived) derivedCount += 1;
      else unplaceable += 1;
    }
    if (derived && region !== null) regionDerived.add(region);

    const s = sourceIdx.get(item.sourceId);
    const r = regionKey(region);
    const l = LANGS.indexOf(item.lang ?? 'en');
    const distKm = distanceToBboxKm(item.bbox);
    const d = bucket(distKm, DIST_EDGES);
    const z = bucket(item.sizeBytes ?? SIZE_EDGES[SIZE_EDGES.length - 1], SIZE_EDGES);

    const key = `${s}|${r}|${l < 0 ? 0 : l}|${d}|${z}`;
    cells.set(key, (cells.get(key) ?? 0) + 1);

    sampled.push({
      id: item.id,
      t: item.title,
      s,
      r,
      l: l < 0 ? 0 : l,
      d: Number.isFinite(distKm) ? Math.round(distKm * 10) / 10 : null,
      z: item.sizeBytes ?? null,
      u: item.updatedAt ?? null,
      b: item.bbox ?? null,
      url: item.url,
      x: derived ? 1 : 0,
    });
  }
}

// --- the item sample: nearest 400 overall, then the 6 nearest per region ----
sampled.sort((a, b) => (a.d ?? 1e9) - (b.d ?? 1e9));
const picked = new Map();
for (const it of sampled.slice(0, 400)) picked.set(it.id, it);
const perRegion = new Map();
for (const it of sampled) {
  const key = `${it.s}|${it.r}`;
  const n = perRegion.get(key) ?? 0;
  if (n >= 6) continue;
  perRegion.set(key, n + 1);
  picked.set(it.id, it);
}
const items = [...picked.values()].sort((a, b) => (a.d ?? 1e9) - (b.d ?? 1e9));

// ------------------------------------------------------------------ write ---

const regionCounts = new Map();
for (const [key, n] of cells) {
  const r = Number(key.split('|')[1]);
  regionCounts.set(r, (regionCounts.get(r) ?? 0) + n);
}

const regions = regionIds.map((code, i) => ({
  code,
  label: regionLabel(code),
  country: code.split('-')[0],
  count: regionCounts.get(i) ?? 0,
  derived: regionDerived.has(code),
}));

const countries = [...new Set(sources.map((s) => s.country))].map((c) => ({
  code: c,
  label: COUNTRY_LABEL[c] ?? c,
  flag: COUNTRY_FLAG[c] ?? '🏳️',
}));

const out = {
  $comment:
    'GENERATED by web/scripts/build-store-facets.mjs from docs/catalog/v2. Do not edit by hand.',
  generatedAt: new Date().toISOString(),
  catalogGeneratedAt: index.generatedAt,
  origin: ORIGIN,
  total,
  derivedCaRegions: derivedCount,
  unplaceable,
  distEdgesKm: DIST_EDGES.map((e) => (Number.isFinite(e) ? e : null)),
  sizeEdgesBytes: SIZE_EDGES.map((e) => (Number.isFinite(e) ? e : null)),
  langs: LANGS,
  countries,
  sources: sources.map((s) => ({
    id: s.id,
    name: s.name,
    short: s.short,
    country: s.country,
    scale: s.scale,
    licence: s.licence,
    attribution: s.attribution,
  })),
  regions,
  cells: [...cells.entries()]
    .map(([key, n]) => [...key.split('|').map(Number), n])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[3] - b[3]),
  items,
};

writeFileSync(OUT, `${JSON.stringify(out)}\n`);
console.log(
  `${total} items · ${cells.size} cells · ${regions.length} regions · ` +
    `${derivedCount} derived CA regions (${unplaceable} unplaceable) · ` +
    `${items.length} sampled items · ${(JSON.stringify(out).length / 1024).toFixed(0)} KB`,
);
