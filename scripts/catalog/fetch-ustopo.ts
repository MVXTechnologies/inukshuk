/**
 * Catalog generator — USGS US Topo source (the world catalog's US backbone).
 *
 * US Topo is the current 7.5-minute quadrangle series: ~65 000 genuine
 * geospatial PDFs (OGC `/VP` + `/Measure` viewports, which our GeoPDF parser
 * reads) covering the whole United States, republished on a ~3-year cycle.
 *
 * We do not crawl, and we do not call the TNM Access API per item: USGS
 * publishes a **bulk metadata CSV**, refreshed nightly, that already carries
 * everything the manifest needs — bounding box, file size, publication date and
 * a stable "Current" download URL that does not change when a quad is
 * reissued. One 10 MB download replaces 65 000 HEAD requests.
 *
 *   https://prd-tnm.s3.amazonaws.com/StagedProducts/Maps/Metadata/ustopo_current.zip
 *
 * Licence: public domain. USGS, "What are the terms of use/licensing of map
 * services and data from The National Map?" — "Map services and data downloaded
 * from The National Map are free and in the public domain. There are no
 * restrictions." Acknowledgement is requested, not required; we carry it in the
 * source's `attribution`. We link to USGS's own S3 objects, we never rehost.
 *
 * Deliberately NOT included: the Historical Topographic Map Collection
 * (186 061 sheets, same CSV format at .../historicaltopo.zip). It would triple
 * the catalog and bury every current quad under eight historical editions of
 * itself in "Around you". Add it behind its own category if it is ever wanted.
 *
 * Usage:
 *   npx tsx scripts/catalog/fetch-ustopo.ts [--limit N]
 *
 * Output: scripts/catalog/fragments/usgs-ustopo.json
 */
import { unzipSync } from 'fflate';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { csvColumnIndex, parseCsvLine, splitCsvRows } from '../../src/core/catalog/csv';
import type { CatalogBbox, CatalogItem, CatalogSource } from '../../src/core/catalog/schema';

const METADATA_ZIP =
  'https://prd-tnm.s3.amazonaws.com/StagedProducts/Maps/Metadata/ustopo_current.zip';

const SOURCE: CatalogSource = {
  id: 'usgs-ustopo',
  name: 'USGS US Topo',
  licence: 'Public domain (US Government)',
  attribution: 'U.S. Geological Survey, National Geospatial Program',
  homepage: 'https://www.usgs.gov/programs/national-geospatial-program/us-topo-maps-america',
};

function finite(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** "AL_Abbeville_East.pdf" → "al-abbeville-east" (stable, searchable id). */
function slugFromFilename(filename: string): string | null {
  const stem = filename.replace(/\.pdf$/i, '').trim();
  const slug = stem
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? null : slug;
}

async function fetchCsv(url: string): Promise<string> {
  console.log(`GET ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  const zip = new Uint8Array(await res.arrayBuffer());
  console.log(`  ${(zip.length / 1024 / 1024).toFixed(1)} MB zipped`);
  const files = unzipSync(zip, { filter: (f) => f.name.toLowerCase().endsWith('.csv') });
  const csv = Object.values(files)[0];
  if (csv === undefined) throw new Error('metadata zip contains no CSV');
  return new TextDecoder('utf-8').decode(csv);
}

async function main(): Promise<void> {
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1] ?? '') : Infinity;

  const rows = splitCsvRows(await fetchCsv(METADATA_ZIP));
  // Fail loudly if USGS renames a column: a silently-missing bbox column would
  // otherwise produce 65 000 plausible-looking items with the wrong extents.
  const at = csvColumnIndex(parseCsvLine(rows[0] ?? ''), [
    'map_name',
    'primary_state',
    'westbc',
    'eastbc',
    'northbc',
    'southbc',
    'publication_date',
    'product_format',
    'product_filename',
    'product_filesize',
    'product_url',
  ]);
  const col = {
    mapName: at.map_name ?? 0,
    state: at.primary_state ?? 0,
    west: at.westbc ?? 0,
    east: at.eastbc ?? 0,
    north: at.northbc ?? 0,
    south: at.southbc ?? 0,
    publicationDate: at.publication_date ?? 0,
    format: at.product_format ?? 0,
    fileName: at.product_filename ?? 0,
    fileSize: at.product_filesize ?? 0,
    url: at.product_url ?? 0,
  };

  const items: CatalogItem[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const row of rows.slice(1)) {
    if (items.length >= limit) break;
    const f = parseCsvLine(row);
    const url = (f[col.url] ?? '').trim();
    const fileName = (f[col.fileName] ?? '').trim();
    const slug = slugFromFilename(fileName);
    const west = finite(f[col.west]);
    const east = finite(f[col.east]);
    const north = finite(f[col.north]);
    const south = finite(f[col.south]);
    const id = slug === null ? null : `ustopo-${slug}`;
    if (
      !(f[col.format] ?? '').toUpperCase().includes('PDF') ||
      !/^https:\/\//.test(url) ||
      id === null ||
      seen.has(id) ||
      west === null ||
      east === null ||
      north === null ||
      south === null ||
      west >= east ||
      south >= north
    ) {
      skipped += 1;
      continue;
    }
    seen.add(id);

    const mapName = (f[col.mapName] ?? '').trim();
    const state = (f[col.state] ?? '').trim();
    const bbox: CatalogBbox = [west, south, east, north];
    const sizeBytes = finite(f[col.fileSize]);
    const publicationDate = (f[col.publicationDate] ?? '').trim();
    // The filename's leading token is the USPS state code — a good ISO 3166-2
    // region for the coarse filter, and cheaper than mapping state names.
    const stateCode = /^([A-Z]{2})_/.exec(fileName)?.[1];

    items.push({
      id,
      sourceId: SOURCE.id,
      title: state === '' ? `${mapName} — US Topo` : `${mapName}, ${state} — US Topo`,
      category: 'topo',
      ...(stateCode !== undefined ? { region: `US-${stateCode}` } : {}),
      bbox,
      format: 'geopdf',
      packaging: 'none',
      ...(sizeBytes !== null && sizeBytes > 0 ? { sizeBytes } : {}),
      url,
      ...(/^\d{4}-\d{2}-\d{2}$/.test(publicationDate) ? { updatedAt: publicationDate } : {}),
      lang: 'en',
    });
  }
  items.sort((a, b) => a.id.localeCompare(b.id));

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const outPath = join(scriptDir, 'fragments', 'usgs-ustopo.json');
  mkdirSync(dirname(outPath), { recursive: true });
  // Minified: at 65 000 items pretty-printing costs ~15 MB of pure whitespace,
  // and nothing reads this by eye. See the .gitignore note — this fragment is
  // a build input regenerated from one bulk CSV, not a checked-in artifact.
  writeFileSync(outPath, `${JSON.stringify({ sources: [SOURCE], items })}\n`);
  console.log(`wrote ${outPath} (${items.length} items, ${skipped} rows skipped)`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
