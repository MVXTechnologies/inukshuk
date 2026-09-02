/**
 * Catalog generator — NRCan CanMatrix 1:50k GeoTIFF source.
 *
 * CanMatrix is the scanned paper archive of the National Topographic System:
 * every 1:50k sheet Canada ever printed, digitised at 300 dpi. It is the only
 * thing that covers eastern Québec (Québec City itself — 021L14 — has no
 * CanTopo GeoPDF), the north, and much of BC. There is **no PDF edition at any
 * resolution**: these are GeoTIFFs or nothing, which is why the client grew a
 * GeoTIFF decoder (`@core/geo/geotiff`) before this crawler was written.
 *
 * Usage:
 *   npx tsx scripts/catalog/fetch-canmatrix.ts [quad...] [--refresh]
 *
 * Shape, and how it differs from {@link file://./fetch-cantopo.ts}:
 *
 * - **Same crawl discipline.** Quads are discovered from the published index,
 *   not hardcoded; extents come from NRCan's `nts_snrc.kmz` sheet index (the
 *   grid formula in `@core/catalog/nts` is only the fallback, and it gives up
 *   at 60°N where two fifths of CanMatrix lives); HEADs run at modest
 *   concurrency with backoff and land in a resumable cache under
 *   `scripts/catalog/.cache/`.
 * - **CanTopo wins.** Every item carries `coverageKey`/`sourceRank` (see
 *   `@core/catalog/coverage`), so where both series publish a sheet the build
 *   keeps the modern GeoPDF and drops the scan. The user never sees two rows
 *   for one sheet. Those fields are generator-only and are stripped before
 *   publishing.
 * - **The titles say "scanned".** A CanMatrix sheet can be decades old. Its
 *   title names the series and the word "scanned" so nobody downloads a 1970s
 *   printing thinking it is current.
 *
 * Output: scripts/catalog/fragments/nrcan-canmatrix.json
 *
 * Licence: Open Government Licence – Canada; we link to NRCan's files
 * (attribution in the source record below), we do not rehost them.
 */
import { unzipSync } from 'fflate';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ntsCoverageKey, SOURCE_RANK_CANMATRIX } from '../../src/core/catalog/coverage';
import { ntsSheetBbox } from '../../src/core/catalog/nts';
import { parseNtsIndexKml, type NtsIndexEntry } from '../../src/core/catalog/ntsIndex';
import type { CatalogBbox, CatalogItem, CatalogSource } from '../../src/core/catalog/schema';

const BASE = 'https://ftp.maps.canada.ca/pub/nrcan_rncan/raster/canmatrix/50k_300dpi';
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
const CACHE_FLUSH_EVERY = 250;

const SOURCE: CatalogSource = {
  id: 'nrcan-canmatrix',
  name: 'NRCan CanMatrix (scanned sheets)',
  licence: 'OGL-Canada-2.0',
  attribution: 'Natural Resources Canada',
  homepage:
    'https://natural-resources.canada.ca/science-and-data/science-and-research/earth-sciences/geography/topographic-information/maps/canada-topographic-maps',
};

/** A fragment item plus the build-time-only coverage fields. */
type CanMatrixItem = CatalogItem & { coverageKey: string; sourceRank: number };

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
 * genuinely absent (404) or when every attempt failed, so one bad sheet never
 * aborts a 12 000-sheet crawl.
 */
