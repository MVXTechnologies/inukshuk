import {
  buildCatalogFacets,
  CATALOG_FACETS_SCHEMA_VERSION,
  countFacets,
  parseCatalogFacets,
  serializeCatalogFacets,
  shardIdsForFacetFilter,
  shardIdsWithFacet,
} from './facets';
import type { CatalogItem } from './schema';

const item = (id: string, extra: Partial<CatalogItem> = {}): CatalogItem => ({
  id,
  sourceId: 'usgs-ustopo',
  title: id,
  category: 'topo',
  format: 'geopdf',
  packaging: 'none',
  url: `https://example.test/${id}.pdf`,
  ...extra,
});

describe('countFacets', () => {
  it('counts kinds (derived when absent), browse activities and terrain', () => {
    const counts = countFacets([
      item('a', { kind: 'topo', terrain: ['mountains', 'glacier'] }),
      item('b', { terrain: ['water'] }),
      item('c', { kind: 'park', activities: ['ski'], terrain: ['mountains'] }),
      item('d'),
    ]);
    expect(counts.kinds).toEqual({ topo: 3, park: 1 });
    // a: hiking + climbing (terrain); b: paddling + fishing; c: ski only (explicit wins).
    expect(counts.activities).toEqual({ hiking: 1, climbing: 1, paddling: 1, fishing: 1, ski: 1 });
    expect(counts.terrain).toEqual({ mountains: 2, glacier: 1, water: 1 });
  });
});

describe('facets digest', () => {
  const facets = buildCatalogFacets([
    { id: 'topo-n40w080', items: [item('a', { terrain: ['glacier'] })] },
    { id: 'topo-n30w090', items: [item('b')] },
  ]);

  it('round-trips through the wire form, which omits empty groups', () => {
    const wire = serializeCatalogFacets(facets) as { shards: Record<string, object> };
    expect(wire.shards['topo-n30w090']).toEqual({ kinds: { topo: 1 } });
    const { facets: parsed, warnings } = parseCatalogFacets(JSON.parse(JSON.stringify(wire)));
    expect(warnings).toEqual([]);
    expect(parsed).toEqual(facets);
  });

  it('lists the shards holding a facet value', () => {
    expect(shardIdsWithFacet(facets, 'terrain', 'glacier')).toEqual(['topo-n40w080']);
    expect(shardIdsWithFacet(facets, 'activities', 'climbing')).toEqual(['topo-n40w080']);
    expect(shardIdsWithFacet(facets, 'kinds', 'topo')).toEqual(['topo-n40w080', 'topo-n30w090']);
    expect(shardIdsWithFacet(facets, 'terrain', 'coast')).toEqual([]);
  });

  it('intersects the set facets for a filter, and is null when none is set (#474)', () => {
    const three = buildCatalogFacets([
      { id: 'glacier', items: [item('a', { terrain: ['mountains', 'glacier'] })] },
      { id: 'hills', items: [item('b', { terrain: ['mountains'] })] },
      { id: 'park', items: [item('c', { kind: 'park', terrain: ['mountains'] })] },
    ]);
    expect(shardIdsForFacetFilter(three, {})).toBeNull();
    expect(shardIdsForFacetFilter(three, { kind: null, activity: null })).toBeNull();
    // Hiking counts the terrain affinity, like the index's activityCounts.
    expect([...(shardIdsForFacetFilter(three, { activity: 'hiking' }) ?? [])]).toEqual([
      'glacier',
      'hills',
      'park',
    ]);
    expect([
      ...(shardIdsForFacetFilter(three, { activity: 'hiking', terrain: 'glacier' }) ?? []),
    ]).toEqual(['glacier']);
    expect([
      ...(shardIdsForFacetFilter(three, { kind: 'park', terrain: 'mountains' }) ?? []),
    ]).toEqual(['park']);
    expect(shardIdsForFacetFilter(three, { terrain: 'coast' })?.size).toBe(0);
  });

  it('rejects unusable documents and drops malformed entries', () => {
    expect(parseCatalogFacets(null).facets).toBeNull();
    expect(parseCatalogFacets({ schemaVersion: 99, shards: {} }).facets).toBeNull();
    expect(parseCatalogFacets({ schemaVersion: CATALOG_FACETS_SCHEMA_VERSION }).facets).toBeNull();
    const { facets: parsed, warnings } = parseCatalogFacets({
      schemaVersion: CATALOG_FACETS_SCHEMA_VERSION,
      shards: { bad: 3, ok: { terrain: { lava: 2, coast: 1 } } },
    });
    expect(warnings).toHaveLength(1);
    expect(parsed?.shards).toEqual({ ok: { kinds: {}, activities: {}, terrain: { coast: 1 } } });
  });
});
