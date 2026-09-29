/**
 * Catalog generator — USDA Forest Service FSTopo source.
 *
 * FSTopo is the Forest Service's own 7.5-minute topographic series: 1:24 000
 * over the lower 48 and Puerto Rico, 1:25 000 in Alaska, covering every
 * National Forest. Each sheet is a genuine geospatial PDF (OGC `/VP` +
 * `/Measure`, three viewports like US Topo — our `parseGeoPdf` +
 * `primaryGeoreferenceForPage` place it; verified on sample sheets, see
 * docs/CATALOG-SOURCES.md §1.4). ~2–4 MB each, a tenth of a US Topo quad,
 * and drawn with Forest Service roads, trails and ownership.
 *
 * **Enumeration.** The Forest Service's map portal is an ArcGIS Experience app
 * whose "24K FSTopo" page reads a public, key-free feature layer:
 *
 *   https://services1.arcgis.com/gGHDlz6USftL5Pau/arcgis/rest/services/FSTopo_Index_GTAC/FeatureServer/0
 *
 * (~18 200 cells with the quad polygon, name, state and `secoord` id). The
 * app's popup builds the download link from `secoord`:
 *
 *   https://data.fs.usda.gov/geodata/rastergateway/downloadMap.php?mapID={secoord}&mapType=pdf&seriesType=FSTopo
 *
 * which answers **302** to the static PDF when the sheet exists and **204**
 * when it does not (a few hundred cells, mostly Alaska). So each cell costs
 * one redirect lookup plus one HEAD on the file for its real size and date;
 * both are cached under `scripts/catalog/.cache/` (gitignored, 30-day TTL) so
 * a re-run resumes instead of re-asking. We publish the resolved static URL —
 * the same file the portal hands a browser; we never rehost.
 *
 * Licence: public domain (US Government work; the FGDC record's access and use
 * constraints are "None"). Attribution carried as a courtesy.
 *
 * Usage:
 *   npx tsx scripts/catalog/fetch-fstopo.ts [--limit N] [--refresh]
 *
 * Output: scripts/catalog/fragments/usfs-fstopo.json (gitignored: rebuilt from
 * the index + cached HEADs in minutes, and it would duplicate the shards in git).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CatalogBbox, CatalogItem, CatalogSource } from '../../src/core/catalog/schema';
import { JsonCache, mapPool, politeFetch, sleep } from './http';

const INDEX_LAYER =
  'https://services1.arcgis.com/gGHDlz6USftL5Pau/arcgis/rest/services/FSTopo_Index_GTAC/FeatureServer/0';
const DOWNLOAD = 'https://data.fs.usda.gov/geodata/rastergateway/downloadMap.php';

/** One public Forest Service host serves every file: stay well under 8 in flight. */
const HEAD_CONCURRENCY = 6;
const PAGE_SIZE = 1000;
const CACHE_TTL_DAYS = 30;

const SOURCE: CatalogSource = {
  id: 'usfs-fstopo',
  name: 'USDA Forest Service FSTopo',
  licence: 'Public domain (US Government)',
  attribution: 'USDA Forest Service',
  homepage: 'https://data.fs.usda.gov/geodata/vector/index.php',
};

interface IndexFeature {
  attributes: {
    cell_name?: string | null;
    quad_name?: string | null;
    primary_state?: string | null;
    state_alpha?: string | null;
    secoord?: number | null;
    map_scale?: string | null;
  };
  geometry?: { rings?: number[][][] };
}

/** What we learned about one cell's file: absent (204/404) or its metadata. */
interface Resolved {
  fetchedAt: string;
  /** Every attempt failed (5xx/network) — retried on the next run, never cached as absent. */
  failed?: boolean;
  url?: string;
  sizeBytes?: number;
  updatedAt?: string;
}

async function fetchIndex(limit: number): Promise<IndexFeature[]> {
  const features: IndexFeature[] = [];
  for (let offset = 0; features.length < limit; offset += PAGE_SIZE) {
    const params = new URLSearchParams({
      where: '1=1',
      outFields: 'cell_name,quad_name,primary_state,state_alpha,secoord,map_scale',
      returnGeometry: 'true',
      outSR: '4326',
      geometryPrecision: '6',
      orderByFields: 'objectid',
      resultOffset: String(offset),
      resultRecordCount: String(PAGE_SIZE),
      f: 'json',
    });
    const res = await politeFetch(`${INDEX_LAYER}/query?${params.toString()}`);
    if (res === null || !res.ok) throw new Error(`index page at ${offset} failed`);
    const page = (await res.json()) as { features?: IndexFeature[]; error?: unknown };
    if (page.error !== undefined) throw new Error(`index error: ${JSON.stringify(page.error)}`);
    const batch = page.features ?? [];
    features.push(...batch);
    console.log(`  index: ${features.length} cells`);
    if (batch.length < PAGE_SIZE) break;
    await sleep(300);
  }
  return features.slice(0, limit);
}

