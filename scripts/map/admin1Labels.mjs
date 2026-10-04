/**
 * Worldwide province / state label points for the stone base map, built
 * from Natural Earth's 1:10m admin-1 layer (public domain).
 *
 * Why: the Protomaps tiles only carry `kind: region` points for a handful of
 * countries (the US, Canada, Australia, Brazil at z4–7); France, Switzerland,
 * Italy, Germany and most of the world have none, so the map named no
 * province outside North America. The style draws these points INSTEAD of
 * Protomaps' regions everywhere (one source, one ranking — no doubles).
 *
 * PURE: this module only transforms data; `build-admin1-labels.mjs` does
 * the fetching and writing. Tested by `admin1Labels.test.mjs`.
 *
 * Each output point carries:
 * - `name` (Natural Earth's local-ish name), `name:fr` and `name:en` only
 *   where they differ — the same keys the style's name expression reads;
 * - `r`: the zoom from which the label is due. Natural Earth's own
 *   `min_zoom` is too shy for a hiking map (every French département only
 *   from z8, Swiss cantons from z8.7), so the rank comes from SIZE instead:
 *   the zoom at which the area's width spans {@link LABEL_SPAN_PX} pixels.
 *   Big provinces arrive early, small ones late, collisions sort the rest;
 * - `u` (regions only): the zoom from which the label is hidden again.
 *
 * Where Natural Earth's admin-1 is a SECOND level — French départements,
 * Italian provinces, Spanish provinces — their régions / regioni /
 * comunidades are what a zoomed-out reader looks for. Those are built here
 * by grouping on Natural Earth's `region` field: one point per region at
 * its members' area-weighted centre, shown below {@link REGION_UNTIL}, and
 * the members held back to {@link REGION_UNTIL} so the two levels never
 * share the screen.
 */

/** Mean Earth radius (km), for polygon areas. */
const EARTH_RADIUS_KM = 6371.0088;
/** Equator length (km) and the canonical tile size MapLibre's zoom is defined on. */
const EQUATOR_KM = 40075.016686;
const TILE_PX = 512;

/** How wide (px) a province must be on screen before its name is due. */
export const LABEL_SPAN_PX = 90;
/** Earliest and latest due zoom kept. The style draws provinces z4–8. */
export const MIN_RANK = 3;
export const MAX_RANK = 8;
/** Coordinates are rounded to this many decimals (~1 km — a label point). */
export const COORD_DECIMALS = 2;

/** Countries whose admin-1 is a second level, grouped into regions by `region`. */
export const REGION_COUNTRIES = new Set(['FR', 'IT', 'ES']);
/** Regions are hidden, and their members shown, from this zoom. */
export const REGION_UNTIL = 7;

/**
 * Region names where Natural Earth's `region` is not the local name, or the
 * French or English one differs. Keyed by Natural Earth's spelling.
 */
export const REGION_NAMES = {
  // France — French names are the local ones.
  Bretagne: { en: 'Brittany' },
  Normandie: { en: 'Normandy' },
  Corse: { en: 'Corsica' },
  "Provence-Alpes-Côte-d'Azur": { name: "Provence-Alpes-Côte d'Azur" },
  // Italy
  Lombardia: { fr: 'Lombardie', en: 'Lombardy' },
  Toscana: { fr: 'Toscane', en: 'Tuscany' },
  'Emilia-Romagna': { fr: 'Émilie-Romagne' },
  Sicily: { name: 'Sicilia', fr: 'Sicile', en: 'Sicily' },
  Piemonte: { fr: 'Piémont', en: 'Piedmont' },
  Sardegna: { fr: 'Sardaigne', en: 'Sardinia' },
  Veneto: { fr: 'Vénétie' },
  Apulia: { name: 'Puglia', fr: 'Pouilles', en: 'Apulia' },
  Marche: { fr: 'Marches' },
  Calabria: { fr: 'Calabre' },
  Campania: { fr: 'Campanie' },
  Lazio: { fr: 'Latium' },
  Liguria: { fr: 'Ligurie' },
  'Friuli-Venezia Giulia': { fr: 'Frioul-Vénétie julienne' },
  Abruzzo: { fr: 'Abruzzes' },
  'Trentino-Alto Adige': { fr: 'Trentin-Haut-Adige', en: 'Trentino-South Tyrol' },
  Basilicata: { fr: 'Basilicate' },
  Umbria: { fr: 'Ombrie' },
  // Spain
  'Castilla y León': { fr: 'Castille-et-León', en: 'Castile and León' },
  Andalucía: { fr: 'Andalousie', en: 'Andalusia' },
  'Castilla-La Mancha': { fr: 'Castille-La Manche' },
  Cataluña: { name: 'Catalunya', fr: 'Catalogne', en: 'Catalonia' },
  Galicia: { fr: 'Galice' },
  'País Vasco': { fr: 'Pays basque', en: 'Basque Country' },
  Aragón: { fr: 'Aragon', en: 'Aragon' },
  Valenciana: {
    name: 'Comunitat Valenciana',
    fr: 'Communauté valencienne',
    en: 'Valencian Community',
  },
  Extremadura: { fr: 'Estrémadure' },
  'Canary Is.': { name: 'Canarias', fr: 'Canaries', en: 'Canary Islands' },
};

