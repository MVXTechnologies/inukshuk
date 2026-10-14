import Constants from 'expo-constants';

import { parseCatalogFacets, type CatalogFacets } from '@core/catalog/facets';
import {
  parseCatalogIndex,
  parseCatalogShard,
  type CatalogDocumentRef,
  type CatalogIndex,
  type CatalogItem,
  type CatalogSearchRef,
  type CatalogShardRef,
} from '@core/catalog/schema';
import { parseCatalogSearchDigest, type CatalogSearchDigest } from '@core/catalog/searchDigest';
import { resolveCatalogUrl, sameCatalogOrigin } from '@core/catalog/shard';
import * as storage from './storage';

/**
 * Fetch + on-device cache for the map-store catalog.
 *
 * The catalog is a set of static JSON documents on the Pages site; phones only
 * ever read them (and the sources' direct file URLs — we never rehost map
 * bytes). Two documents matter:
 *
 * - the **index** (`/catalog/v2/index.json`): sources, per-category totals and
 *   the shard directory. Small and always fetched — it is what the Search tab
 *   lands on;
 * - a **shard** (`shards/<id>.json`): the items of one category in one
 *   geographic cell, fetched only when the user's position or a category tap
 *   makes it relevant. A world catalog is tens of thousands of sheets; nobody
 *   downloads that to open a tab;
 * - the **search digest** (`search.json`): token → shard postings, fetched the
 *   first time the user types. It is the only way a query can reach a sheet on
 *   the other side of the world without pulling the whole catalog — see
 *   `@core/catalog/searchDigest`. Optional: the index says whether one exists.
 *
 * All three are cached in `Paths.document` (index as `catalog.json`, shards as
 * `catalog-shard-<id>.json`, digest as `catalog-search.json`; v3 and later
 * editions under their own names, see {@link catalogCacheFile}) so browsing
 * what you have already seen works offline; the network is consulted only past the
 * TTL, and every failure path falls back to the cached copy. Never throws.
 *
 * The URL is overridable via `extra.catalogManifestUrl` (same idiom as
 * `errorReportEndpoint`) so e2e builds can point at a loopback fixture server —
 * CI must never depend on NRCan, NOAA or USGS being up.
 *
 * **Editions (#680).** This build reads `/catalog/v3/`, the credited edition:
 * everything in v2 plus the sources whose terms need the author and "free at"
 * lines only 2.5.2+ renders (Cartes Plein-air). Older apps keep reading v2 and
 * never see those maps. v3 shares v2's unchanged shards (`../v2/shards/…`), so
 * documents resolve against the index they were listed in
 * ({@link catalogIndexBaseUrl}), and a missing or broken v3 falls back to v2:
 * the store then lists what an older app lists, never nothing.
 */

const DEFAULT_INDEX_URL = 'https://inukshuk.mvxtechnologies.com/catalog/v3/index.json';
/** The edition every older app reads; this build's fallback when v3 is unreachable. */
const LEGACY_INDEX_URL = 'https://inukshuk.mvxtechnologies.com/catalog/v2/index.json';
/** The cached documents' kinds: `catalog<edition><kind>.json`. */
const INDEX_KIND = '';
const SEARCH_KIND = '-search';
const FACETS_KIND = '-facets';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Shards change far less often than the index; keep them a week. */
const SHARD_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

/** The catalog index URL this build reads (build-time override or Pages). */
export function catalogManifestUrl(): string {
  const value: unknown = Constants.expoConfig?.extra?.catalogManifestUrl;
  return typeof value === 'string' && value !== '' ? value : DEFAULT_INDEX_URL;
}

/**
 * Index URLs to try, in order: this build's edition, then the legacy edition.
 * An override (e2e fixture, dev catalog) is the only candidate: a fixture run
 * must never quietly read production.
 */
export function catalogIndexUrls(): string[] {
  const primary = catalogManifestUrl();
  return primary === DEFAULT_INDEX_URL ? [DEFAULT_INDEX_URL, LEGACY_INDEX_URL] : [primary];
}