function ringBbox(rings: number[][][] | undefined): CatalogBbox | null {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const ring of rings ?? []) {
    for (const [x, y] of ring as [number, number][]) {
      w = Math.min(w, x);
      e = Math.max(e, x);
      s = Math.min(s, y);
      n = Math.max(n, y);
    }
  }
  if (!Number.isFinite(w) || w >= e || s >= n) return null;
  // The layer's vertices sit a hair (1e-5°) off the 7.5' grid; snap to it so
  // bboxes match the sheet exactly and serialize compactly.
  const snap = (v: number): number => Math.round(v * 8000) / 8000;
  return [snap(w), snap(s), snap(e), snap(n)];
}

/** Follow the portal's download link by hand: 302 → the file, 204 → no sheet. */
async function resolveSheet(secoord: number): Promise<Resolved> {
  const fetchedAt = new Date().toISOString();
  const link = `${DOWNLOAD}?mapID=${secoord}&mapType=pdf&seriesType=FSTopo`;
  const hop = await politeFetch(link, { method: 'HEAD', redirect: 'manual' });
  if (hop === null) return { fetchedAt, failed: true };
  const location = hop.headers.get('location');
  if (hop.status < 300 || hop.status >= 400 || !location) return { fetchedAt };
  // The Location header carries raw spaces ("FSTopo Bear Creek 302209507.pdf").
  const url = encodeURI(decodeURI(new URL(location, link).toString()));
  const head = await politeFetch(url, { method: 'HEAD' });
  if (head === null) return { fetchedAt, failed: true };
  if (!head.ok) return { fetchedAt };
  const length = Number(head.headers.get('content-length'));
  const modified = new Date(head.headers.get('last-modified') ?? '');
  return {
    fetchedAt,
    url,
    ...(Number.isFinite(length) && length > 0 ? { sizeBytes: length } : {}),
    ...(!Number.isNaN(modified.getTime())
      ? { updatedAt: modified.toISOString().slice(0, 10) }
      : {}),
  };
}

function clean(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

async function main(): Promise<void> {
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1] ?? '') : Infinity;
  const refresh = process.argv.includes('--refresh');

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const cache = new JsonCache<Resolved>(join(scriptDir, '.cache', 'fstopo-heads.json'));

  console.log(`GET ${INDEX_LAYER}`);
  const features = await fetchIndex(limit);

  const cells = features.flatMap((f) => {
    const secoord = f.attributes.secoord;
    const bbox = ringBbox(f.geometry?.rings);
    return typeof secoord === 'number' && secoord > 0 && bbox !== null
      ? [{ attributes: f.attributes, secoord, bbox }]
      : [];
  });
  const seen = new Set<number>();
  const unique = cells.filter((c) => (seen.has(c.secoord) ? false : (seen.add(c.secoord), true)));
  console.log(`${unique.length} placeable cells (${features.length - unique.length} skipped)`);

  const cutoff = Date.now() - CACHE_TTL_DAYS * 86_400_000;
  let done = 0;
  const resolved = await mapPool(unique, HEAD_CONCURRENCY, async (cell) => {
    const key = String(cell.secoord);
    const cached = cache.get(key);
    if (
      !refresh &&
      cached !== undefined &&
      cached.failed !== true &&
      Date.parse(cached.fetchedAt) > cutoff
    ) {
      return cached;
    }
    const result = await resolveSheet(cell.secoord);
    cache.set(key, result);
    done += 1;
    if (done % 500 === 0) console.log(`  resolved ${done} sheets`);
    return result;
  });
  cache.flush();

  const items: CatalogItem[] = [];
  let absent = 0;
  const failed = resolved.filter((r) => r.failed === true).length;
  unique.forEach((cell, i) => {
    const file = resolved[i];
    if (file?.url === undefined) {
      absent += 1;
      return;
    }
    const a = cell.attributes;
    const name = clean(a.quad_name) || clean(a.cell_name) || `FSTopo ${cell.secoord}`;
    const stateName = clean(a.primary_state);
    const stateCode = /\b([A-Z]{2})\b/.exec(clean(a.state_alpha))?.[1];
    const scale = Number(a.map_scale) || (stateCode === 'AK' ? 25000 : 24000);
    items.push({
      id: `fstopo-${cell.secoord}`,
      sourceId: SOURCE.id,
      title: stateName === '' ? `${name} — FSTopo` : `${name}, ${stateName} — FSTopo`,
      // Legacy category "forest" (National Forest maps), not "topo": a US Topo
      // 2.5° cell holds exactly 400 quads, so mixing FSTopo into the topo
      // shards split nearly every western cell a level deeper and doubled the
      // shard directory (and the index every client fetches on start). Its
      // own category keeps both sets of shards whole; `kind` is still topo.
      category: 'forest',
      ...(stateCode !== undefined ? { region: `US-${stateCode}` } : {}),
      bbox: cell.bbox,
      format: 'geopdf',
      packaging: 'none',
      ...(file.sizeBytes !== undefined ? { sizeBytes: file.sizeBytes } : {}),
      url: file.url,
      ...(file.updatedAt !== undefined ? { updatedAt: file.updatedAt } : {}),
      lang: 'en',
      kind: 'topo',
      scale,
    });
  });
  items.sort((a, b) => a.id.localeCompare(b.id));

  const outPath = join(scriptDir, 'fragments', 'usfs-fstopo.json');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify({ sources: [SOURCE], items })}\n`);
  console.log(
    `wrote ${outPath} (${items.length} items, ${absent} cells without a PDF, ` +
      `${failed} of them unreachable after retries — re-run to retry those)`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
