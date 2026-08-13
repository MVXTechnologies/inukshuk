import Constants from 'expo-constants';

import {
  parseCatalogIndex,
  parseCatalogShard,
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
 * `catalog-shard-<id>.json`, digest as `catalog-search.json`) so browsing what
 * you have already seen works offline; the network is consulted only past the
 * TTL, and every failure path falls back to the cached copy. Never throws.
 *
 * The URL is overridable via `extra.catalogManifestUrl` (same idiom as
 * `errorReportEndpoint`) so e2e builds can point at a loopback fixture server —
 * CI must never depend on NRCan, NOAA or USGS being up.
 */

const DEFAULT_INDEX_URL = 'https://inukshuk.mvxtechnologies.com/catalog/v2/index.json';
const CACHE_FILE = 'catalog.json';
const SEARCH_CACHE_FILE = 'catalog-search.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Shards change far less often than the index; keep them a week. */
const SHARD_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

/** The catalog index URL this build reads (build-time override or Pages). */
export function catalogManifestUrl(): string {
  const value: unknown = Constants.expoConfig?.extra?.catalogManifestUrl;
  return typeof value === 'string' && value !== '' ? value : DEFAULT_INDEX_URL;
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
  const url = catalogManifestUrl();
  const { current, superseded } = await readCached(CACHE_FILE, url);
  const cacheFresh = current !== null && Date.now() - current.fetchedAt < CACHE_TTL_MS;

  if (current !== null && cacheFresh && options?.force !== true) {
    const { index, warnings } = parseCatalogIndex(current.raw);
    // A cached copy that no longer parses (schema drift) falls through to the
    // network below rather than bricking the store until the TTL expires.
    if (index !== null) return { index, fromCache: true, warnings };
  }

  try {
    const raw = await fetchJson(url);
    const { index, warnings } = parseCatalogIndex(raw);
    if (index === null) throw new Error(warnings[0] ?? 'unusable catalog index');
    // Writing under the new URL migrates a superseded entry away: the very
    // first successful v2 load replaces the v1 copy in the same cache file.
    writeCached(CACHE_FILE, url, raw);
    return { index, fromCache: false, warnings };
  } catch {
    // `parseCatalogIndex` accepts a v1 flat manifest too, which is what makes
    // the superseded copy usable at all — it adapts to an index with every
    // item inline and no shards, so the store browses exactly what the
    // previous build showed.
    for (const fallback of [current, superseded]) {
      if (fallback === null) continue;
      const { index, warnings } = parseCatalogIndex(fallback.raw);
      if (index !== null) return { index, fromCache: true, warnings };
    }
    return null;
  }
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
  const url = resolveCatalogUrl(catalogManifestUrl(), ref.path);
  if (url === null) return null;

  const { current, superseded } = await readCached(SEARCH_CACHE_FILE, url);
  const cacheFresh = current !== null && Date.now() - current.fetchedAt < SHARD_CACHE_TTL_MS;

  if (current !== null && cacheFresh && options?.force !== true) {
    const { digest, warnings } = parseCatalogSearchDigest(current.raw);
    if (digest !== null) return { digest, fromCache: true, warnings };
  }

  try {
    const raw = await fetchJson(url);
    const { digest, warnings } = parseCatalogSearchDigest(raw);
    if (digest === null) throw new Error(warnings[0] ?? 'unusable search digest');
    writeCached(SEARCH_CACHE_FILE, url, raw);
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

/** Flat, collision-free cache filename for a shard id (already charset-checked). */
function shardCacheFile(shardId: string): string {
  return `catalog-shard-${shardId}.json`;
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
  const url = resolveCatalogUrl(catalogManifestUrl(), shard.path);
  if (url === null) return null;

  const file = shardCacheFile(shard.id);
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