/** The URL of the index the store is browsing; null until one has loaded. */
let loadedIndexUrl: string | null = null;

/**
 * What shard, digest and collection paths resolve against: the index the
 * store actually loaded (v3, or v2 after a fallback), else this build's own.
 * Resolving against the wrong edition would ask v2 for v3's river shards.
 */
export function catalogIndexBaseUrl(): string {
  return loadedIndexUrl ?? catalogManifestUrl();
}

/** Test hook: forget which index loaded. */
export function resetCatalogIndexBaseUrl(): void {
  loadedIndexUrl = null;
}

/**
 * The cache file of one catalog document, named by the EDITION of the URL it
 * comes from (2.5.2 review). Before 2.5.2 every edition shared `catalog.json`,
 * `catalog-search.json`, `catalog-facets.json` and `catalog-shard-<id>.json`,
 * and an app rolled back to 2.5.1 falls back to a same-origin copy whatever
 * its edition when offline: it would browse v3's Cartes Plein-air maps
 * without the credits their terms require (and v3's river shard ids are v2's).
 * So v3 and later write `catalog-v3….json`; v2 (and v1, and any URL outside a
 * `/catalog/vN/` directory, such as an e2e fixture) keep the names 2.5.1
 * reads. A v3 index's shared `../v2/` shard resolves to the v2 URL, and so to
 * the v2 file: the very entry 2.5.1 writes, with the same contents.
 */
export function catalogCacheFile(kind: string, url: string): string {
  const edition = /\/catalog\/v(\d+)\//.exec(url)?.[1];
  const tag = edition !== undefined && Number(edition) >= 3 ? `-v${edition}` : '';
  return `catalog${tag}${kind}.json`;
}

/** Persisted shape of a cached document (raw JSON + fetch bookkeeping). */
interface CachedDocument {
  fetchedAt: number;
  /** URL the copy came from — a build pointed elsewhere must not reuse it. */
  url: string;
  raw: unknown;
}

export interface CatalogLoadResult {
  index: CatalogIndex;
  /** True when served from the on-device copy (fresh-enough, offline, or failed). */
  fromCache: boolean;
  /** Parser warnings (dropped rows) — reported, not user-facing. */
  warnings: string[];
}

export interface CatalogShardLoadResult {
  items: CatalogItem[];
  fromCache: boolean;
  warnings: string[];
}

export interface CatalogSearchDigestLoadResult {
  digest: CatalogSearchDigest;
  fromCache: boolean;
  warnings: string[];
}

export interface CatalogFacetsLoadResult {
  facets: CatalogFacets;
  fromCache: boolean;
  warnings: string[];
}

function isCachedDocument(value: unknown): value is CachedDocument {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as CachedDocument).fetchedAt === 'number' &&
    typeof (value as CachedDocument).url === 'string' &&
    'raw' in value
  );
}

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`catalog fetch failed: HTTP ${res.status}`);
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

/** What the on-device copy of a document is worth to the current request. */
interface CacheLookup {
  /** Written for exactly this URL: usable for the TTL and as a fallback. */
  current: CachedDocument | null;
  /**
   * Written for a *different path on the same origin* — an older build's copy
   * of the same catalog (`/catalog/v1/manifest.json` before this client moved
   * to `/catalog/v2/index.json`). Never fresh, never TTL-served: used only when
   * the network has failed and there is nothing else, which is the difference
   * between "the store still lists your 128 maps" and an error screen at a
   * trailhead the morning after an app update. A copy from another origin (a
   * dev override, the e2e loopback fixture) is discarded outright.
   */
  superseded: CachedDocument | null;
}

/** Read the on-device copy and classify it against the URL being requested. */
async function readCached(file: string, url: string): Promise<CacheLookup> {
  try {
    const raw = await storage.readJson<unknown>(file);
    if (!isCachedDocument(raw)) return { current: null, superseded: null };
    if (raw.url === url) return { current: raw, superseded: null };
    return { current: null, superseded: sameCatalogOrigin(raw.url, url) ? raw : null };
  } catch {
    // Unreadable cache — behave like a first launch.
    return { current: null, superseded: null };
  }
}

