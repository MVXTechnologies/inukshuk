/**
 * Catalog generator — NRCan CanTopo 1:50k GeoPDF source.
 *
 * Crawls the (legacy, updates-not-planned) CanTopo HTTP tree, HEADs every zip
 * for its real size + revision date, resolves each sheet's toponym **and
 * extent** from NRCan's nts_snrc.kmz index, and writes a normalized fragment
 * for build-manifest.ts. Runs in Node (CI or a dev machine), never on phones —
 * devices only read the merged manifest.
 *
 * Usage:
 *   npx tsx scripts/catalog/fetch-cantopo.ts [quad...] [--refresh]
 *
 * **Quads are discovered, not listed.** The crawler reads the published
 * directory index at {@link BASE} and takes every primary quadrangle it finds
 * (64 of them, ~2 200 sheets, coast to coast to Ellesmere Island). A hardcoded
 * quad list is what once limited this catalog to 128 Maritimes/Ontario sheets;
 * pass quads on the command line only to re-run a few directories by hand.
 *
 * **Extents come from the index, not from the grid formula.** `ntsSheetBbox`
 * models only the regular southern zone and returns null at 60°N and above,
 * where three quarters of CanTopo's sheets live — an unplaceable item lands in
 * the catalog's `nogeo` shard and never shows up near anywhere. So the sheet
 * polygons in nts_snrc.kmz are the primary source (see `@core/catalog/ntsIndex`)
 * and the computed grid is only the fallback for a sheet the index omits.
 *
 * **Politeness.** ~64 + ~700 directory listings and ~2 200 HEADs against one
 * public FTP mirror: modest concurrency, retry with backoff, per-sheet failures
 * that never abort the crawl, and a HEAD cache under `scripts/catalog/.cache/`
 * so an interrupted run resumes instead of re-asking for everything.
 *
 * Output: scripts/catalog/fragments/nrcan-cantopo.json
 *
 * Licence: CanTopo is Open Government Licence – Canada; we link to NRCan's
 * files (attribution in the source record below), we do not rehost them.
 */
import { unzipSync } from 'fflate';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ntsSheetBbox } from '../../src/core/catalog/nts';
import { parseNtsIndexKml, type NtsIndexEntry } from '../../src/core/catalog/ntsIndex';
import type { CatalogBbox, CatalogItem, CatalogSource } from '../../src/core/catalog/schema';

const BASE = 'https://ftp.maps.canada.ca/pub/nrcan_rncan/raster/cantopo/50k_geopdf';
const NTS_INDEX_KMZ = 'https://ftp.maps.canada.ca/pub/nrcan_rncan/vector/index/nts_snrc.kmz';

/** Parallel directory listings. Keep it low — one public mirror serves these. */
const LISTING_CONCURRENCY = 4;
/** Parallel HEADs. Same. */
const HEAD_CONCURRENCY = 4;
/** Backoff between attempts; a request gets 1 + RETRY_DELAYS_MS.length tries. */
const RETRY_DELAYS_MS = [750, 3000];
/** Re-HEAD a cached zip after this long, so reissued sheets don't go stale. */
const CACHE_TTL_DAYS = 30;
/** Flush the HEAD cache to disk every N completions, so a kill still resumes. */
const CACHE_FLUSH_EVERY = 100;

const SOURCE: CatalogSource = {
  id: 'nrcan-cantopo',
  name: 'NRCan CanTopo',
  licence: 'OGL-Canada-2.0',
  attribution: 'Natural Resources Canada',
  homepage:
    'https://natural-resources.canada.ca/science-and-data/science-and-research/earth-sciences/geography/topographic-information/maps/canada-topographic-maps',
};

interface HeadMeta {
  sizeBytes?: number;
  updatedAt?: string;
}

