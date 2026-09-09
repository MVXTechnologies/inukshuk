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
 * The sixth item is the PDF-overlay regression fixture (#331,
 * `.maestro/pdf-overlays.yaml`): a GeoPDF whose single page is one 5600×4200
 * baseline JPEG — the EcoLL1 class of map, whose 23.5 Mi source pixels exceed
 * the native crop path's 16 Mi-pixel decode budget, so before #331 iOS sent
 * it to PDF.js and a real iPhone ran out of memory decoding it. Its ~6.6 MB
 * zip is generated here too but NOT checked in (gitignored): run this script
 * before serving the fixture directory. It sits in Newfoundland, far from the
 * Québec City items, so "Around you" and every store.yaml assertion are
 * unchanged.
 *
 * Usage:
 *   npx tsx scripts/catalog/make-fixture.ts
 *
 * Output (checked in, except the large JPEG zip):
 *   .maestro/fixtures/catalog/{index.json,search.json,shards/*.json,*.zip}
 */
import { zipSync } from 'fflate';
import jpeg from 'jpeg-js';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PDFArray,
  PDFDocument,
  PDFName,
  StandardFonts,
  concatTransformationMatrix,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
  rgb,
} from 'pdf-lib';

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
  {
    id: 'inukshuk-fixtures',
    name: 'Inukshuk e2e fixtures',
    licence: 'CC0-1.0',
    attribution: 'Inukshuk',
    homepage: 'https://github.com/MVXTechnologies/inukshuk',
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
  /** `large-jpeg`: the Eco-class single-JPEG page (#331); generated, not checked in. */
  kind?: 'large-jpeg';
}

/** Title of the large-JPEG fixture; `.maestro/pdf-overlays.yaml` searches for "jpeg". */
const LARGE_JPEG_FIXTURE_TITLE = 'Placentia Bay — JPEG fixture (Eco class)';
const LARGE_JPEG_FIXTURE_FILE = 'jpeg_eco_class_geopdf.zip';
/** WGS84 bbox of the large-JPEG fixture; the flow parks the simulated GPS at its centre. */
const LARGE_JPEG_FIXTURE_BBOX: CatalogBbox = [-54.1, 47.2, -53.6, 47.6];

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
  {
    id: 'fixture-jpeg-eco-class',
    sourceId: 'inukshuk-fixtures',
    fileName: LARGE_JPEG_FIXTURE_FILE,
    title: LARGE_JPEG_FIXTURE_TITLE,
    label: 'Large single-JPEG page fixture (Eco class, #331)',
    category: 'topo',
    bbox: LARGE_JPEG_FIXTURE_BBOX,
    kind: 'large-jpeg',
  },
];

/** The four quadrant colours of the large JPEG, top-left/top-right/bottom-left/bottom-right (RGB). */
const LARGE_JPEG_QUADRANTS: [number, number, number][] = [
  [220, 40, 40],
  [30, 200, 60],
  [30, 60, 220],
  [230, 210, 40],
];
const LARGE_JPEG_WIDTH = 5600;
const LARGE_JPEG_HEIGHT = 4200;

/**
 * One baseline JPEG page, 5600×4200 (23.5 Mi pixels — above the native crop
 * path's 16 Mi-pixel decode budget), painted edge to edge on a 1400×1050 pt
 * page and georeferenced over `bbox`. Four saturated quadrants with a seeded
 * noise texture and a grid: the texture keeps the file in the 6–7 MB range a
 * real export has (a flat colour would compress to nothing), and the quadrant
 * colours let the e2e runner verify from a screenshot that the overlay drew
 * (`scripts/e2e/check-overlay-screenshot.mjs`). jpeg-js writes exactly the
 * JFIF/DQT/SOF0/DHT/SOS markers the iOS crop grammar accepts; pdf-lib writes
 * the `/DCTDecode /DeviceRGB` image and `q … cm /Image Do Q` content it needs.
 */
async function makeLargeJpegGeoPdf(bbox: CatalogBbox): Promise<Uint8Array> {
  const width = LARGE_JPEG_WIDTH;
  const height = LARGE_JPEG_HEIGHT;
  const rgba = Buffer.alloc(width * height * 4);
  let seed = 0x1234_5678;
  const noise = (): number => {
    seed = (seed * 1_103_515_245 + 12_345) & 0x7fff_ffff;
    return seed / 0x7fff_ffff - 0.5;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const quadrant = LARGE_JPEG_QUADRANTS[(y < height / 2 ? 0 : 2) + (x < width / 2 ? 0 : 1)]!;
      const grain = noise() * 70 + (x % 200 < 3 || y % 200 < 3 ? -120 : 0);
      const i = (y * width + x) * 4;
      rgba[i] = Math.max(0, Math.min(255, quadrant[0] + grain));
      rgba[i + 1] = Math.max(0, Math.min(255, quadrant[1] + grain));
      rgba[i + 2] = Math.max(0, Math.min(255, quadrant[2] + grain));
      rgba[i + 3] = 255;
    }
  }
  const encoded = jpeg.encode({ data: rgba, width, height }, 65).data;

  // Fixed metadata so regeneration is byte-stable.
  const doc = await PDFDocument.create({ updateMetadata: false });
  const image = await doc.embedJpg(encoded);
  const page = doc.addPage([1400, 1050]);
  // Written the way a map exporter writes it, which is also what the iOS crop
  // grammar recognizes: a plain resource name (pdf-lib's default
  // `/Image-<digits>` carries a hyphen the grammar rejects) and one image
  // paint — `q <w> 0 0 <h> 0 0 cm /Im1 Do Q`.
  page.node.setXObject(PDFName.of('Im1'), image.ref);
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(1400, 0, 0, 1050, 0, 0),
    drawObject('Im1'),
    popGraphicsState(),
  );
  // pdf-lib wraps the content in a one-element array; exporters (and the iOS
  // JPEG path) use a single stream reference.
  const contents = page.node.Contents();
  if (contents instanceof PDFArray && contents.size() === 1) {
    page.node.set(PDFName.of('Contents'), contents.get(0));
  }
  const [w, s, e, n] = bbox;
  attachGeoViewport(
    doc,
    page,
    { x: 0, y: 0, w: 1400, h: 1050 },
    { topLeft: [w, n], topRight: [e, n], bottomRight: [e, s], bottomLeft: [w, s] },
  );
  const bytes = await doc.save();
  const parsed = parseGeoPdf(bytes);
  if (parsed.georeferences.length !== 1) {
    throw new Error(`large JPEG fixture failed to parse: ${parsed.warnings.join('; ')}`);
  }
  return bytes;
}

async function makeGeoPdf(label: string, bbox: CatalogBbox): Promise<Uint8Array> {
  // Fixed metadata so regeneration is byte-stable (no creation date).
  const doc = await PDFDocument.create({ updateMetadata: false });
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
    const pdf =
      spec.kind === 'large-jpeg'
        ? await makeLargeJpegGeoPdf(spec.bbox)
        : await makeGeoPdf(spec.label, spec.bbox);
    // Fixed mtime keeps the checked-in zip stable across regenerations. JPEG
    // bytes do not deflate; store them so the large fixture zips instantly.
    const zip = zipSync(
      { [`${spec.id}.pdf`]: pdf },
      { level: spec.kind === 'large-jpeg' ? 0 : 6, mtime: new Date('2026-01-01T00:00:00Z') },
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
