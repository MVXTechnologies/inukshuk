/**
 * Catalog generator — Geoscience Australia AUSTopo 1:250 000 GeoPDF source.
 *
 * 509 sheets covering the Australian continent as genuine OGC geospatial PDFs
 * (`/Measure /Subtype /GEO` + `/GPTS`, GDA2020/MGA), 1.4–51 MB each, served
 * from Geoscience Australia's own CloudFront distribution.
 *
 * Enumeration is one anonymous POST to eCat's GeoNetwork search API — no key,
 * no cookie, no EULA:
 *
 *   POST https://ecat.ga.gov.au/geonetwork/srv/api/search/records/_search
 *
 * Each record carries the sheet title, a GeoJSON coverage polygon, the direct
 * CloudFront URL and the file size (in the link's own description). Filenames
 * are NOT derivable from the sheet id — 508 sheets end `_Feb26.pdf` and one
 * ends `_Feb2026.pdf` — so URLs are always read from the index, never built.
 *
 * Licence: Creative Commons Attribution 4.0 International. Each record's
 * `legalconstraints` says so verbatim, and https://www.ga.gov.au/copyright —
 * "All material on this website is licensed under the Creative Commons
 * Attribution 4.0 International Licence" (carve-outs: the Coat of Arms, the GA
 * logo, and third-party content — none of which we redistribute; we link to
 * GA's own files).
 *
 * Usage:
 *   npx tsx scripts/catalog/fetch-austopo.ts
 *
 * Output: scripts/catalog/fragments/ga-austopo.json
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CatalogBbox, CatalogItem, CatalogSource } from '../../src/core/catalog/schema';

const SEARCH_URL = 'https://ecat.ga.gov.au/geonetwork/srv/api/search/records/_search';
const SERIES_PHRASE = 'AUSTopo 1:250 000 digital map';
const PAGE_SIZE = 200;

const SOURCE: CatalogSource = {
  id: 'ga-austopo',
  name: 'Geoscience Australia AUSTopo',
  licence: 'CC-BY-4.0',
  attribution: 'Geoscience Australia',
  homepage:
    'https://www.ga.gov.au/scientific-topics/national-location-information/topographic-maps-data',
};

interface EsLink {
  function?: string;
  urlObject?: { default?: string };
  descriptionObject?: { default?: string };
}

interface EsSource {
  resourceTitleObject?: { default?: string };
  link?: EsLink[] | EsLink;
  geom?: { type?: string; coordinates?: unknown };
  legalconstraints?: unknown;
}

async function searchPage(from: number): Promise<{ total: number; hits: EsSource[] }> {
  const res = await fetch(SEARCH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      size: PAGE_SIZE,
      from,
      _source: ['resourceTitleObject', 'link', 'geom', 'legalconstraints'],
      query: { match_phrase: { 'resourceTitleObject.default': SERIES_PHRASE } },
      sort: [{ 'resourceTitleObject.default.keyword': 'asc' }],
    }),
  });
  if (!res.ok) throw new Error(`POST ${SEARCH_URL} → HTTP ${res.status}`);
  const body = (await res.json()) as {
    hits?: { total?: { value?: number }; hits?: { _source?: EsSource }[] };
  };
  return {
    total: body.hits?.total?.value ?? 0,
    hits: (body.hits?.hits ?? []).map((h) => h._source ?? {}),
  };
}

/** Bounding box of a GeoJSON Polygon/MultiPolygon ring set. */
function bboxOfGeometry(geom: EsSource['geom']): CatalogBbox | null {
  const coords: number[][] = [];
  const walk = (node: unknown): void => {
    if (!Array.isArray(node)) return;
    if (node.length >= 2 && typeof node[0] === 'number' && typeof node[1] === 'number') {
      coords.push(node as number[]);
      return;
    }
    for (const child of node) walk(child);
  };
  walk(geom?.coordinates);
  if (coords.length === 0) return null;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [lon, lat] of coords) {
    if (lon === undefined || lat === undefined) continue;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (Math.abs(lon) > 180 || Math.abs(lat) > 90) return null;
    west = Math.min(west, lon);
    east = Math.max(east, lon);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  if (!(west < east && south < north)) return null;
  return [west, south, east, north];
}

