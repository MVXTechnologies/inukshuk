import type { CatalogIndex, CatalogItem } from '@core/catalog/schema';

import { indexFacetCounts, itemFacets, itemScaleDenominator } from './facetsAdapter';

const base: CatalogItem = {
  id: 'a',
  sourceId: 's',
  title: 'A',
  category: 'parks',
  format: 'geopdf',
  packaging: 'none',
  url: 'https://example.test/a.pdf',
};

/** An item as the data branch will ship it: extra wire fields on the object. */
const withWire = (extra: Record<string, unknown>): CatalogItem =>
  ({ ...base, ...extra }) as unknown as CatalogItem;

describe('itemFacets', () => {
  it('falls back to the category kind and empty facets on a legacy item', () => {
    expect(itemFacets(base)).toEqual({ kind: 'park', activities: [], terrain: [] });
  });

  it('reads the wire fields, dropping unknown and duplicate values', () => {
    const item = withWire({
      kind: 'trail',
      activities: ['hiking', 'moonwalk', 'hiking', 3],
      terrain: ['mountains', 'lava'],
    });
    expect(itemFacets(item)).toEqual({
      kind: 'trail',
      activities: ['hiking'],
      terrain: ['mountains'],
    });
  });

  it('ignores an unknown kind', () => {
    expect(itemFacets(withWire({ kind: 'spaceport' })).kind).toBe('park');
  });
});

describe('itemScaleDenominator', () => {
  it('reads a number or a "1:n" string', () => {
    expect(itemScaleDenominator(withWire({ scale: 25000 }))).toBe(25000);
    expect(itemScaleDenominator(withWire({ scale: '1:50 000' }))).toBe(50000);
    expect(itemScaleDenominator(withWire({ scale: 'large' }))).toBeNull();
    expect(itemScaleDenominator(base)).toBeNull();
  });
});

describe('indexFacetCounts', () => {
  const index = (extra: Record<string, unknown>): CatalogIndex =>
    ({
      schemaVersion: 2,
      sources: [],
      shards: [],
      items: [],
      categoryCounts: {},
      ...extra,
    }) as unknown as CatalogIndex;

  it('is null for an index from before the taxonomy', () => {
    expect(indexFacetCounts(index({}))).toBeNull();
    expect(indexFacetCounts(null)).toBeNull();
  });

  it('reads flat counts and drops unknown keys', () => {
    expect(
      indexFacetCounts(
        index({ activityCounts: { hiking: 12, moonwalk: 3, ski: 0 }, sourceCounts: { s: 5 } }),
      ),
    ).toEqual({ activities: { hiking: 12, ski: 0 }, sources: { s: 5 } });
  });

  it('reads nested facetCounts', () => {
    expect(
      indexFacetCounts(index({ facetCounts: { terrains: { glacier: 4 }, kinds: { park: 2 } } })),
    ).toEqual({ terrains: { glacier: 4 }, kinds: { park: 2 } });
  });
});