function writeCached(file: string, url: string, raw: unknown): void {
  try {
    storage.writeJson(file, { fetchedAt: Date.now(), url, raw } satisfies CachedDocument);
  } catch {
    // A failed cache write must not fail the load (e.g. disk full).
  }
}

/**
 * Load the catalog index: on-device cache when fresh, else network with cache
 * fallback. `force` skips the TTL (pull-to-refresh). Returns null only when
 * there is no usable index anywhere (first launch while offline).
 *
 * Accepts both wire shapes — a v1 flat manifest parses into the same index with
 * every item inline — so a cache written by an older build is never wasted.
 */
export async function loadCatalogManifest(options?: {
  force?: boolean;
}): Promise<CatalogLoadResult | null> {
  const [primary = catalogManifestUrl(), ...fallbacks] = catalogIndexUrls();
  const { current, superseded } = await readCached(catalogCacheFile(INDEX_KIND, primary), primary);
  const cacheFresh = current !== null && Date.now() - current.fetchedAt < CACHE_TTL_MS;

  // Only this build's own edition is served from cache without asking: a v2
  // copy written while v3 was unreachable is retried for v3 on the next load.
  if (current !== null && cacheFresh && options?.force !== true) {
    const { index, warnings } = parseCatalogIndex(current.raw);
    // A cached copy that no longer parses (schema drift) falls through to the
    // network below rather than bricking the store until the TTL expires.
    if (index !== null) return loaded(primary, { index, fromCache: true, warnings });
  }

  for (const url of [primary, ...fallbacks]) {
    try {
      const raw = await fetchJson(url);
      const { index, warnings } = parseCatalogIndex(raw);
      if (index === null) throw new Error(warnings[0] ?? 'unusable catalog index');
      // Writing under the new URL migrates a superseded entry away: the very
      // first successful load replaces an older edition's copy in the same file.
      writeCached(catalogCacheFile(INDEX_KIND, url), url, raw);
      return loaded(url, { index, fromCache: false, warnings });
    } catch {
      // Next edition; then the on-device copy below.
    }
  }

  // `parseCatalogIndex` accepts a v1 flat manifest too, which is what makes a
  // superseded copy usable at all — it adapts to an index with every item
  // inline and no shards, so the store browses exactly what the previous
  // build showed. A superseded v2 copy keeps its own URL as the base, so its
  // shard paths still resolve (and hit the shard cache an older build wrote).
  // The other editions' copies live in their own files (v2's in `catalog.json`).
  const others = await Promise.all(
    fallbacks
      .filter((url) => catalogCacheFile(INDEX_KIND, url) !== catalogCacheFile(INDEX_KIND, primary))
      .map((url) => readCached(catalogCacheFile(INDEX_KIND, url), url)),
  );
  for (const fallback of [
    current,
    ...others.map((o) => o.current),
    superseded,
    ...others.map((o) => o.superseded),
  ]) {
    if (fallback === null) continue;
    const { index, warnings } = parseCatalogIndex(fallback.raw);
    if (index !== null) return loaded(fallback.url, { index, fromCache: true, warnings });
  }
  return null;
}

/** Record which index the store is browsing, so its paths resolve against it. */
function loaded(url: string, result: CatalogLoadResult): CatalogLoadResult {
  loadedIndexUrl = url;
  return result;
}

/**
 * Load the search digest the index points at: cache first (it changes only
 * when the catalog is regenerated), else network with cache fallback. Returns
 * null when it is reachable from neither — the Search tab then restricts itself
 * to the area it has loaded and *says so*, rather than reporting "no results".
 */
