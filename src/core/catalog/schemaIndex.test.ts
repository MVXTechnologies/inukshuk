import {
  CATALOG_INDEX_SCHEMA_VERSION,
  CATALOG_SCHEMA_VERSION,
  parseCatalogIndex,
  parseCatalogShard,
} from './schema';

/**
 * Guards the v2 wire shape (`/catalog/v2/index.json` + `shards/*.json`) and,
 * just as importantly, that a v1 flat manifest still parses into the same
 * in-memory index — that adapter is what keeps caches written by older builds,
 * and the two-file e2e fixture, working after the client moved to /v2/.
 */

const source = {
  id: 'noaa-charts',
  name: 'NOAA',
  licence: 'US-PD',
  attribution: 'NOAA Office of Coast Survey',
};

const item = (id: string, category = 'nautical') => ({
  id,
  sourceId: 'noaa-charts',
  title: id,
  category,
  bbox: [-71.5, 46.75, -71, 47],
  format: 'pdf',
  packaging: 'none',
  url: `https://example.test/${id}.pdf`,
});

const shardRef = (overrides: Record<string, unknown> = {}) => ({
  id: 'nautical-n40w080',
  category: 'nautical',
  path: 'shards/nautical-n40w080.json',
  itemCount: 12,
  bbox: [-72, 46, -70, 48],
  byteSize: 4096,
  ...overrides,
});

const index = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: CATALOG_INDEX_SCHEMA_VERSION,
  generatedAt: '2026-08-10T00:00:00Z',
  sources: [source],
  shards: [shardRef()],
  categoryCounts: { nautical: 12, topo: 30_000 },
  ...overrides,
});

describe('parseCatalogIndex — v2', () => {
  it('parses a well-formed index verbatim', () => {
    const { index: parsed, warnings } = parseCatalogIndex(index());
    expect(warnings).toEqual([]);
    expect(parsed?.generatedAt).toBe('2026-08-10T00:00:00Z');
    expect(parsed?.sources).toEqual([source]);
    expect(parsed?.shards).toEqual([shardRef()]);
    expect(parsed?.items).toEqual([]);
    expect(parsed?.categoryCounts).toEqual({ nautical: 12, topo: 30_000 });
  });

  it('accepts inline items alongside (or instead of) shards', () => {
    const { index: parsed, warnings } = parseCatalogIndex(
      index({ shards: [], items: [item('noaa-1')], categoryCounts: undefined }),
    );
    expect(warnings).toEqual([]);
    expect(parsed?.items.map((i) => i.id)).toEqual(['noaa-1']);
    // No declared counts ⇒ derived from the inline items, never "0 maps".
    expect(parsed?.categoryCounts).toEqual({ nautical: 1 });
  });

  it('rejects a document that is neither shards nor items', () => {
    const { index: parsed, warnings } = parseCatalogIndex(index({ shards: [], items: [] }));
    expect(parsed).toBeNull();
    expect(warnings.join(' ')).toContain('neither shards nor items');
  });

  it('rejects an unknown schema version by number, naming both accepted ones', () => {
    const { index: parsed, warnings } = parseCatalogIndex(index({ schemaVersion: 99 }));
    expect(parsed).toBeNull();
    expect(warnings[0]).toContain('99');
    expect(warnings[0]).toContain(String(CATALOG_INDEX_SCHEMA_VERSION));
  });

  it('rejects non-objects', () => {
    expect(parseCatalogIndex(null).index).toBeNull();
    expect(parseCatalogIndex([1, 2]).index).toBeNull();
    expect(parseCatalogIndex('nope').index).toBeNull();
  });

  it('drops malformed shard refs one at a time', () => {
    const { index: parsed, warnings } = parseCatalogIndex(
      index({
        shards: [
          shardRef(),
          shardRef({ id: 'Bad Id!' }),
          shardRef({ id: 'no-cat', category: 'submarine' }),
          shardRef({ id: 'no-count', itemCount: 0 }),
          shardRef({ id: 'not-an-object' }) && 7,
        ],
      }),
    );
    expect(parsed?.shards.map((s) => s.id)).toEqual(['nautical-n40w080']);
    expect(warnings).toHaveLength(4);
  });

  it('refuses shard paths that escape the catalog directory or point off-host', () => {
    const { index: parsed } = parseCatalogIndex(
      index({
        shards: [
          shardRef({ id: 'climb', path: '../../etc/passwd' }),
          shardRef({ id: 'absolute', path: '/etc/passwd' }),
          shardRef({ id: 'offhost', path: 'https://evil.test/shard.json' }),
          shardRef({ id: 'ok' }),
        ],
      }),
    );
    expect(parsed?.shards.map((s) => s.id)).toEqual(['ok']);
  });

  it('drops duplicate shard ids, keeping the first', () => {
    const { index: parsed, warnings } = parseCatalogIndex(
      index({ shards: [shardRef({ itemCount: 1 }), shardRef({ itemCount: 2 })] }),
    );
    expect(parsed?.shards).toHaveLength(1);
    expect(parsed?.shards[0]?.itemCount).toBe(1);
    expect(warnings.join(' ')).toContain('duplicate shard');
  });

  it('ignores unknown / non-positive category counts', () => {
    const { index: parsed } = parseCatalogIndex(
      index({ categoryCounts: { topo: 5, submarine: 9, parks: 0, nautical: 'many' } }),
    );
    expect(parsed?.categoryCounts).toEqual({ topo: 5 });
  });
});

