import { resolveCatalogUrl } from '@core/catalog/shard';

import { catalogIndexBaseUrl, catalogIndexUrls } from './catalogCache';
import * as storage from './storage';

/**
 * Fetch + on-device cache of the explorer's link-out collections (#447):
 * `collections.json`, published next to the catalog index (so a build pointed
 * at a fixture or dev catalog reads that catalog's copy). Returns the RAW
 * document — parsing is the caller's (`@core/catalog/collections`).
 *
 * Same cache discipline as `catalogCache`: fresh copy served for a day, the
 * network past that, the stale copy when the network fails. Never throws;
 * null means "no collections anywhere" and the explorer simply hides them.
 *
 * Read next to the index the store loaded (v3, or v2 after a fallback), then
 * next to every other edition this build may read, so an unreachable v3 does
 * not hide the collections either.
 */

export const COLLECTIONS_FILE_NAME = 'collections.json';
const CACHE_FILE = 'catalog-collections.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

interface CachedCollections {
  fetchedAt: number;
  url: string;
  raw: unknown;
}

function isCached(value: unknown): value is CachedCollections {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as CachedCollections).fetchedAt === 'number' &&
    typeof (value as CachedCollections).url === 'string' &&
    'raw' in value
  );
}

/** Where this build's collections document lives, or null if the index URL is unusable. */
export function catalogCollectionsUrl(): string | null {
  return resolveCatalogUrl(catalogIndexBaseUrl(), COLLECTIONS_FILE_NAME);
}

/** Every collections URL worth trying, best first, without duplicates. */
function candidateUrls(): string[] {
  const urls = [catalogIndexBaseUrl(), ...catalogIndexUrls()]
    .map((indexUrl) => resolveCatalogUrl(indexUrl, COLLECTIONS_FILE_NAME))
    .filter((url): url is string => url !== null);
  return [...new Set(urls)];
}

export async function loadCatalogCollectionsRaw(): Promise<unknown> {
  const urls = candidateUrls();
  if (urls.length === 0) return null;

  let cached: CachedCollections | null = null;
  try {
    const raw = await storage.readJson<unknown>(CACHE_FILE);
    if (isCached(raw) && urls.includes(raw.url)) cached = raw;
  } catch {
    // Unreadable cache: behave like a first launch.
  }
  if (cached !== null && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.raw;

  for (const url of urls) {
    const raw = await fetchCollections(url);
    if (raw === undefined) continue;
    try {
      storage.writeJson(CACHE_FILE, { fetchedAt: Date.now(), url, raw });
    } catch {
      // A failed cache write must not fail the load.
    }
    return raw;
  }
  return cached?.raw ?? null;
}

/** One network attempt; undefined on any failure. */
async function fetchCollections(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`collections fetch failed: HTTP ${res.status}`);
    return (await res.json()) as unknown;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
