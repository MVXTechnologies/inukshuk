import Constants from 'expo-constants';

import {
  parseTrailDetail,
  parseTrailIndex,
  type TrailDetail,
  type TrailIndex,
} from '@core/trails/schema';

import { TILE_HOST } from './basemapTiles';
import * as storage from './storage';

/**
 * Fetch + on-device cache for the long-distance trails (#467), served by the
 * tile Worker from the monthly OSM build (`infra/tiles/nas/trails.sh`):
 *
 * - `{base}/index.json` — every trail, compact; cached in the document
 *   directory for a week and used stale whenever the network fails;
 * - `{base}/d/{version}/{id}.json` — one trail's geometry and stages, fetched
 *   when its page opens and kept (a trail you looked at, or downloaded the
 *   corridor of, keeps its page offline).
 *
 * Never throws: null means "not available" and Explore hides the section —
 * which is also what happens before the data is first deployed.
 *
 * `extra.longTrailsUrl` overrides the base (a loopback server for e2e / QA).
 */

const INDEX_CACHE_FILE = 'long-trails-index.json';
const INDEX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;

export const DEFAULT_LONG_TRAILS_URL = `${TILE_HOST}/trails/v1`;

export function longTrailsBaseUrl(): string {
  const value: unknown = Constants.expoConfig?.extra?.longTrailsUrl;
  const base = typeof value === 'string' && value !== '' ? value : DEFAULT_LONG_TRAILS_URL;
  return base.replace(/\/+$/, '');
}

interface Cached {
  fetchedAt: number;
  url: string;
  raw: unknown;
}

function isCached(v: unknown): v is Cached {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as Cached).fetchedAt === 'number' &&
    typeof (v as Cached).url === 'string' &&
    'raw' in v
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
    if (!res.ok) throw new Error(`trails fetch failed: HTTP ${res.status}`);
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

async function readCache(file: string, url: string): Promise<Cached | null> {
  try {
    const raw = await storage.readJson<unknown>(file);
    return isCached(raw) && raw.url === url ? raw : null;
  } catch {
    return null;
  }
}

function writeCache(file: string, url: string, raw: unknown): void {
  try {
    storage.writeJson(file, { fetchedAt: Date.now(), url, raw } satisfies Cached);
  } catch {
    // A failed cache write must not fail the load (disk full).
  }
}

export interface TrailIndexLoad {
  index: TrailIndex;
  fromCache: boolean;
}

/** The trail index: fresh cache, else network, else any cached copy; null when none. */
export async function loadTrailIndex(options?: {
  force?: boolean;
}): Promise<TrailIndexLoad | null> {
  const url = `${longTrailsBaseUrl()}/index.json`;
  const cached = await readCache(INDEX_CACHE_FILE, url);
  if (cached !== null && options?.force !== true && Date.now() - cached.fetchedAt < INDEX_TTL_MS) {
    const index = parseTrailIndex(cached.raw).value;
    if (index !== null) return { index, fromCache: true };
  }
  try {
    const raw = await fetchJson(url);
    const index = parseTrailIndex(raw).value;
    if (index === null) throw new Error('unusable trail index');
    writeCache(INDEX_CACHE_FILE, url, raw);
    return { index, fromCache: false };
  } catch {
    const index = cached !== null ? parseTrailIndex(cached.raw).value : null;
    return index !== null ? { index, fromCache: true } : null;
  }
}

const detailFile = (id: string) => `long-trail-${id.replace(/[^A-Za-z0-9_-]/g, '_')}.json`;

/**
 * One trail's detail for the index's details version: the cached copy when
 * it is that version, else the network, else any cached copy (an older build
 * of the same trail beats no page offline).
 */
export async function loadTrailDetail(id: string, version: string): Promise<TrailDetail | null> {
  const url = `${longTrailsBaseUrl()}/d/${encodeURIComponent(version)}/${encodeURIComponent(id)}.json`;
  let cached: Cached | null = null;
  try {
    const raw = await storage.readJson<unknown>(detailFile(id));
    if (isCached(raw)) cached = raw;
  } catch {
    // Unreadable: refetch.
  }
  if (cached !== null && cached.url === url) {
    const detail = parseTrailDetail(cached.raw);
    if (detail !== null) return detail;
  }
  try {
    const raw = await fetchJson(url);
    const detail = parseTrailDetail(raw);
    if (detail === null) throw new Error('unusable trail detail');
    writeCache(detailFile(id), url, raw);
    return detail;
  } catch {
    return cached !== null ? parseTrailDetail(cached.raw) : null;
  }
}
