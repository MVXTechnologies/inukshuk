import Constants from 'expo-constants';

/**
 * Where the vector base map's tiles come from: our own Protomaps extract,
 * served as XYZ by a Cloudflare Worker in front of R2 (see
 * `docs/design/vector-basemap.md` and `infra/tiles/`). A build can point
 * elsewhere with `VECTOR_TILES_URL` (e.g. a loopback `pmtiles serve` in dev).
 */
export const DEFAULT_VECTOR_TILES_URL = 'https://tiles.mvxtechnologies.com/basemap/{z}/{x}/{y}.mvt';

/** The vector tile template this build reads (build-time override or ours). */
export function vectorTilesUrl(): string {
  const value: unknown = Constants.expoConfig?.extra?.vectorTilesUrl;
  return typeof value === 'string' && value !== '' ? value : DEFAULT_VECTOR_TILES_URL;
}

/**
 * Our glyph host for the base map's labels (Atkinson Hyperlegible Next), or
 * null until the glyphs are uploaded (`infra/tiles/fonts/`) — the map then
 * keeps OpenFreeMap's Noto fallback.
 */
export function vectorGlyphsUrl(): string | null {
  const value: unknown = Constants.expoConfig?.extra?.vectorGlyphsUrl;
  return typeof value === 'string' && value !== '' ? value : null;
}