describe('parseCatalogIndex — v1 adapter', () => {
  const v1 = {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    generatedAt: '2026-08-08T00:00:00Z',
    sources: [source],
    items: [item('noaa-1'), item('noaa-2', 'topo')],
  };

  it('adapts a flat manifest into a shardless index', () => {
    const { index: parsed, warnings } = parseCatalogIndex(v1);
    expect(warnings).toEqual([]);
    expect(parsed?.schemaVersion).toBe(CATALOG_INDEX_SCHEMA_VERSION);
    expect(parsed?.shards).toEqual([]);
    expect(parsed?.items.map((i) => i.id)).toEqual(['noaa-1', 'noaa-2']);
    expect(parsed?.categoryCounts).toEqual({ nautical: 1, topo: 1 });
    expect(parsed?.generatedAt).toBe('2026-08-08T00:00:00Z');
  });

  it('propagates an unusable v1 manifest as a null index', () => {
    const { index: parsed, warnings } = parseCatalogIndex({
      schemaVersion: CATALOG_SCHEMA_VERSION,
      sources: [source],
    });
    expect(parsed).toBeNull();
    expect(warnings.join(' ')).toContain('no items array');
  });
});

describe('parseCatalogShard', () => {
  const sourceIds = new Set(['noaa-charts']);

  it('parses a shard document', () => {
    const { items, warnings } = parseCatalogShard(
      { id: 'nautical-n40w080', items: [item('a'), item('b')] },
      sourceIds,
    );
    expect(warnings).toEqual([]);
    expect(items.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('parses a bare array too', () => {
    expect(parseCatalogShard([item('a')], sourceIds).items).toHaveLength(1);
  });

  it('drops rows whose source the index never declared', () => {
    const { items, warnings } = parseCatalogShard(
      [item('a'), { ...item('b'), sourceId: 'smuggled' }],
      sourceIds,
    );
    expect(items.map((i) => i.id)).toEqual(['a']);
    expect(warnings.join(' ')).toContain('unknown sourceId');
  });

  it('drops duplicate item ids within a shard', () => {
    const { items, warnings } = parseCatalogShard([item('a'), item('a')], sourceIds);
    expect(items).toHaveLength(1);
    expect(warnings.join(' ')).toContain('duplicate item');
  });

  it('is total: garbage in, empty items out', () => {
    expect(parseCatalogShard(null, sourceIds)).toEqual({
      items: [],
      warnings: ['shard has no items array'],
    });
    expect(parseCatalogShard(undefined, sourceIds)).toEqual({ items: [], warnings: [] });
    expect(parseCatalogShard({ items: 'nope' }, sourceIds).items).toEqual([]);
  });
});
