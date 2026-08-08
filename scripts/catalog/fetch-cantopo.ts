/**
 * Catalog generator — NRCan CanTopo 1:50k GeoPDF source.
 *
 * Crawls the (legacy, updates-not-planned) CanTopo HTTP tree for the given NTS
 * primary quadrangles, HEADs every zip for its real size + revision date,
 * resolves each sheet's toponym from NRCan's nts_snrc.kmz index, and writes a
 * normalized fragment for build-manifest.ts. Runs in Node (CI or a dev
 * machine), never on phones — devices only read the merged manifest.
 *
 * Usage:
 *   npx tsx scripts/catalog/fetch-cantopo.ts [quad...]
 *
 * Default quads: every regular-zone quadrangle that touches Québec plus the
 * originally-scoped 021/031. (Reality check from the first crawl: CanTopo's
 * GeoPDF coverage inside 021/031 is Maritimes + Ontario; Québec's sheets sit
 * in 032/033 and northward, while 022/023 have no GeoPDF dirs at all — the
 * crawler tolerates missing quads.) Quads at row 5+ (60°N and up) are
 * excluded until the NTS high-latitude sheet model lands.
 *
 * Output: scripts/catalog/fragments/nrcan-cantopo.json
 *
 * Licence: CanTopo is Open Government Licence – Canada; we link to NRCan's
 * files (attribution in the source record below), we do not rehost them.
 */
import { unzipSync } from 'fflate';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ntsSheetBbox } from '../../src/core/catalog/nts';
import type { CatalogItem, CatalogSource } from '../../src/core/catalog/schema';

const BASE = 'https://ftp.maps.canada.ca/pub/nrcan_rncan/raster/cantopo/50k_geopdf';
const NTS_NAMES_KMZ = 'https://ftp.maps.canada.ca/pub/nrcan_rncan/vector/index/nts_snrc.kmz';
const HEAD_CONCURRENCY = 6;
const DEFAULT_QUADS = ['021', '022', '023', '024', '031', '032', '033', '034'];

const SOURCE: CatalogSource = {
  id: 'nrcan-cantopo',
  name: 'NRCan CanTopo',
  licence: 'OGL-Canada-2.0',
  attribution: 'Natural Resources Canada',
  homepage:
    'https://natural-resources.canada.ca/science-and-data/science-and-research/earth-sciences/geography/topographic-information/maps/canada-topographic-maps',
};

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return res.text();
}

/** Relative subdirectory links ("a/", "021/") from an Apache index page. */
function listSubdirs(html: string): string[] {
  return [...html.matchAll(/href="([a-z0-9]{1,4})\/"/g)].map((m) => m[1] ?? '');
}

/** CanTopo zip names from an Apache index page. */
function listZips(html: string): string[] {
  return [...html.matchAll(/href="(cantopo_\d{3}[a-p]\d{2}_geopdf\.zip)"/g)].map((m) => m[1] ?? '');
}

async function headMeta(url: string): Promise<{ sizeBytes?: number; updatedAt?: string }> {
  const res = await fetch(url, { method: 'HEAD' });
  if (!res.ok) throw new Error(`HEAD ${url} → HTTP ${res.status}`);
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

/**
 * Sheet-id → toponym from NRCan's NTS index KMZ. Each placemark carries
 * `<name>021L14</name> … <snippet>QUÉBEC</snippet>`.
 */
async function fetchSheetNames(): Promise<Map<string, string>> {
  const res = await fetch(NTS_NAMES_KMZ);
  if (!res.ok) throw new Error(`GET ${NTS_NAMES_KMZ} → HTTP ${res.status}`);
  const kmz = new Uint8Array(await res.arrayBuffer());
  const files = unzipSync(kmz, { filter: (f) => f.name.endsWith('.kml') });
  const kmlBytes = Object.values(files)[0];
  if (kmlBytes === undefined) throw new Error('nts_snrc.kmz contains no KML');
  const kml = new TextDecoder('utf-8').decode(kmlBytes);
  const names = new Map<string, string>();
  for (const m of kml.matchAll(
    /<name>(\d{3}[A-P]\d{2})<\/name>[\s\S]{0,300}?<snippet>([^<]*)<\/snippet>/g,
  )) {
    const sheet = m[1];
    const raw = (m[2] ?? '').trim();
    if (sheet !== undefined && raw !== '') names.set(sheet, titleCaseToponym(raw));
  }
  return names;
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

async function main(): Promise<void> {
  const quads = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_QUADS;
  const names = await fetchSheetNames();
  console.log(`NTS toponym index: ${names.size} sheets`);

  const zipUrls: string[] = [];
  for (const quad of quads) {
    let letters: string[];
    try {
      letters = listSubdirs(await fetchText(`${BASE}/${quad}/`));
    } catch {
      console.log(`${quad}: no GeoPDF directory — skipped`);
      continue;
    }
    for (const letter of letters) {
      for (const zip of listZips(await fetchText(`${BASE}/${quad}/${letter}/`))) {
        zipUrls.push(`${BASE}/${quad}/${letter}/${zip}`);
      }
    }
    console.log(`${quad}: ${letters.length} letter dirs crawled`);
  }
  console.log(`${zipUrls.length} CanTopo zips found in ${quads.join(', ')}`);

  const items = await withConcurrency(
    zipUrls.map((url) => async (): Promise<CatalogItem> => {
      const sheetMatch = /cantopo_(\d{3}[a-p]\d{2})_geopdf\.zip$/.exec(url);
      const sheetLower = sheetMatch?.[1];
      if (sheetLower === undefined) throw new Error(`unparseable zip url: ${url}`);
      const sheet = sheetLower.toUpperCase();
      const bbox = ntsSheetBbox(sheet);
      const toponym = names.get(sheet);
      const meta = await headMeta(url);
      return {
        id: `cantopo-${sheetLower}`,
        sourceId: SOURCE.id,
        title: toponym !== undefined ? `${toponym} — CanTopo ${sheet}` : `CanTopo ${sheet}`,
        category: 'topo',
        ...(bbox !== null ? { bbox } : {}),
        format: 'geopdf',
        packaging: 'zip',
        url,
        lang: 'bilingual',
        ...meta,
      };
    }),
    HEAD_CONCURRENCY,
  );
  items.sort((a, b) => a.id.localeCompare(b.id));

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const outPath = join(scriptDir, 'fragments', 'nrcan-cantopo.json');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify({ sources: [SOURCE], items }, null, 2)}\n`);
  console.log(`wrote ${outPath} (${items.length} items)`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
