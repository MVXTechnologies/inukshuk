/**
 * Minimal TileJSON reading for the overlay-labels source (weather wave B).
 *
 * maplibre-native silently fails to load a vector source declared with a
 * TileJSON `url` (the reference gl-js renderer loads the identical style
 * fine), so the app resolves the TileJSON itself and passes the concrete
 * tile URL template(s) into the style as inline `tiles`. OpenFreeMap's
 * templates carry a dated deployment path, so they must never be
 * hardcoded — always resolved from the TileJSON endpoint at runtime.
 */

/** Absolute-URL tile templates from a TileJSON document, or null when the
 * document doesn't hold any (malformed, junk, wrong type). Never throws. */
export function tileTemplatesFromTileJson(doc: unknown): readonly string[] | null {
  if (typeof doc !== 'object' || doc === null) return null;
  const tiles = (doc as { tiles?: unknown }).tiles;
  if (!Array.isArray(tiles) || tiles.length === 0) return null;
  const urls = tiles.filter(
    (t): t is string => typeof t === 'string' && /^https?:\/\//i.test(t) && t.includes('{z}'),
  );
  return urls.length > 0 ? urls : null;
}