/** "Download the map (GeoPDF) [3.4 MB]" → 3565158 bytes (approximate). */
function sizeFromDescription(description: string): number | undefined {
  const match = /\[([\d.]+)\s*(KB|MB|GB)\]/i.exec(description);
  const value = Number(match?.[1]);
  const unit = match?.[2]?.toUpperCase();
  if (!Number.isFinite(value) || unit === undefined) return undefined;
  const scale = unit === 'KB' ? 1024 : unit === 'MB' ? 1024 ** 2 : 1024 ** 3;
  return Math.round(value * scale);
}

/** "Cook SH52-11 - AUSTopo 1:250 000 digital map" → { name, sheet }. */
function parseTitle(title: string): { name: string; sheet: string } | null {
  const match = /^(.*?)\s+([A-Z]{2}\d{2}-\d{1,2})\s+-\s+AUSTopo/i.exec(title);
  const name = match?.[1]?.trim();
  const sheet = match?.[2]?.toUpperCase();
  if (name === undefined || sheet === undefined || name === '') return null;
  return { name, sheet };
}

function asLinks(link: EsSource['link']): EsLink[] {
  if (Array.isArray(link)) return link;
  return link === undefined ? [] : [link];
}

async function main(): Promise<void> {
  const items: CatalogItem[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  let total = Infinity;

  for (let from = 0; from < total; from += PAGE_SIZE) {
    const page = await searchPage(from);
    total = page.total;
    if (from === 0) console.log(`eCat: ${total} "${SERIES_PHRASE}" records`);
    if (page.hits.length === 0) break;

    for (const record of page.hits) {
      const title = record.resourceTitleObject?.default ?? '';
      const parsed = parseTitle(title);
      // The download link is the one whose description names GeoPDF; other
      // links on the record are metadata pages and preview images. Do NOT
      // filter on `function === 'download'`: ~75 of the 509 records leave that
      // field empty, and the wording varies ("Download the map (GeoPDF)" vs
      // "Download Map (GeoPDF)"), so the description + .pdf URL is the only
      // reliable discriminator.
      const download = asLinks(record.link).find(
        (l) =>
          /\((geo)?pdf\)/i.test(l.descriptionObject?.default ?? '') &&
          /^https:\/\/\S+\.pdf$/i.test(l.urlObject?.default ?? ''),
      );
      const description = download?.descriptionObject?.default ?? '';
      // Two sheets (Manilla SH56-09, Monto SG56-01) are published as plain
      // "(pdf)" rather than "(GeoPDF)". Carry them at their real format so the
      // importer's un-georeferenced path warns instead of silently placing
      // them wrong — the catalog must never overstate what a file is.
      const format = /geopdf/i.test(description) ? 'geopdf' : 'pdf';
      const url = download?.urlObject?.default;
      const bbox = bboxOfGeometry(record.geom);
      if (parsed === null || url === undefined || bbox === null) {
        skipped += 1;
        continue;
      }
      const id = `austopo-${parsed.sheet.toLowerCase()}`;
      if (seen.has(id)) {
        skipped += 1;
        continue;
      }
      seen.add(id);
      const sizeBytes = sizeFromDescription(description);
      items.push({
        id,
        sourceId: SOURCE.id,
        title: `${parsed.name} ${parsed.sheet} — AUSTopo 250k`,
        category: 'topo',
        region: 'AU',
        bbox,
        format,
        packaging: 'none',
        ...(sizeBytes !== undefined ? { sizeBytes } : {}),
        url,
        lang: 'en',
      });
    }
  }
  items.sort((a, b) => a.id.localeCompare(b.id));

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const outPath = join(scriptDir, 'fragments', 'ga-austopo.json');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify({ sources: [SOURCE], items }, null, 2)}\n`);
  console.log(`wrote ${outPath} (${items.length} items, ${skipped} records skipped)`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
