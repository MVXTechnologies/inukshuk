import Constants from 'expo-constants';

import {
  parseCatalogIndex,
  parseCatalogShard,
  type CatalogIndex,
  type CatalogItem,
  type CatalogShardRef,
} from '@core/catalog/schema';
import { resolveCatalogUrl } from '@core/catalog/shard';
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
 *   downloads that to open a tab.
 *
 * Both are cached in `Paths.document` (index as `catalog.json`, shards as
 * `catalog-shard-<id>.json`) so browsing what you have already seen works
 * offline; the network is consulted only past the TTL, and every failure path
 * falls back to the cached copy. Never throws.
 *
 * The URL is overridable via `extra.catalogManifestUrl` (same idiom as
 * `errorReportEndpoint`) so e2e builds can point at a loopback fixture server —
 * CI must never depend on NRCan, NOAA or USGS being up.
 */

const DEFAULT_INDEX_URL = 'https://inukshuk.mvxtechnologies.com/catalog/v2/index.json';
const CACHE_FILE = 'catalog.json';
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

/** Read a cached document, ignoring one written for a different URL. */
async function readCached(file: string, url: string): Promise<CachedDocument | null> {
  try {
    const raw = await storage.readJson<unknown>(file);
    return isCachedDocument(raw) && raw.url === url ? raw : null;
  } catch {
    // Unreadable cache — behave like a first launch.
    return null;
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
  const cached = await readCached(CACHE_FILE, url);
  const cacheFresh = cached !== null && Date.now() - cached.fetchedAt < CACHE_TTL_MS;

  if (cached !== null && cacheFresh && options?.force !== true) {
    const { index, warnings } = parseCatalogIndex(cached.raw);
    // A cached copy that no longer parses (schema drift) falls through to the
    // network below rather than bricking the store until the TTL expires.
    if (index !== null) return { index, fromCache: true, warnings };
  }

  try {
    const raw = await fetchJson(url);
    const { index, warnings } = parseCatalogIndex(raw);
    if (index === null) throw new Error(warnings[0] ?? 'unusable catalog index');
    writeCached(CACHE_FILE, url, raw);
    return { index, fromCache: false, warnings };
  } catch {
    if (cached !== null) {
      const { index, warnings } = parseCatalogIndex(cached.raw);
      if (index !== null) return { index, fromCache: true, warnings };
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
  const cached = await readCached(file, url);
  const cacheFresh = cached !== null && Date.now() - cached.fetchedAt < SHARD_CACHE_TTL_MS;

  if (cached !== null && cacheFresh && options?.force !== true) {
    const { items, warnings } = parseCatalogShard(cached.raw, sourceIds);
    if (items.length > 0) return { items, fromCache: true, warnings };
  }

  try {
    const raw = await fetchJson(url);
    const { items, warnings } = parseCatalogShard(raw, sourceIds);
    if (items.length === 0) throw new Error(warnings[0] ?? 'empty catalog shard');
    writeCached(file, url, raw);
    return { items, fromCache: false, warnings };
  } catch {
    if (cached !== null) {
      const { items, warnings } = parseCatalogShard(cached.raw, sourceIds);
      if (items.length > 0) return { items, fromCache: true, warnings };
    }
    return null;
  }
}
