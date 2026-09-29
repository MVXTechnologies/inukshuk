import {
  CATALOG_INDEX_SCHEMA_VERSION,
  parseCatalogIndex,
  parseCatalogManifest,
  parseCatalogShard,
  parseFacetCounts,
} from './schema';
import { CATALOG_KINDS } from './taxonomy';

/**
 * The explorer taxonomy fields are additive: optional on every item and on
 * the index, sanitized (unknown values dropped) and never a reason to drop an
 * item — so a newer generator can add a kind or terrain without blanking the
 * store of an app that predates it.
 */

const source = { id: 'src', name: 'Src', licence: 'PD', attribution: 'Src' };
const sourceIds = new Set(['src']);

const item = (overrides: Record<string, unknown> = {}) => ({
  id: 'a',
  sourceId: 'src',
  title: 'A',
  category: 'topo',
  bbox: [-71.5, 46.75, -71, 47],
  format: 'geopdf',
  packaging: 'none',
  url: 'https://example.test/a.pdf',
  ...overrides,
});

describe('item taxonomy fields', () => {
  it('parses kind, activities, terrain and scale', () => {
    const { items, warnings } = parseCatalogShard(
      [
        item({
          kind: 'park',
          activities: ['hiking', 'camping'],
          terrain: ['mountains', 'water'],
          scale: 24000,
        }),
      ],
      sourceIds,
    );
    expect(warnings).toEqual([]);
    expect(items[0]).toMatchObject({
      kind: 'park',
      activities: ['hiking', 'camping'],
      terrain: ['mountains', 'water'],
      scale: 24000,
    });
  });

  it('drops unknown values but keeps the item', () => {
    const { items, warnings } = parseCatalogShard(
      [
        item({
          kind: 'spaceship',
          activities: ['hiking', 'jetpack', 7, null],
          terrain: 'mountains',
          scale: -3,
        }),
      ],
      sourceIds,
    );
    expect(warnings).toEqual([]);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBeUndefined();
    expect(items[0]?.activities).toEqual(['hiking']);
    expect(items[0]?.terrain).toBeUndefined();
    expect(items[0]?.scale).toBeUndefined();
  });

  it('de-duplicates facet lists into vocabulary order and omits empty ones', () => {
    const { items } = parseCatalogShard(
      [
        item({
          activities: ['fishing', 'hiking', 'fishing'],
          terrain: ['coast', 'mountains', 'unknown'],
        }),
        item({ id: 'b', activities: ['nope'], terrain: [] }),
      ],
      sourceIds,
    );
    expect(items[0]?.activities).toEqual(['hiking', 'fishing']);
    expect(items[0]?.terrain).toEqual(['mountains', 'coast']);
    expect(items[1]).not.toHaveProperty('activities');
    expect(items[1]).not.toHaveProperty('terrain');
  });

  it('rounds a fractional scale and ignores non-numbers', () => {
    const { items } = parseCatalogShard(
      [item({ scale: 24000.4 }), item({ id: 'b', scale: '24000' })],
      sourceIds,
    );
    expect(items[0]?.scale).toBe(24000);
    expect(items[1]?.scale).toBeUndefined();
  });

  it('carries the fields through a v1 manifest too', () => {
    const { manifest } = parseCatalogManifest({
      schemaVersion: 1,
      sources: [source],
      items: [item({ kind: 'topo', terrain: ['glacier'] })],
    });
    expect(manifest?.items[0]).toMatchObject({ kind: 'topo', terrain: ['glacier'] });
  });
});

describe('index facet counts and side documents', () => {
  const index = (overrides: Record<string, unknown> = {}) => ({
    schemaVersion: CATALOG_INDEX_SCHEMA_VERSION,
    sources: [source],
    shards: [
      { id: 'topo-n40w080', category: 'topo', path: 'shards/topo-n40w080.json', itemCount: 3 },
    ],
    categoryCounts: { topo: 3 },
    ...overrides,
  });

  it('is unchanged for an index without them (the published shape before the explorer)', () => {
    const { index: parsed, warnings } = parseCatalogIndex(index());
    expect(warnings).toEqual([]);
    expect(parsed).not.toHaveProperty('kindCounts');
    expect(parsed).not.toHaveProperty('activityCounts');
    expect(parsed).not.toHaveProperty('terrainCounts');
    expect(parsed).not.toHaveProperty('facets');
    expect(parsed).not.toHaveProperty('collections');
  });

  it('parses global counts, dropping unknown keys and non-positive values', () => {
    const { index: parsed } = parseCatalogIndex(
      index({
        kindCounts: { topo: 3, rocket: 9 },
        activityCounts: { hiking: 2, paddling: 0, fishing: 1.6 },
        terrainCounts: { mountains: 1, lava: 4, water: 'many' },
      }),
    );
    expect(parsed?.kindCounts).toEqual({ topo: 3 });
    expect(parsed?.activityCounts).toEqual({ hiking: 2, fishing: 2 });
    expect(parsed?.terrainCounts).toEqual({ mountains: 1 });
  });

  it('parses the facets and collections pointers with the shard path rules', () => {
    const { index: parsed } = parseCatalogIndex(
      index({
        facets: { path: 'facets.json', byteSize: 1234, tokenCount: 9 },
        collections: { path: 'collections.json' },
      }),
    );
    expect(parsed?.facets).toEqual({ path: 'facets.json', byteSize: 1234 });
    expect(parsed?.collections).toEqual({ path: 'collections.json' });

    const { index: hostile } = parseCatalogIndex(
      index({
        facets: { path: '../../etc/passwd' },
        collections: { path: 'https://evil.test/c.json' },
      }),
    );
    expect(hostile).not.toHaveProperty('facets');
    expect(hostile).not.toHaveProperty('collections');
  });

  it('parseFacetCounts returns undefined for a non-object', () => {
    expect(parseFacetCounts(null, CATALOG_KINDS)).toBeUndefined();
    expect(parseFacetCounts([1, 2], CATALOG_KINDS)).toBeUndefined();
    expect(parseFacetCounts({}, CATALOG_KINDS)).toEqual({});
  });
});