export async function loadCatalogSearchDigest(
  ref: CatalogSearchRef,
  options?: { force?: boolean },
): Promise<CatalogSearchDigestLoadResult | null> {
  const url = resolveCatalogUrl(catalogIndexBaseUrl(), ref.path);
  if (url === null) return null;

  const file = catalogCacheFile(SEARCH_KIND, url);
  const { current, superseded } = await readCached(file, url);
  const cacheFresh = current !== null && Date.now() - current.fetchedAt < SHARD_CACHE_TTL_MS;

  if (current !== null && cacheFresh && options?.force !== true) {
    const { digest, warnings } = parseCatalogSearchDigest(current.raw);
    if (digest !== null) return { digest, fromCache: true, warnings };
  }

  try {
    const raw = await fetchJson(url);
    const { digest, warnings } = parseCatalogSearchDigest(raw);
    if (digest === null) throw new Error(warnings[0] ?? 'unusable search digest');
    writeCached(file, url, raw);
    return { digest, fromCache: false, warnings };
  } catch {
    for (const fallback of [current, superseded]) {
      if (fallback === null) continue;
      const { digest, warnings } = parseCatalogSearchDigest(fallback.raw);
      if (digest !== null) return { digest, fromCache: true, warnings };
    }
    return null;
  }
}

/**
 * Load the per-shard facet digest (`facets.json`) the index points at — what
 * lets the explorer's "Hiking" or "Glaciers" list fetch only the shards that
 * hold such maps instead of every ring around the user. Same cache policy as
 * the search digest; null when reachable from neither (the list then falls
 * back to nearest-first rings).
 */
export async function loadCatalogFacets(
  ref: CatalogDocumentRef,
  options?: { force?: boolean },
): Promise<CatalogFacetsLoadResult | null> {
  const url = resolveCatalogUrl(catalogIndexBaseUrl(), ref.path);
  if (url === null) return null;

  const file = catalogCacheFile(FACETS_KIND, url);
  const { current, superseded } = await readCached(file, url);
  const cacheFresh = current !== null && Date.now() - current.fetchedAt < SHARD_CACHE_TTL_MS;

  if (current !== null && cacheFresh && options?.force !== true) {
    const { facets, warnings } = parseCatalogFacets(current.raw);
    if (facets !== null) return { facets, fromCache: true, warnings };
  }

  try {
    const raw = await fetchJson(url);
    const { facets, warnings } = parseCatalogFacets(raw);
    if (facets === null) throw new Error(warnings[0] ?? 'unusable facets digest');
    writeCached(file, url, raw);
    return { facets, fromCache: false, warnings };
  } catch {
    for (const fallback of [current, superseded]) {
      if (fallback === null) continue;
      const { facets, warnings } = parseCatalogFacets(fallback.raw);
      if (facets !== null) return { facets, fromCache: true, warnings };
    }
    return null;
  }
}

/**
 * Load one shard's items: cache first (a shard is immutable for a week), else
 * network with cache fallback. Returns null when the shard is reachable from
 * neither — the caller simply shows fewer items rather than an error, because
 * some other shard usually did load.
 */
export async function loadCatalogShard(
  shard: CatalogShardRef,
  sourceIds: ReadonlySet<string>,
  options?: { force?: boolean },
): Promise<CatalogShardLoadResult | null> {
  const url = resolveCatalogUrl(catalogIndexBaseUrl(), shard.path);
  if (url === null) return null;

  // Flat and collision-free: the id is charset-checked, the edition is the URL's.
  const file = catalogCacheFile(`-shard-${shard.id}`, url);
  const { current, superseded } = await readCached(file, url);
  const cacheFresh = current !== null && Date.now() - current.fetchedAt < SHARD_CACHE_TTL_MS;

  if (current !== null && cacheFresh && options?.force !== true) {
    const { items, warnings } = parseCatalogShard(current.raw, sourceIds);
    if (items.length > 0) return { items, fromCache: true, warnings };
  }

  try {
    const raw = await fetchJson(url);
    const { items, warnings } = parseCatalogShard(raw, sourceIds);
    if (items.length === 0) throw new Error(warnings[0] ?? 'empty catalog shard');
    writeCached(file, url, raw);
    return { items, fromCache: false, warnings };
  } catch {
    for (const fallback of [current, superseded]) {
      if (fallback === null) continue;
      const { items, warnings } = parseCatalogShard(fallback.raw, sourceIds);
      if (items.length > 0) return { items, fromCache: true, warnings };
    }
    return null;
  }
}