async function fetchWithRetry(url: string, method: 'GET' | 'HEAD'): Promise<Response | null> {
  for (let attempt = 0; ; attempt++) {
    let reason = '';
    try {
      const res = await fetch(url, { method });
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

/** One published CanMatrix product: a whole sheet, or one half of one. */
interface CanMatrixProduct {
  /** 1:50k sheet id, e.g. "013D04". */
  sheet: string;
  /** "E" or "W" for a sheet printed as two halves; null for a whole sheet. */
  half: 'E' | 'W' | null;
  url: string;
}

/**
 * CanMatrix zips on a directory index page. Almost every sheet is one file,
 * `canmatrix_021l14_tif.zip`. A few dozen sheets were printed as two halves
 * and are published as `canmatrix_013d04_e_tif.zip` + `…_w_…` — those are two
 * different maps, not two editions of one, so both are kept.
 */
function listProducts(html: string, dir: string): CanMatrixProduct[] {
  return [...html.matchAll(/href="(canmatrix_(\d{3}[a-p]\d{2})(?:_([ew]))?_tif\.zip)"/g)].flatMap(
    (m) => {
      const [, name, sheet, half] = m;
      if (name === undefined || sheet === undefined) return [];
      return [
        {
          sheet: sheet.toUpperCase(),
          half: half === undefined ? null : (half.toUpperCase() as 'E' | 'W'),
          url: `${BASE}/${dir}/${name}`,
        },
      ];
    },
  );
}

/** Stable per-product key: "013D04" or "013D04-E". */
function productKey(product: CanMatrixProduct): string {
  return product.half === null ? product.sheet : `${product.sheet}-${product.half}`;
}

/**
 * The half of a sheet's extent this product covers. NRCan's sheet index knows
 * whole sheets only, so a half-sheet's extent is the sheet split down the
 * middle meridian — which is exactly what "east half" and "west half" mean on
 * these prints, and what the on-device neatline crop needs to be given.
 */
function halfBbox(bbox: CatalogBbox, half: 'E' | 'W' | null): CatalogBbox {
  if (half === null) return bbox;
  const [west, south, east, north] = bbox;
  const middle = (west + east) / 2;
  return half === 'E' ? [middle, south, east, north] : [west, south, middle, north];
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

/** Every published product under the given quads, by walking the index pages. */
async function discoverProducts(quads: string[]): Promise<CanMatrixProduct[]> {
  const letterDirs = (
    await withConcurrency(
      quads.map((quad) => async () => {
        const html = await fetchText(`${BASE}/${quad}/`);
        if (html === null) {
          console.log(`  ${quad}: no CanMatrix directory — skipped`);
          return [];
        }
        return listLetterDirs(html).map((letter) => `${quad}/${letter}`);
      }),
      LISTING_CONCURRENCY,
    )
  ).flat();
  console.log(`${letterDirs.length} letter directories across ${quads.length} quadrangles`);

  const found = (
    await withConcurrency(
      letterDirs.map((dir) => async () => {
        const html = await fetchText(`${BASE}/${dir}/`);
        return html === null ? [] : listProducts(html, dir);
      }),
      LISTING_CONCURRENCY,
    )
  ).flat();
  console.log(`${found.length} CanMatrix zips listed`);

  // The same product can be listed twice only if a directory is served twice;
  // key by sheet+half so the crawl is idempotent either way.
  const byKey = new Map<string, CanMatrixProduct>();
  for (const product of found)
    if (!byKey.has(productKey(product))) byKey.set(productKey(product), product);
  return [...byKey.values()].sort((a, b) => productKey(a).localeCompare(productKey(b)));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const refresh = args.includes('--refresh');
  const requested = args.filter((a) => !a.startsWith('--'));

  const index = await fetchNtsIndex();
  const withPolygon = [...index.values()].filter((e) => e.bbox !== undefined).length;
  console.log(`NTS index: ${index.size} 1:50k sheets, ${withPolygon} with a polygon`);

  const baseHtml = await fetchText(`${BASE}/`);
  if (baseHtml === null) throw new Error(`could not list ${BASE}/`);
  const published = listQuadDirs(baseHtml);
  const quads = requested.length > 0 ? requested : published;
  console.log(
    requested.length > 0
      ? `crawling ${quads.length} requested quadrangles (${published.length} published)`
      : `discovered ${quads.length} published quadrangles`,
  );

  const products = await discoverProducts(quads);
  const halves = products.filter((p) => p.half !== null).length;
  console.log(`${products.length} products (${halves} of them half-sheets)`);

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const cachePath = join(scriptDir, '.cache', 'nrcan-canmatrix-head.json');
  const cache = refresh ? new Map<string, CachedHead>() : readHeadCache(cachePath);
  const urls = products.map((p) => p.url);
  const cached = urls.filter((url) => cache.has(url)).length;
  console.log(`HEAD cache: ${cached}/${urls.length} already known${refresh ? ' (ignored)' : ''}`);

  let done = 0;
  let failed = 0;
  const metas = await withConcurrency(
    urls.map((url) => async (): Promise<HeadMeta> => {
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
        console.log(`  ${done}/${urls.length} HEADs done (${failed} failed)`);
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
  const items: CanMatrixItem[] = products.map((product, i) => {
    const { sheet, half } = product;
    const entry = index.get(sheet);
    let bbox: CatalogBbox | null = entry?.bbox ?? null;
    if (bbox !== null) fromIndex++;
    else {
      bbox = ntsSheetBbox(sheet);
      if (bbox !== null) fromGrid++;
      else placeless++;
    }
    if (bbox !== null) bbox = halfBbox(bbox, half);
    const toponym = entry?.toponym;
    const named = toponym !== undefined ? titleCaseToponym(toponym) : null;
    // "Québec — CanMatrix 021L14 (scanned)": the toponym to find it by, the
    // sheet id to place it, and the one word that says this is an archival
    // scan of a printed sheet rather than a current map.
    const label = half === null ? `CanMatrix ${sheet}` : `CanMatrix ${sheet} ${half} half`;
    return {
      id: `canmatrix-${productKey(product).toLowerCase().replace('-', '')}`,
      sourceId: SOURCE.id,
      title: named !== null ? `${named} — ${label} (scanned)` : `${label} (scanned)`,
      category: 'topo',
      ...(bbox !== null ? { bbox } : {}),
      format: 'geotiff',
      packaging: 'zip',
      url: product.url,
      lang: 'bilingual',
      coverageKey: ntsCoverageKey(sheet),
      sourceRank: SOURCE_RANK_CANMATRIX,
      ...metas[i],
    };
  });
  console.log(
    `bboxes: ${fromIndex} from the NTS index, ${fromGrid} from the grid formula, ${placeless} unplaceable`,
  );

  const outPath = join(scriptDir, 'fragments', 'nrcan-canmatrix.json');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify({ sources: [SOURCE], items }, null, 2)}\n`);
  console.log(`wrote ${outPath} (${items.length} items)`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
