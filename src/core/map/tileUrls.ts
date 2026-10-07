/**
 * Tile URL templates as the OFFLINE CACHE KEY (architecture review P1-2).
 *
 * MapLibre's offline packs store every tile, glyph range and sprite under the
 * exact URL the pack's style named — host, path and `?v=` query alike. Change
 * a template the live app uses and every pack built with the old one is
 * orphaned: in the field the map goes blank where the user thought it was
 * downloaded. So each pack records the templates it was built with
 * ({@link styleUrlTemplates}), and the app compares them with the templates it
 * would build today ({@link staleTemplateKeys}) to tell the user a region
 * needs downloading again instead of failing silently.
 *
 * Moving the tile HOST does not need any of that: the templates keep the old
 * host as their cache key and MapLibre's request transform sends the network
 * fetch to the new one ({@link tileHostAlias}). See `docs/design/tile-urls.md`.
 */

/**
 * A pack's URL templates, by where the style uses them:
 * - `source:<id>`: a source's `tiles` (joined by a space when there are
 *   several), or its TileJSON `url`, or a GeoJSON source's `data` URL;
 * - `glyphs` and `sprite`: the style's glyph and sprite URLs.
 */
export type UrlTemplates = Record<string, string>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The URL a style field holds, or null (inline data, missing, malformed). */
function urlOf(value: unknown): string | null {
  return typeof value === 'string' && /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : null;
}

/**
 * Every network URL template a MapLibre style references — what an offline
 * pack downloaded through it stores, keyed as {@link UrlTemplates}. Accepts
 * the style object or its JSON; anything unparsable yields `{}`.
 */
export function styleUrlTemplates(style: unknown): UrlTemplates {
  let parsed: unknown = style;
  if (typeof style === 'string') {
    try {
      parsed = JSON.parse(style);
    } catch {
      return {};
    }
  }
  if (!isRecord(parsed)) return {};
  const out: UrlTemplates = {};
  const glyphs = urlOf(parsed.glyphs);
  if (glyphs !== null) out.glyphs = glyphs;
  // A sprite is a URL, or (MapLibre ≥ 3) a list of { id, url }.
  const sprite = Array.isArray(parsed.sprite)
    ? parsed.sprite
        .map((s) => (isRecord(s) ? urlOf(s.url) : null))
        .filter((u): u is string => u !== null)
        .join(' ')
    : (urlOf(parsed.sprite) ?? '');
  if (sprite !== '') out.sprite = sprite;
  if (isRecord(parsed.sources)) {
    for (const [id, source] of Object.entries(parsed.sources)) {
      if (!isRecord(source)) continue;
      const tiles = Array.isArray(source.tiles)
        ? source.tiles.map(urlOf).filter((u): u is string => u !== null)
        : [];
      const template =
        tiles.length > 0 ? tiles.join(' ') : (urlOf(source.url) ?? urlOf(source.data));
      if (template !== null) out[`source:${id}`] = template;
    }
  }
  return out;
}

/**
 * The keys whose template a pack recorded differently from today's — the
 * resources it holds that the live map will never ask for again. Keys only one
 * side has are not a mismatch: a source the pack never carried (an extension
 * installed later) or one the app no longer draws costs nothing. Sorted.
 */
export function staleTemplateKeys(recorded: UrlTemplates, current: UrlTemplates): string[] {
  return Object.keys(recorded)
    .filter((k) => k in current && current[k] !== recorded[k])
    .sort();
}

/** A well-formed {@link UrlTemplates} from untrusted storage, or null. */
export function parseUrlTemplates(value: unknown): UrlTemplates | null {
  if (!isRecord(value)) return null;
  const out: UrlTemplates = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== 'string') return null;
    out[k] = v;
  }
  return out;
}

/** A MapLibre URL transform (`TransformRequestManager.addUrlTransform`). */
export interface UrlTransform {
  id: string;
  /** Regex source: requests it matches are rewritten. */
  match: string;
  /** Regex source: the part replaced. */
  find: string;
  replace: string;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** An origin without its trailing slash(es). */
const trimHost = (host: string): string => host.replace(/\/+$/, '');

/** Stable id of the tile-host alias transform (re-adding it updates it in place). */
export const TILE_HOST_ALIAS_ID = 'tile-host-alias';

/**
 * The request transform that sends MapLibre's fetches for `keyHost` (the host
 * baked into the URL templates, i.e. the offline cache key) to `servingHost`
 * (where the tiles really are) — or null when they are the same host.
 *
 * MapLibre applies it in its HTTP layer (an OkHttp interceptor on Android,
 * `MLNNetworkConfiguration`'s delegate on iOS), AFTER the offline database
 * lookup, which still uses the template URL. That is what lets the host move
 * without orphaning a single pack.
 */
export function tileHostAlias(keyHost: string, servingHost: string): UrlTransform | null {
  const from = trimHost(keyHost);
  const to = trimHost(servingHost);
  if (from === to) return null;
  // Anchored, and followed by a path, query or the end: never a longer host
  // that merely starts with the same characters.
  const pattern = `^${escapeRegExp(from)}(?=[/?#]|$)`;
  return { id: TILE_HOST_ALIAS_ID, match: pattern, find: pattern, replace: to };
}

/** `url` with `keyHost` swapped for `servingHost`: the same rewrite for plain `fetch` calls. */
export function aliasTileUrl(url: string, keyHost: string, servingHost: string): string {
  const alias = tileHostAlias(keyHost, servingHost);
  return alias === null ? url : url.replace(new RegExp(alias.find), alias.replace);
}
