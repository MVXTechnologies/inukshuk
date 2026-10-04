import Constants from 'expo-constants';

/**
 * Where the vector base map's tiles come from: our own Protomaps extract,
 * served as XYZ by a Cloudflare Worker in front of R2 (see
 * `docs/design/vector-basemap.md` and `infra/tiles/`). A build can point
 * elsewhere with `VECTOR_TILES_URL` (e.g. a loopback `pmtiles serve` in dev).
 */
/**
 * Our Worker's address. The free workers.dev host for now: the
 * mvxtechnologies.com zone is on Namecheap DNS, so a custom domain waits for
 * it to move to Cloudflare (then change this — it is OTA-updatable config).
 */
export const TILE_HOST = 'https://inukshuk-tiles.marcandre-vigneault-96.workers.dev';

export const DEFAULT_VECTOR_TILES_URL = `${TILE_HOST}/basemap/{z}/{x}/{y}.mvt`;

/** Atkinson Hyperlegible Next glyphs on the same Worker (`infra/tiles/fonts/`). */
export const DEFAULT_VECTOR_GLYPHS_URL = `${TILE_HOST}/fonts/{fontstack}/{range}.pbf`;

/** The vector tile template this build reads (build-time override or ours). */
export function vectorTilesUrl(): string {
  const value: unknown = Constants.expoConfig?.extra?.vectorTilesUrl;
  return typeof value === 'string' && value !== '' ? value : DEFAULT_VECTOR_TILES_URL;
}

/**
 * The glyph host for the base map's labels (Atkinson Hyperlegible Next).
 * `VECTOR_GLYPHS_URL=none` falls back to OpenFreeMap's Noto (null here).
 */
export function vectorGlyphsUrl(): string | null {
  const value: unknown = Constants.expoConfig?.extra?.vectorGlyphsUrl;
  if (value === 'none') return null;
  return typeof value === 'string' && value !== '' ? value : DEFAULT_VECTOR_GLYPHS_URL;
}

/** Contour-line vector tiles, generated on demand by the same Worker. */
// `v` versions the contour recipe: bump it when levels change, so the 30-day
// edge and device caches fetch fresh tiles.
export const DEFAULT_VECTOR_CONTOURS_URL = `${TILE_HOST}/contours/{z}/{x}/{y}.mvt?v=2`;

/** The contour tile template this build reads (build-time override or ours). */
export function vectorContoursUrl(): string {
  const value: unknown = Constants.expoConfig?.extra?.vectorContoursUrl;
  return typeof value === 'string' && value !== '' ? value : DEFAULT_VECTOR_CONTOURS_URL;
}

/**
 * Named summits (OSM natural=peak|volcano), one worldwide archive built
 * monthly on the NAS (`infra/tiles/nas/peaks.sh`) and served by the same
 * Worker — Protomaps only carries peaks from z13.
 */
export const DEFAULT_VECTOR_PEAKS_URL = `${TILE_HOST}/peaks/{z}/{x}/{y}.mvt`;

/** The summit tile template this build reads (build-time override or ours). */
export function vectorPeaksUrl(): string {
  const value: unknown = Constants.expoConfig?.extra?.vectorPeaksUrl;
  return typeof value === 'string' && value !== '' ? value : DEFAULT_VECTOR_PEAKS_URL;
}

/**
 * National parks and protected areas (OSM boundary=national_park |
 * protected_area), one worldwide archive built on the NAS
 * (`infra/tiles/nas/parks.sh`) and served by the same Worker. Protomaps
 * misfiles too many of them to rank (`infra/tiles/README.md` § Parks).
 */
export const DEFAULT_VECTOR_PARKS_URL = `${TILE_HOST}/parks/{z}/{x}/{y}.mvt`;

/**
 * Whether `parks.pmtiles` is on the tile host. NOT YET: `parks.sh` has not
 * had its first NAS run, and a style that names a source with no tiles
 * behind it draws nothing from it. Until then the map draws the parks
 * Protomaps has. Flip this after the first upload (it is OTA-updatable).
 */
export const PARKS_TILES_PUBLISHED = true;

/**
 * The parks tile template this build reads: a build-time override, ours once
 * published, else null — the style then falls back to Protomaps' parks.
 */
export function vectorParksUrl(): string | null {
  const value: unknown = Constants.expoConfig?.extra?.vectorParksUrl;
  if (typeof value === 'string' && value !== '') return value;
  return PARKS_TILES_PUBLISHED ? DEFAULT_VECTOR_PARKS_URL : null;
}

/**
 * Worldwide province / state label points (Natural Earth admin-1, public
 * domain): one ~470 KB GeoJSON file (~70 KB gzipped) on the GitHub Pages
 * site, built by `scripts/map/build-admin1-labels.mjs`. The Protomaps tiles
 * name provinces in only a few countries. A static file needs no NAS run and
 * no Worker deploy: merging it to main publishes it.
 */
export const DEFAULT_ADMIN1_LABELS_URL =
  'https://inukshuk.mvxtechnologies.com/data/admin1-labels-v1.json';

/** The province-label URL this build reads (build-time override or ours). */
export function admin1LabelsUrl(): string {
  const value: unknown = Constants.expoConfig?.extra?.admin1LabelsUrl;
  return typeof value === 'string' && value !== '' ? value : DEFAULT_ADMIN1_LABELS_URL;
}

/**
 * The `vectorBasemap` style option for our host (tiles, Atkinson glyphs, the
 * named summits, the parks once published and, when `withContours`, the
 * served contour tiles) — one place for the main map, the trail viewer and
 * offline packs (a pack stores every source of the style it downloads
 * through, so the summits and parks come along).
 */
export function vectorBasemapOption(
  dark: boolean,
  withContours: boolean,
): {
  tiles: string[];
  dark: boolean;
  glyphs?: string;
  contours?: string;
  peaks: string;
  parks?: string;
  admin1: string;
} {
  const glyphs = vectorGlyphsUrl();
  const parks = vectorParksUrl();
  return {
    tiles: [vectorTilesUrl()],
    dark,
    peaks: vectorPeaksUrl(),
    admin1: admin1LabelsUrl(),
    ...(parks !== null ? { parks } : {}),
    ...(glyphs !== null ? { glyphs } : {}),
    ...(withContours ? { contours: vectorContoursUrl() } : {}),
  };
}

/**
 * The `imageryContours` style option (#492): the same served contour tiles
 * as the Map base, plus our glyph host for their height labels, for drawing
 * over satellite imagery.
 */
export function imageryContoursOption(): { tiles: string; glyphs?: string } {
  const glyphs = vectorGlyphsUrl();
  return { tiles: vectorContoursUrl(), ...(glyphs !== null ? { glyphs } : {}) };
}