/**
 * Generic French words Natural Earth puts in front of a name
 * ("canton de Vaud", "voïvodie de Lublin", "république de l'Altaï"). Only
 * lower-case ones: a capitalised "République autonome de Crimée" is a name.
 */
const FR_GENERIC =
  /^(?:canton|voïvodie|cité|municipalité|république|région|voblast|province|département|gouvernorat|comté|district|préfecture|oblast|kraï|territoire|émirat|wilaya)\s+/u;
/** A leading French article left over ("du Primorié", "d'Omsk", "de l'Altaï"). */
const FR_ARTICLE = /^(?:de la |de l'|de l’|des |du |de |d'|d’)/u;

/** Natural Earth's `name_fr` as a map label: no generic prefix, capitalised. */
export function cleanFrenchName(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (s === '') return null;
  // Lower-case start = a prefix or article, never a name of its own.
  if (/^\p{Ll}/u.test(s)) {
    s = s.replace(FR_GENERIC, '');
    s = s.replace(FR_ARTICLE, '');
  }
  return s.charAt(0).toLocaleUpperCase('fr') + s.slice(1);
}

/** Natural Earth's `name_en`, without the type words that only lengthen a label. */
export function cleanEnglishName(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw
    .trim()
    .replace(/ (?:Prefecture|Regional Corporation)$/u, '')
    .trim();
  return s === '' ? null : s;
}

/** Signed area of one ring (lon/lat degrees) on the sphere, km² (Chamberlain–Duquette). */
function ringArea(ring) {
  const n = ring.length;
  if (n < 3) return 0;
  const rad = Math.PI / 180;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const [lon1, lat1] = ring[i];
    const [lon2, lat2] = ring[(i + 1) % n];
    total += (lon2 - lon1) * rad * (2 + Math.sin(lat1 * rad) + Math.sin(lat2 * rad));
  }
  return (total * EARTH_RADIUS_KM * EARTH_RADIUS_KM) / 2;
}

/** Area (km²) of a GeoJSON Polygon or MultiPolygon: outer rings less their holes. */
export function geometryAreaKm2(geometry) {
  if (!geometry) return 0;
  const polygons =
    geometry.type === 'Polygon'
      ? [geometry.coordinates]
      : geometry.type === 'MultiPolygon'
        ? geometry.coordinates
        : [];
  let area = 0;
  for (const rings of polygons) {
    rings.forEach((ring, i) => {
      const a = Math.abs(ringArea(ring));
      area += i === 0 ? a : -a;
    });
  }
  return Math.max(0, area);
}

/**
 * The zoom at which an area of `areaKm2` around latitude `lat` spans
 * {@link LABEL_SPAN_PX} pixels across (Web Mercator: a degree of longitude
 * shrinks with cos(lat), so northern provinces are drawn bigger, earlier).
 */
export function dueZoom(areaKm2, lat) {
  if (!(areaKm2 > 0)) return Infinity;
  const kmPerPxAtZ0 = (EQUATOR_KM * Math.cos((lat * Math.PI) / 180)) / TILE_PX;
  return Math.log2((LABEL_SPAN_PX * kmPerPxAtZ0) / Math.sqrt(areaKm2));
}