/** One cached HEAD, with the time it was taken so it can expire. */
interface CachedHead extends HeadMeta {
  fetchedAt: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch with backoff. Returns null instead of throwing when the resource is
 * genuinely absent (404 — plenty of quads have no GeoPDF directory) or when
 * every attempt failed, so one bad sheet never aborts a 2 000-sheet crawl.
 */
async function fetchWithRetry(url: string, method: 'GET' | 'HEAD'): Promise<Response | null> {
  for (let attempt = 0; ; attempt++) {
    let res: Response | null = null;
    let reason = '';
    try {
      res = await fetch(url, { method });
      if (res.ok) return res;
      // 4xx other than 429 is a settled answer: retrying cannot change it.
      if (res.status < 500 && res.status !== 429) return null;
      reason = `HTTP ${res.status}`;
    } catch (err: unknown) {
      reason = err instanceof Error ? err.message : String(err);
    }
    const delay = RETRY_DELAYS_MS[attempt];
    if (delay === undefined) {
      console.warn(`  ${method} ${url} failed (${reason}) — giving up`);
      return null;
    }
    await sleep(delay);
  }
}

async function fetchText(url: string): Promise<string | null> {
  const res = await fetchWithRetry(url, 'GET');
  return res === null ? null : res.text();
}

/** Primary-quadrangle directories ("021/", "340/") on the base index page. */
function listQuadDirs(html: string): string[] {
  return [...html.matchAll(/href="(\d{3})\/"/g)].flatMap((m) => (m[1] !== undefined ? [m[1]] : []));
}

/** 1:250k letter directories ("a/" … "p/") inside a quadrangle. */
function listLetterDirs(html: string): string[] {
  return [...html.matchAll(/href="([a-p])\/"/g)].flatMap((m) => (m[1] !== undefined ? [m[1]] : []));
}

/** CanTopo zip names from a directory index page. */
function listZips(html: string): string[] {
  return [...html.matchAll(/href="(cantopo_\d{3}[a-p]\d{2}_geopdf\.zip)"/g)].flatMap((m) =>
    m[1] !== undefined ? [m[1]] : [],
  );
}

function headMetaFrom(res: Response): HeadMeta {
  const length = Number(res.headers.get('content-length'));
  const lastModified = res.headers.get('last-modified');
  const modified = lastModified !== null ? new Date(lastModified) : null;
  return {
    ...(Number.isFinite(length) && length > 0 ? { sizeBytes: length } : {}),
    ...(modified !== null && !Number.isNaN(modified.getTime())
      ? { updatedAt: modified.toISOString().slice(0, 10) }
      : {}),
  };
}

/** "SAINT-RAYMOND" → "Saint-Raymond" (good enough for QC toponyms). */
function titleCaseToponym(name: string): string {
  return name
    .toLowerCase()
    .replace(/(^|[\s\-–'’(])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}

/** Download nts_snrc.kmz and read its 1:50k placemarks (toponym + polygon). */
async function fetchNtsIndex(): Promise<Map<string, NtsIndexEntry>> {
  const res = await fetchWithRetry(NTS_INDEX_KMZ, 'GET');
  if (res === null) throw new Error(`could not fetch ${NTS_INDEX_KMZ}`);
  const kmz = new Uint8Array(await res.arrayBuffer());
  const files = unzipSync(kmz, { filter: (f) => f.name.endsWith('.kml') });
  const kmlBytes = Object.values(files)[0];
  if (kmlBytes === undefined) throw new Error('nts_snrc.kmz contains no KML');
  return parseNtsIndexKml(new TextDecoder('utf-8').decode(kmlBytes));
}

/** Run `tasks` with at most `limit` in flight (crawl politely). */
async function withConcurrency<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array<T>(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    for (;;) {
      const index = next++;
      const task = tasks[index];
      if (task === undefined) return;
      results[index] = await task();
    }
  });
  await Promise.all(workers);
  return results;
}

/* ------------------------------------------------------------ HEAD cache -- */

function readHeadCache(path: string): Map<string, CachedHead> {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, CachedHead>;
    const cutoff = Date.now() - CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;
    const cache = new Map<string, CachedHead>();
    for (const [url, entry] of Object.entries(raw)) {
      const at = Date.parse(entry.fetchedAt ?? '');
      if (Number.isFinite(at) && at >= cutoff) cache.set(url, entry);
    }
    return cache;
  } catch {
    return new Map();
  }
}

function writeHeadCache(path: string, cache: Map<string, CachedHead>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(Object.fromEntries([...cache].sort()), null, 0)}\n`);
}

/* ------------------------------------------------------------------ main -- */

/** Every zip URL under the given quads, discovered by walking the index pages. */
async function discoverZipUrls(quads: string[]): Promise<string[]> {
  const letterDirs = (
    await withConcurrency(
      quads.map((quad) => async () => {
        const html = await fetchText(`${BASE}/${quad}/`);
        if (html === null) {
          console.log(`  ${quad}: no GeoPDF directory — skipped`);
          return [];
        }
        return listLetterDirs(html).map((letter) => `${quad}/${letter}`);
      }),
      LISTING_CONCURRENCY,
    )
  ).flat();
  console.log(`${letterDirs.length} letter directories across ${quads.length} quadrangles`);

  const urls = (
    await withConcurrency(
      letterDirs.map((dir) => async () => {
        const html = await fetchText(`${BASE}/${dir}/`);
        if (html === null) return [];
        return listZips(html).map((zip) => `${BASE}/${dir}/${zip}`);
      }),
      LISTING_CONCURRENCY,
    )
  ).flat();
  return [...new Set(urls)].sort();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const refresh = args.includes('--refresh');
  const requested = args.filter((a) => !a.startsWith('--'));

  const index = await fetchNtsIndex();
  const withBbox = [...index.values()].filter((e) => e.bbox !== undefined).length;
  console.log(`NTS index: ${index.size} 1:50k sheets, ${withBbox} with a polygon`);

  const baseHtml = await fetchText(`${BASE}/`);
  if (baseHtml === null) throw new Error(`could not list ${BASE}/`);
  const published = listQuadDirs(baseHtml);
  const quads = requested.length > 0 ? requested : published;
  console.log(
    requested.length > 0
      ? `crawling ${quads.length} requested quadrangles (${published.length} published)`
      : `discovered ${quads.length} published quadrangles`,
  );

  const zipUrls = await discoverZipUrls(quads);
  console.log(`${zipUrls.length} CanTopo zips found`);

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const cachePath = join(scriptDir, '.cache', 'nrcan-cantopo-head.json');
  const cache = refresh ? new Map<string, CachedHead>() : readHeadCache(cachePath);
  const cached = zipUrls.filter((url) => cache.has(url)).length;
  console.log(
    `HEAD cache: ${cached}/${zipUrls.length} already known${refresh ? ' (ignored)' : ''}`,
  );

  let done = 0;
  let failed = 0;
  const metas = await withConcurrency(
    zipUrls.map((url) => async (): Promise<HeadMeta> => {
      const hit = cache.get(url);
      if (hit !== undefined) {
        const { fetchedAt: _fetchedAt, ...meta } = hit;
        return meta;
      }
      const res = await fetchWithRetry(url, 'HEAD');
      if (res === null) {
        // Keep the sheet: the download URL is still valid, we just cannot show
        // its size. Not cached, so the next run retries it.
        failed++;
        return {};
      }
      const meta = headMetaFrom(res);
      cache.set(url, { ...meta, fetchedAt: new Date().toISOString() });
      if (++done % CACHE_FLUSH_EVERY === 0) {
        writeHeadCache(cachePath, cache);
        console.log(`  ${done} HEADs done (${failed} failed)`);
      }
      return meta;
    }),
    HEAD_CONCURRENCY,
  );
  writeHeadCache(cachePath, cache);
  console.log(`${done} HEADs performed, ${failed} failed, cache at ${cachePath}`);

  let fromIndex = 0;
  let fromGrid = 0;
  let placeless = 0;
  const items: CatalogItem[] = [];
  zipUrls.forEach((url, i) => {
    const sheetLower = /cantopo_(\d{3}[a-p]\d{2})_geopdf\.zip$/.exec(url)?.[1];
    if (sheetLower === undefined) return;
    const sheet = sheetLower.toUpperCase();
    const entry = index.get(sheet);
    let bbox: CatalogBbox | null = entry?.bbox ?? null;
    if (bbox !== null) fromIndex++;
    else {
      bbox = ntsSheetBbox(sheet);
      if (bbox !== null) fromGrid++;
      else placeless++;
    }
    const toponym = entry?.toponym;
    items.push({
      id: `cantopo-${sheetLower}`,
      sourceId: SOURCE.id,
      title:
        toponym !== undefined
          ? `${titleCaseToponym(toponym)} — CanTopo ${sheet}`
          : `CanTopo ${sheet}`,
      category: 'topo',
      ...(bbox !== null ? { bbox } : {}),
      format: 'geopdf',
      packaging: 'zip',
      url,
      lang: 'bilingual',
      ...metas[i],
    });
  });
  items.sort((a, b) => a.id.localeCompare(b.id));
  console.log(
    `bboxes: ${fromIndex} from the NTS index, ${fromGrid} from the grid formula, ${placeless} unplaceable`,
  );

  const outPath = join(scriptDir, 'fragments', 'nrcan-cantopo.json');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify({ sources: [SOURCE], items }, null, 2)}\n`);
  console.log(`wrote ${outPath} (${items.length} items)`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
