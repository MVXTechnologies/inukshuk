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
export const DEFAULT_VECTOR_CONTOURS_URL = `${TILE_HOST}/contours/{z}/{x}/{y}.mvt`;

/** The contour tile template this build reads (build-time override or ours). */
export function vectorContoursUrl(): string {
  const value: unknown = Constants.expoConfig?.extra?.vectorContoursUrl;
  return typeof value === 'string' && value !== '' ? value : DEFAULT_VECTOR_CONTOURS_URL;
}
