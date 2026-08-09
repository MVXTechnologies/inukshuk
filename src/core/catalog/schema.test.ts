import { CATALOG_SCHEMA_VERSION, parseCatalogManifest } from './schema';

const source = {
  id: 'nrcan-cantopo',
  name: 'NRCan CanTopo',
  licence: 'OGL-Canada-2.0',
  attribution: 'Natural Resources Canada',
  homepage: 'https://natural-resources.canada.ca',
};

const item = {
  id: 'cantopo-021l14',
  sourceId: 'nrcan-cantopo',
  title: 'Québec — CanTopo 021L14',
  category: 'topo',
  region: 'CA-QC',
  bbox: [-71.5, 46.75, -71, 47],
  format: 'geopdf',
  packaging: 'zip',
  sizeBytes: 5137057,
  url: 'https://ftp.maps.canada.ca/pub/cantopo_021l14_geopdf.zip',
  updatedAt: '2019-07-24',
  lang: 'fr',
};

const manifest = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: CATALOG_SCHEMA_VERSION,
  generatedAt: '2026-08-08T00:00:00Z',
  sources: [source],
  items: [item],
  ...overrides,
});

describe('parseCatalogManifest', () => {
  it('parses a well-formed manifest verbatim', () => {
    const { manifest: parsed, warnings } = parseCatalogManifest(manifest());
    expect(warnings).toEqual([]);
    expect(parsed).not.toBeNull();
    expect(parsed?.generatedAt).toBe('2026-08-08T00:00:00Z');
    expect(parsed?.sources).toEqual([source]);
    expect(parsed?.items).toEqual([item]);
  });

  it('rejects non-object documents with a reason', () => {
    for (const junk of [null, undefined, 42, 'manifest', [1, 2]]) {
      const { manifest: parsed, warnings } = parseCatalogManifest(junk);
      expect(parsed).toBeNull();
      expect(warnings).toHaveLength(1);
    }
  });

  it('rejects an unknown schemaVersion (future /v2/ content must not half-render)', () => {
    const { manifest: parsed, warnings } = parseCatalogManifest(manifest({ schemaVersion: 2 }));
    expect(parsed).toBeNull();
    expect(warnings[0]).toContain('schemaVersion 2');
  });

  it('rejects a manifest without an items array', () => {
    const { manifest: parsed } = parseCatalogManifest(manifest({ items: 'none' }));
    expect(parsed).toBeNull();
  });

  it('drops malformed items one by one instead of failing the manifest', () => {
    const { manifest: parsed, warnings } = parseCatalogManifest(
      manifest({
        items: [
          item,
          null,
          { ...item, id: 'no-url', url: undefined },
          { ...item, id: 'ftp-url', url: 'ftp://example.com/x.zip' },
          { ...item, id: 'bad-category', category: 'submarine' },
          { ...item, id: 'geotiff-item', format: 'geotiff' }, // M3 — not downloadable yet
          { ...item, id: 'no-title', title: '   ' },
        ],
      }),
    );
    expect(parsed?.items.map((i) => i.id)).toEqual(['cantopo-021l14']);
    expect(warnings).toHaveLength(6);
  });

  it('drops items whose sourceId has no source (no attribution ⇒ no listing)', () => {
    const { manifest: parsed, warnings } = parseCatalogManifest(
      manifest({ items: [{ ...item, sourceId: 'mystery' }] }),
    );
    expect(parsed?.items).toEqual([]);
    expect(warnings[0]).toContain('unknown sourceId');
  });

  it('keeps the first of duplicate item ids', () => {
    const { manifest: parsed, warnings } = parseCatalogManifest(
      manifest({ items: [item, { ...item, title: 'Impostor' }] }),
    );
    expect(parsed?.items).toHaveLength(1);
    expect(parsed?.items[0]?.title).toBe('Québec — CanTopo 021L14');
    expect(warnings[0]).toContain('duplicate item');
  });

  it('drops malformed sources and duplicate source ids', () => {
    const { manifest: parsed, warnings } = parseCatalogManifest(
      manifest({ sources: [source, { id: 'x' }, { ...source, name: 'Copy' }], items: [] }),
    );
    expect(parsed?.sources).toEqual([source]);
    expect(warnings).toHaveLength(2);
  });

  it('sanitizes optional fields instead of dropping the item', () => {
    const { manifest: parsed, warnings } = parseCatalogManifest(
      manifest({
        items: [
          {
            ...item,
            bbox: [-71.5, 47, -71, 46.75], // inverted south/north
            sizeBytes: -3,
            lang: 'klingon',
            region: '',
            packaging: 'tarball',
            sidecar: 'not a url',
          },
        ],
      }),
    );
    expect(warnings).toEqual([]);
    const parsedItem = parsed?.items[0];
    expect(parsedItem).toBeDefined();
    expect(parsedItem).not.toHaveProperty('bbox');
    expect(parsedItem).not.toHaveProperty('sizeBytes');
    expect(parsedItem).not.toHaveProperty('lang');
    expect(parsedItem).not.toHaveProperty('region');
    expect(parsedItem).not.toHaveProperty('sidecar');
    expect(parsedItem?.packaging).toBe('none'); // unknown packaging → plain file
  });

  it('accepts http URLs (the e2e fixture manifest serves from loopback)', () => {
    const { manifest: parsed } = parseCatalogManifest(
      manifest({ items: [{ ...item, url: 'http://127.0.0.1:8787/fixture.zip' }] }),
    );
    expect(parsed?.items).toHaveLength(1);
  });

  it('tolerates a missing sources array (items then all drop)', () => {
    const { manifest: parsed, warnings } = parseCatalogManifest(manifest({ sources: undefined }));
    expect(parsed?.sources).toEqual([]);
    expect(parsed?.items).toEqual([]);
    expect(warnings).toHaveLength(1);
  });
});
