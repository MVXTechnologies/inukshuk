/**
 * Catalog generator — build the E2E/test fixture: five tiny zipped GeoPDFs and
 * a **sharded** fixture catalog (index + shards + search digest) pointing at a
 * loopback server.
 *
 * The Maestro flow (.maestro/store.yaml) serves `.maestro/fixtures/catalog/`
 * on http://127.0.0.1:8787 (adb reverse maps the emulator's loopback to the
 * host), and the e2e APK is built with
 * `CATALOG_MANIFEST_URL=http://127.0.0.1:8787/index.json` — CI never touches
 * NRCan or NOAA. The PDFs are written by the app's own GeoPDF writer
 * (`attachGeoViewport`) and verified with the app's own parser before the
 * fixture is accepted, so the download → import path exercises the real thing.
 *
 * The fixture is deliberately sharded across **two categories** even though it
 * holds five items: that is the only way the e2e run proves the production
 * path — index fetch, nearest-shard selection, on-demand shard fetch, the
 * digest-driven query fetch, and the cross-category "Around you" section. A
 * single flat manifest would exercise none of it.
 *
 * Usage:
 *   npx tsx scripts/catalog/make-fixture.ts
 *
 * Output (checked in):
 *   .maestro/fixtures/catalog/{index.json,search.json,shards/*.json,*.zip}
 */
import { zipSync } from 'fflate';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

import { ntsSheetBbox } from '../../src/core/catalog/nts';
import {
  CATALOG_INDEX_SCHEMA_VERSION,
  parseCatalogIndex,
  parseCatalogShard,
  type CatalogBbox,
  type CatalogCategory,
  type CatalogItem,
  type CatalogShardRef,
  type CatalogSource,
} from '../../src/core/catalog/schema';
import {
  buildCatalogSearchDigest,
  parseCatalogSearchDigest,
} from '../../src/core/catalog/searchDigest';
import { planCatalogShards } from '../../src/core/catalog/shard';
import { parseGeoPdf } from '../../src/core/geo/geopdf';
import { attachGeoViewport } from '../../src/core/geo/geopdf/write';

const BASE_URL = 'http://127.0.0.1:8787';

const SOURCES: CatalogSource[] = [
  {
    id: 'nrcan-cantopo',
    name: 'NRCan CanTopo',
    licence: 'OGL-Canada-2.0',
    attribution: 'Natural Resources Canada',
    homepage: 'https://natural-resources.canada.ca',
  },
  {
    id: 'noaa-bookletchart',
    name: 'NOAA BookletChart',
    licence: 'Public domain (17 U.S.C. §105)',
    attribution: 'NOAA Office of Coast Survey',
    homepage: 'https://nauticalcharts.noaa.gov',
  },
];

interface FixtureSpec {
  id: string;
  sourceId: string;
  fileName: string;
  title: string;
  label: string;
  category: CatalogCategory;
  bbox: CatalogBbox;
}

/** Real 021L sheets (NRCan toponyms) so search behaves realistically. */
function ntsBbox(sheet: string): CatalogBbox {
  const bbox = ntsSheetBbox(sheet);
  if (bbox === null) throw new Error(`bad sheet id ${sheet}`);
  return bbox;
}

/**
 * THREE topo sheets and two nautical charts, all around Québec City — the
 * emulator is geo-fixed there (`adb emu geo fix -71.2082 46.8139` plus the
 * flow's own `setLocation`), so "Around you" has something to show and the
 * per-category cap has something to cap.
 *
 * Five items is not arbitrary: it is exactly `NEARBY_ROWS`, so the landing
 * section is full only when the per-category cap adapts to the two categories
 * present (3 topo + 2 nautical). A fixture with two sheets per category filled
 * the section either way, which is how "Around you" shipped capped at two rows
 * in the single-category production catalog while this flow stayed green — the
 * third topo sheet is the row that regression would drop.
 */
const FIXTURES: FixtureSpec[] = [
  {
    id: 'cantopo-021l14',
    sourceId: 'nrcan-cantopo',
    fileName: 'cantopo_021l14_geopdf.zip',
    title: 'Québec — CanTopo 021L14',
    label: 'CanTopo fixture — Québec (021L14)',
    category: 'topo',
    bbox: ntsBbox('021L14'),
  },
  {
    id: 'cantopo-021l13',
    sourceId: 'nrcan-cantopo',
    fileName: 'cantopo_021l13_geopdf.zip',
    title: 'Saint-Raymond — CanTopo 021L13',
    label: 'CanTopo fixture — Saint-Raymond (021L13)',
    category: 'topo',
    bbox: ntsBbox('021L13'),
  },
  {
    id: 'cantopo-021l11',
    sourceId: 'nrcan-cantopo',
    fileName: 'cantopo_021l11_geopdf.zip',
    title: 'Lac-Saint-Joseph — CanTopo 021L11',
    label: 'CanTopo fixture — Lac-Saint-Joseph (021L11)',
    category: 'topo',
    bbox: ntsBbox('021L11'),
  },
  {
    id: 'fixture-chart-14771',
    sourceId: 'noaa-bookletchart',
    fileName: 'bookletchart_14771.zip',
    title: 'Chart 14771 — Fixture Harbour',
    label: 'Nautical fixture — Chart 14771',
    category: 'nautical',
    bbox: [-71.3, 46.75, -71.1, 46.9],
  },
  {
    id: 'fixture-chart-14772',
    sourceId: 'noaa-bookletchart',
    fileName: 'bookletchart_14772.zip',
    title: 'Chart 14772 — Fixture Approaches',
    label: 'Nautical fixture — Chart 14772',
    category: 'nautical',
    bbox: [-71.6, 46.6, -71.3, 46.8],
  },
];