/** A due zoom as the whole-level rank the tiles filter on. */
export function rankOf(zoom) {
  return Math.max(MIN_RANK, Math.round(zoom));
}

function round(v) {
  const k = 10 ** COORD_DECIMALS;
  return Math.round(v * k) / k;
}

/** The `name` / `name:fr` / `name:en` properties, translations only where they differ. */
function names(name, fr, en) {
  return {
    name,
    ...(fr && fr !== name ? { 'name:fr': fr } : {}),
    ...(en && en !== name ? { 'name:en': en } : {}),
  };
}

/** A label point from one Natural Earth admin-1 feature, or null without a name. */
export function admin1Point(feature) {
  const p = feature.properties ?? {};
  // Natural Earth's '/' joins a compound name ("Tunapuna/Piarco"), not
  // languages: drawn as a hyphen, so the style's multi-name cut never bites.
  const name = typeof p.name === 'string' ? p.name.trim().replace(/\s*[;/]\s*/gu, '-') : '';
  if (name === '') return null;
  const area = geometryAreaKm2(feature.geometry);
  const lon = Number(p.longitude);
  const lat = Number(p.latitude);
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || area <= 0) return null;
  return {
    country: typeof p.iso_a2 === 'string' ? p.iso_a2 : '',
    region: typeof p.region === 'string' && p.region.trim() !== '' ? p.region.trim() : null,
    name,
    fr: cleanFrenchName(p.name_fr),
    en: cleanEnglishName(p.name_en),
    lon,
    lat,
    area,
  };
}

/** One output Feature. */
function toFeature(lon, lat, props) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [round(lon), round(lat)] },
    properties: props,
  };
}

/**
 * The whole dataset from Natural Earth's admin-1 FeatureCollection: every
 * named province due by {@link MAX_RANK}, plus the grouped regions of
 * {@link REGION_COUNTRIES}, sorted by rank then name (stable diffs).
 */
export function buildAdmin1Labels(collection) {
  const points = (collection.features ?? []).map(admin1Point).filter((x) => x !== null);
  const out = [];

  // Grouped regions first: they decide which members are held back.
  const groups = new Map();
  for (const pt of points) {
    if (!REGION_COUNTRIES.has(pt.country) || pt.region === null) continue;
    const key = `${pt.country}\u0000${pt.region}`;
    groups.set(key, [...(groups.get(key) ?? []), pt]);
  }
  const grouped = new Set();
  for (const members of groups.values()) {
    // A one-member region IS its member (Madrid, Guyane): no second label.
    if (members.length < 2) continue;
    for (const m of members) grouped.add(m);
    const area = members.reduce((s, m) => s + m.area, 0);
    const lon = members.reduce((s, m) => s + m.lon * m.area, 0) / area;
    const lat = members.reduce((s, m) => s + m.lat * m.area, 0) / area;
    const region = members[0]?.region ?? '';
    const fix = REGION_NAMES[region] ?? {};
    const name = fix.name ?? region;
    const r = rankOf(dueZoom(area, lat));
    if (r >= REGION_UNTIL) continue;
    out.push(
      toFeature(lon, lat, { ...names(name, fix.fr ?? name, fix.en ?? name), r, u: REGION_UNTIL }),
    );
  }

  for (const pt of points) {
    const own = rankOf(dueZoom(pt.area, pt.lat));
    const r = grouped.has(pt) ? Math.max(own, REGION_UNTIL) : own;
    if (r > MAX_RANK) continue;
    out.push(toFeature(pt.lon, pt.lat, { ...names(pt.name, pt.fr, pt.en), r }));
  }

  out.sort(
    (a, b) =>
      a.properties.r - b.properties.r ||
      a.properties.name.localeCompare(b.properties.name, 'en') ||
      a.geometry.coordinates[0] - b.geometry.coordinates[0],
  );
  return { type: 'FeatureCollection', features: out };
}

/** The FeatureCollection as text: one feature per line, so a refresh diffs readably. */
export function serializeAdmin1Labels(collection) {
  const lines = collection.features.map((f) => JSON.stringify(f));
  return `{"type":"FeatureCollection","features":[\n${lines.join(',\n')}\n]}\n`;
}
