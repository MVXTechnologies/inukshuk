import Constants from 'expo-constants';
import { Directory, File, Paths } from 'expo-file-system';

import { parseClimbingCoverage, type ClimbingCoverage } from '@core/climbing/coverage';
import { parseCragDetail, type CragDetail } from '@core/climbing/detail';
import { parseCragIndex, type CragIndex } from '@core/climbing/search';
import { emptyClimbingDoc, migrateClimbingDoc, type ClimbingDoc } from '@core/climbing/saved';

import { TILE_HOST } from './basemapTiles';
import * as storage from './storage';

/**
 * The climbing-crags extension's network and files (DESIGN §6.5):
 *
 * - tiles `crags.pmtiles` at /crags/{z}/{x}/{y}.mvt (generic archive route),
 *   coverage + topo version in its TileJSON (/crags.json);
 * - one topo per crag at /climbing/v1/d/{version}/{uid}.json, the world's
 *   search index at /climbing/v1/index.json (`infra/tiles/nas/climbing.sh`);
 * - on the phone: `climbing.json` (the saved list, `@core/climbing/saved`),
 *   `climbing/{uid}.json` (each saved topo, verbatim), `climbing/attachments/`
 *   ("Attach my topo": local only, never synced), and `climbing-cache/` (topos
 *   looked at online, so a crag you opened keeps its page offline).
 *
 * Network calls never throw: null means "not available".
 */

// `v` versions the TILE SCHEMA (`@core/climbing/crag`): bump it when the build's keys change.
export const DEFAULT_CRAG_TILES_URL = `${TILE_HOST}/crags/{z}/{x}/{y}.mvt?v=1`;

/**
 * Whether `crags.pmtiles` is on the tile host. While false nothing climbing
 * is offered (no Explore layer, no extension). OTA-updatable.
 */
export const CRAG_TILES_PUBLISHED = true;

export function cragTilesUrl(): string | null {
  const value: unknown = Constants.expoConfig?.extra?.cragTilesUrl;
  if (typeof value === 'string' && value !== '') return value;
  return CRAG_TILES_PUBLISHED ? DEFAULT_CRAG_TILES_URL : null;
}

export function climbingBaseUrl(): string {
  const value: unknown = Constants.expoConfig?.extra?.climbingUrl;
  const base = typeof value === 'string' && value !== '' ? value : `${TILE_HOST}/climbing/v1`;
  return base.replace(/\/+$/, '');
}

const FETCH_TIMEOUT_MS = 20_000;
const COVERAGE_FILE = 'climbing-coverage.json';
const COVERAGE_TTL_MS = 12 * 60 * 60 * 1000;
const INDEX_FILE = 'climbing-index.json';
const INDEX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DOC_FILE = 'climbing.json';
const SAVED_DIR = 'climbing';
const CACHE_DIR = 'climbing-cache';
export const ATTACHMENTS_DIR = 'climbing/attachments';

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

interface Cached {
  fetchedAt: number;
  raw: unknown;
}

function isCached(v: unknown): v is Cached {
  return (
    typeof v === 'object' && v !== null && typeof (v as Cached).fetchedAt === 'number' && 'raw' in v
  );
}

async function readCached(file: string): Promise<Cached | null> {
  try {
    const raw = await storage.readJson<unknown>(file);
    return isCached(raw) ? raw : null;
  } catch {
    return null;
  }
}

function writeCached(file: string, raw: unknown): void {
  try {
    storage.writeJson(file, { fetchedAt: Date.now(), raw } satisfies Cached);
  } catch {
    // A failed cache write must not fail the load (disk full).
  }
}

/** Coverage and the topo version: fresh cache, else network, else any cached copy. */
export async function loadClimbingCoverage(options?: {
  force?: boolean;
}): Promise<ClimbingCoverage | null> {
  const cached = await readCached(COVERAGE_FILE);
  if (cached && !options?.force && Date.now() - cached.fetchedAt < COVERAGE_TTL_MS) {
    const c = parseClimbingCoverage(cached.raw);
    if (c) return c;
  }
  try {
    const raw = await fetchJson(`${TILE_HOST}/crags.json`);
    const c = parseClimbingCoverage(raw);
    if (c === null) throw new Error('unusable coverage');
    writeCached(COVERAGE_FILE, raw);
    return c;
  } catch {
    return cached ? parseClimbingCoverage(cached.raw) : null;
  }
}