async function makeGeoPdf(label: string, bbox: CatalogBbox): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawRectangle({
    x: 36,
    y: 36,
    width: 540,
    height: 720,
    borderColor: rgb(0.35, 0.42, 0.3),
    borderWidth: 2,
    color: rgb(0.94, 0.93, 0.88),
  });
  page.drawText(label, { x: 60, y: 720, size: 18, font, color: rgb(0.2, 0.2, 0.2) });
  page.drawText('E2E fixture GeoPDF — not a real map', {
    x: 60,
    y: 694,
    size: 11,
    font,
    color: rgb(0.4, 0.4, 0.4),
  });

  const [w, s, e, n] = bbox;
  attachGeoViewport(
    doc,
    page,
    { x: 36, y: 36, w: 540, h: 720 },
    { topLeft: [w, n], topRight: [e, n], bottomRight: [e, s], bottomLeft: [w, s] },
  );
  const bytes = await doc.save();

  // Gate the fixture on the app's own parser — a fixture the import path
  // cannot georeference would make the e2e flow lie.
  const parsed = parseGeoPdf(bytes);
  if (parsed.georeferences.length !== 1) {
    throw new Error(`fixture ${label} failed to parse: ${parsed.warnings.join('; ')}`);
  }
  return bytes;
}

async function main(): Promise<void> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const outDir = join(scriptDir, '..', '..', '.maestro', 'fixtures', 'catalog');
  const shardsDir = join(outDir, 'shards');
  mkdirSync(outDir, { recursive: true });
  rmSync(shardsDir, { recursive: true, force: true });
  mkdirSync(shardsDir, { recursive: true });

  const items: CatalogItem[] = [];
  for (const spec of FIXTURES) {
    const pdf = await makeGeoPdf(spec.label, spec.bbox);
    // Fixed mtime keeps the checked-in zip stable across regenerations.
    const zip = zipSync(
      { [`${spec.id}.pdf`]: pdf },
      { level: 6, mtime: new Date('2026-01-01T00:00:00Z') },
    );
    writeFileSync(join(outDir, spec.fileName), zip);
    items.push({
      id: spec.id,
      sourceId: spec.sourceId,
      title: spec.title,
      category: spec.category,
      bbox: spec.bbox,
      format: 'geopdf',
      packaging: 'zip',
      sizeBytes: zip.length,
      url: `${BASE_URL}/${spec.fileName}`,
      updatedAt: '2026-01-01',
      lang: 'bilingual',
    });
    console.log(`${spec.fileName}: ${zip.length} bytes (pdf ${pdf.length})`);
  }

  const sourceIds = new Set(SOURCES.map((s) => s.id));
  const shards: CatalogShardRef[] = [];
  const categoryCounts: Partial<Record<CatalogCategory, number>> = {};
  for (const item of items)
    categoryCounts[item.category] = (categoryCounts[item.category] ?? 0) + 1;

  const planned = planCatalogShards(items);
  for (const shard of planned) {
    const body = `${JSON.stringify({ id: shard.id, items: shard.items }, null, 2)}\n`;
    const { items: reparsed, warnings } = parseCatalogShard(JSON.parse(body), sourceIds);
    if (warnings.length > 0 || reparsed.length !== shard.items.length) {
      throw new Error(`fixture shard ${shard.id} failed validation: ${warnings.join('; ')}`);
    }
    writeFileSync(join(shardsDir, `${shard.id}.json`), body);
    shards.push({
      id: shard.id,
      category: shard.category,
      path: `shards/${shard.id}.json`,
      itemCount: shard.items.length,
      ...(shard.bbox !== undefined ? { bbox: shard.bbox } : {}),
      byteSize: Buffer.byteLength(body),
    });
    console.log(`shards/${shard.id}.json: ${shard.items.length} items`);
  }

  // The fixture publishes a search digest too, so the e2e run covers the path
  // a query actually takes: digest fetch → shard selection → merge. Without it
  // the flow would only ever prove search over already-loaded shards, which is
  // precisely the bug that shipped.
  const digest = buildCatalogSearchDigest(planned.map((s) => ({ id: s.id, items: s.items })));
  const digestBody = `${JSON.stringify(digest, null, 2)}\n`;
  const { digest: parsedDigest, warnings: digestWarnings } = parseCatalogSearchDigest(
    JSON.parse(digestBody),
  );
  if (parsedDigest === null || digestWarnings.length > 0) {
    throw new Error(`fixture search digest failed validation: ${digestWarnings.join('; ')}`);
  }
  writeFileSync(join(outDir, 'search.json'), digestBody);
  console.log(`search.json: ${Object.keys(digest.tokens).length} tokens`);

  const index = {
    schemaVersion: CATALOG_INDEX_SCHEMA_VERSION,
    generatedAt: '2026-01-01T00:00:00Z',
    sources: SOURCES,
    shards,
    search: { path: 'search.json', byteSize: Buffer.byteLength(digestBody) },
    categoryCounts,
  };
  const { index: parsed, warnings } = parseCatalogIndex(index);
  if (parsed === null || warnings.length > 0) {
    throw new Error(`fixture index failed validation: ${warnings.join('; ')}`);
  }
  writeFileSync(join(outDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  console.log(
    `wrote ${join(outDir, 'index.json')} (${items.length} items, ${shards.length} shards)`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
