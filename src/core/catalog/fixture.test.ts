import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseGeoPdf } from '../geo/geopdf';
import { parseCatalogManifest } from './schema';
import { extractPdf } from './unzip';

/**
 * Guards the CHECKED-IN e2e fixture (`.maestro/fixtures/catalog/`, generated
 * by scripts/catalog/make-fixture.ts): the Maestro store flow and the CI
 * fixture server depend on these exact files, so a fixture that stops parsing
 * must fail unit tests long before a nightly e2e run discovers it.
 */

const FIXTURE_DIR = join(__dirname, '..', '..', '..', '.maestro', 'fixtures', 'catalog');

const manifestRaw: unknown = JSON.parse(readFileSync(join(FIXTURE_DIR, 'manifest.json'), 'utf8'));

describe('checked-in e2e fixture catalog', () => {
  it('parses clean through the app manifest parser', () => {
    const { manifest, warnings } = parseCatalogManifest(manifestRaw);
    expect(warnings).toEqual([]);
    expect(manifest).not.toBeNull();
    expect(manifest?.items.length).toBeGreaterThanOrEqual(2);
    // The store flow types "raymond" and expects exactly one of the two rows
    // to survive — both sheets must stay present under these titles.
    const titles = manifest?.items.map((i) => i.title) ?? [];
    expect(titles).toContain('Québec — CanTopo 021L14');
    expect(titles).toContain('Saint-Raymond — CanTopo 021L13');
    // Loopback URLs only — a fixture pointing at the real internet would let
    // CI silently depend on NRCan.
    for (const item of manifest?.items ?? []) {
      expect(item.url.startsWith('http://127.0.0.1:8787/')).toBe(true);
    }
  });

  it('ships zips whose PDFs our importer can georeference', () => {
    const { manifest } = parseCatalogManifest(manifestRaw);
    for (const item of manifest?.items ?? []) {
      const fileName = item.url.split('/').pop() ?? '';
      const zip = readFileSync(join(FIXTURE_DIR, fileName));
      expect(zip.byteLength).toBe(item.sizeBytes); // manifest sizes are real
      const pdf = extractPdf(new Uint8Array(zip));
      expect(pdf).not.toBeNull();
      const parsed = parseGeoPdf(pdf ?? new Uint8Array());
      expect(parsed.georeferences).toHaveLength(1);
    }
  });
});