/** The world's crag index (search): fresh cache, else network, else any cached copy. */
export async function loadCragIndex(): Promise<CragIndex | null> {
  const cached = await readCached(INDEX_FILE);
  if (cached && Date.now() - cached.fetchedAt < INDEX_TTL_MS) {
    const idx = parseCragIndex(cached.raw);
    if (idx) return idx;
  }
  try {
    const raw = await fetchJson(`${climbingBaseUrl()}/index.json`);
    const idx = parseCragIndex(raw);
    if (idx === null) throw new Error('unusable index');
    writeCached(INDEX_FILE, raw);
    return idx;
  } catch {
    return cached ? parseCragIndex(cached.raw) : null;
  }
}

function safeName(uid: string): string {
  return uid.replace(/[^A-Za-z0-9_-]/g, '_');
}

function dir(path: string): Directory {
  const d = new Directory(Paths.document, path);
  if (!d.exists) d.create({ intermediates: true });
  return d;
}

export interface TopoLoad {
  detail: CragDetail;
  raw: unknown;
  /** Where it came from: the saved copy, the network, or the look-ahead cache. */
  from: 'saved' | 'network' | 'cache';
}

/** A saved topo (downloaded crag), or null. */
export async function readSavedTopo(uid: string): Promise<TopoLoad | null> {
  try {
    const f = new File(dir(SAVED_DIR), `${safeName(uid)}.json`);
    if (!f.exists) return null;
    const raw = JSON.parse(await f.text()) as unknown;
    const detail = parseCragDetail(raw);
    return detail ? { detail, raw, from: 'saved' } : null;
  } catch {
    return null;
  }
}

/** Save a topo (verbatim); returns its size in bytes. */
export function writeSavedTopo(uid: string, raw: unknown): number {
  const text = JSON.stringify(raw);
  const f = new File(dir(SAVED_DIR), `${safeName(uid)}.json`);
  if (f.exists) f.delete();
  f.create();
  f.write(text);
  return text.length;
}

export function deleteSavedTopo(uid: string): void {
  try {
    const f = new File(dir(SAVED_DIR), `${safeName(uid)}.json`);
    if (f.exists) f.delete();
  } catch {
    // Best effort.
  }
}

/**
 * A crag's topo from the network (the current version), cached for offline
 * reading; else the cached copy (an older build beats no page); else null.
 */
export async function fetchTopo(uid: string): Promise<TopoLoad | null> {
  const cacheFile = `${CACHE_DIR}/${safeName(uid)}.json`;
  dir(CACHE_DIR);
  const cached = await readCached(cacheFile);
  const coverage = await loadClimbingCoverage();
  if (coverage !== null) {
    const url = `${climbingBaseUrl()}/d/${encodeURIComponent(coverage.version)}/${encodeURIComponent(uid)}.json`;
    try {
      const raw = await fetchJson(url);
      const detail = parseCragDetail(raw);
      if (detail) {
        writeCached(cacheFile, raw);
        return { detail, raw, from: 'network' };
      }
    } catch {
      // Fall through to the cache.
    }
  }
  const detail = cached ? parseCragDetail(cached.raw) : null;
  return detail && cached ? { detail, raw: cached.raw, from: 'cache' } : null;
}

/** The saved topo when there is one, else the network / look-ahead cache. */
export async function loadTopo(uid: string): Promise<TopoLoad | null> {
  return (await readSavedTopo(uid)) ?? (await fetchTopo(uid));
}

export async function readClimbingDoc(): Promise<ClimbingDoc> {
  try {
    return migrateClimbingDoc(await storage.readJson<unknown>(DOC_FILE));
  } catch {
    return emptyClimbingDoc();
  }
}

export function writeClimbingDoc(doc: ClimbingDoc): void {
  storage.writeJson(DOC_FILE, doc);
}

/** Copy a picked photo or PDF into the crag's local attachments; document-relative path + size. */
export async function importAttachment(
  sourceUri: string,
  id: string,
  ext: string,
): Promise<{ path: string; bytes: number }> {
  const clean = ext.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin';
  const dest = new File(dir(ATTACHMENTS_DIR), `${id}.${clean}`);
  if (dest.exists) dest.delete();
  await new File(storage.resolveDocumentPath(sourceUri)).copy(dest);
  return { path: storage.toDocumentPath(dest.uri), bytes: dest.size ?? 0 };
}

export function attachmentUri(path: string): string {
  return storage.resolveDocumentPath(path);
}

export function deleteAttachment(path: string): void {
  try {
    storage.deleteFileAt(path);
  } catch {
    // Best effort.
  }
}
