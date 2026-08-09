/**
 * Catalog generator — build the E2E/test fixture: two tiny CanTopo-style
 * zipped GeoPDFs plus a fixture manifest pointing at a loopback server.
 *
 * The Maestro flow (.maestro/store.yaml) serves `.maestro/fixtures/catalog/`
 * on http://127.0.0.1:8787 (adb reverse maps the emulator's loopback to the
 * host), and the e2e APK is built with
 * `CATALOG_MANIFEST_URL=http://127.0.0.1:8787/manifest.json` — CI never
 * touches NRCan. The PDFs are written by the app's own GeoPDF writer
 * (`attachGeoViewport`) and verified with the app's own parser before the
 * fixture is accepted, so the download → import path exercises the real thing.
 *
 * Usage:
 *   npx tsx scripts/catalog/make-fixture.ts
 *
 * Output (checked in): .maestro/fixtures/catalog/{manifest.json,*.zip}
 */
import { zipSync } from 'fflate';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

import { ntsSheetBbox } from '../../src/core/catalog/nts';
import {
  CATALOG_SCHEMA_VERSION,
  parseCatalogManifest,
  type CatalogItem,
} from '../../src/core/catalog/schema';
import { parseGeoPdf } from '../../src/core/geo/geopdf';
import { attachGeoViewport } from '../../src/core/geo/geopdf/write';

const BASE_URL = 'http://127.0.0.1:8787';

/** Real 021L sheets (toponyms from NRCan's NTS index) so search behaves realistically. */
const SHEETS = [
  { sheet: '021L14', toponym: 'Québec' },
  { sheet: '021L13', toponym: 'Saint-Raymond' },
] as const;

async function makeGeoPdf(sheet: string, toponym: string): Promise<Uint8Array> {
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
  page.drawText(`CanTopo fixture — ${toponym} (${sheet})`, {
    x: 60,
    y: 720,
    size: 18,
    font,
    color: rgb(0.2, 0.2, 0.2),
  });
  page.drawText('E2E fixture GeoPDF — not a real map', {
    x: 60,
    y: 694,
    size: 11,
    font,
    color: rgb(0.4, 0.4, 0.4),
  });

  const bbox = ntsSheetBbox(sheet);
  if (bbox === null) throw new Error(`bad sheet id ${sheet}`);
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
    throw new Error(`fixture ${sheet} failed to parse: ${parsed.warnings.join('; ')}`);
  }
  return bytes;
}

async function main(): Promise<void> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const outDir = join(scriptDir, '..', '..', '.maestro', 'fixtures', 'catalog');
  mkdirSync(outDir, { recursive: true });

  const items: CatalogItem[] = [];
  for (const { sheet, toponym } of SHEETS) {
    const sheetLower = sheet.toLowerCase();
    const pdf = await makeGeoPdf(sheet, toponym);
    const zipName = `cantopo_${sheetLower}_geopdf.zip`;
    // Fixed mtime keeps the checked-in zip stable across regenerations.
    const zip = zipSync(
      { [`cantopo_${sheetLower}.pdf`]: pdf },
      { level: 6, mtime: new Date('2026-01-01T00:00:00Z') },
    );
    writeFileSync(join(outDir, zipName), zip);
    const bbox = ntsSheetBbox(sheet);
    items.push({
      id: `cantopo-${sheetLower}`,
      sourceId: 'nrcan-cantopo',
      title: `${toponym} — CanTopo ${sheet}`,
      category: 'topo',
      ...(bbox !== null ? { bbox } : {}),
      format: 'geopdf',
      packaging: 'zip',
      sizeBytes: zip.length,
      url: `${BASE_URL}/${zipName}`,
      updatedAt: '2026-01-01',
      lang: 'bilingual',
    });
    console.log(`${zipName}: ${zip.length} bytes (pdf ${pdf.length})`);
  }

  const manifest = {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    generatedAt: '2026-01-01T00:00:00Z',
    sources: [
      {
        id: 'nrcan-cantopo',
        name: 'NRCan CanTopo',
        licence: 'OGL-Canada-2.0',
        attribution: 'Natural Resources Canada',
        homepage: 'https://natural-resources.canada.ca',
      },
    ],
    items,
  };
  const { manifest: parsed, warnings } = parseCatalogManifest(manifest);
  if (parsed === null || warnings.length > 0) {
    throw new Error(`fixture manifest failed validation: ${warnings.join('; ')}`);
  }
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${join(outDir, 'manifest.json')} (${items.length} items)`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
