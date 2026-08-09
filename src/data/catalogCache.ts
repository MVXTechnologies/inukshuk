import Constants from 'expo-constants';

import { parseCatalogManifest, type CatalogManifest } from '@core/catalog/schema';
import * as storage from './storage';

/**
 * Fetch + on-device cache for the map-store catalog manifest.
 *
 * The manifest is a static JSON document on the Pages site; phones only ever
 * read it (and the sources' direct file URLs — we never rehost map bytes).
 * The last good copy is persisted to `Paths.document/catalog.json` so browsing
 * the store works offline; the network is consulted only when the cache is
 * missing or older than the TTL, and every failure path falls back to the
 * cached copy. Never throws.
 *
 * The URL is overridable via `extra.catalogManifestUrl` (same idiom as
 * `errorReportEndpoint`) so e2e builds can point at a loopback fixture server —
 * CI must never depend on NRCan being up.
 */

const DEFAULT_MANIFEST_URL = 'https://inukshuk.mvxtechnologies.com/catalog/v1/manifest.json';
const CACHE_FILE = 'catalog.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

/** The manifest URL this build reads (build-time override or the Pages site). */
export function catalogManifestUrl(): string {
  const value: unknown = Constants.expoConfig?.extra?.catalogManifestUrl;
  return typeof value === 'string' && value !== '' ? value : DEFAULT_MANIFEST_URL;
}

/** Persisted shape of `catalog.json` (the raw manifest + fetch bookkeeping). */
interface CachedCatalog {
  fetchedAt: number;
  /** URL the copy came from — a build pointed elsewhere must not reuse it. */
  url: string;
  raw: unknown;
}

export interface CatalogLoadResult {
  manifest: CatalogManifest;
  /** True when served from the on-device copy (fresh-enough, offline, or fetch failed). */
  fromCache: boolean;
  /** Parser warnings (dropped rows) — reported, not user-facing. */
  warnings: string[];
}

function isCachedCatalog(value: unknown): value is CachedCatalog {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as CachedCatalog).fetchedAt === 'number' &&
    typeof (value as CachedCatalog).url === 'string' &&
    'raw' in value
  );
}

async function fetchManifestJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`catalog manifest fetch failed: HTTP ${res.status}`);
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Load the catalog manifest: on-device cache when fresh, else network with
 * cache fallback. `force` skips the TTL (pull-to-refresh). Returns null only
 * when there is no usable manifest anywhere (first launch while offline).
 */
export async function loadCatalogManifest(options?: {
  force?: boolean;
}): Promise<CatalogLoadResult | null> {
  const url = catalogManifestUrl();

  let cached: CachedCatalog | null = null;
  try {
    const raw = await storage.readJson<unknown>(CACHE_FILE);
    if (isCachedCatalog(raw) && raw.url === url) cached = raw;
  } catch {
    // Unreadable cache — behave like a first launch.
  }

  const cacheFresh = cached !== null && Date.now() - cached.fetchedAt < CACHE_TTL_MS;
  if (cached !== null && cacheFresh && options?.force !== true) {
    const { manifest, warnings } = parseCatalogManifest(cached.raw);
    // A cached copy that no longer parses (schema drift) falls through to the
    // network below rather than bricking the store until the TTL expires.
    if (manifest !== null) return { manifest, fromCache: true, warnings };
  }

  try {
    const raw = await fetchManifestJson(url);
    const { manifest, warnings } = parseCatalogManifest(raw);
    if (manifest === null) throw new Error(warnings[0] ?? 'unusable catalog manifest');
    try {
      storage.writeJson(CACHE_FILE, { fetchedAt: Date.now(), url, raw } satisfies CachedCatalog);
    } catch {
      // A failed cache write must not fail the load (e.g. disk full).
    }
    return { manifest, fromCache: false, warnings };
  } catch {
    if (cached !== null) {
      const { manifest, warnings } = parseCatalogManifest(cached.raw);
      if (manifest !== null) return { manifest, fromCache: true, warnings };
    }
    return null;
  }
}
