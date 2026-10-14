import {
  categoryForKind,
  countFacets,
  filterExploreItems,
  formatMapCount,
  formatMapScale,
  isExploreFilterEmpty,
  kindFromCategory,
  matchesExploreFilter,
  scopedFacetCounts,
  type FacetsOf,
  type ItemFacets,
} from './exploreFacets';
import type { CatalogItem } from './schema';

const item = (id: string, over: Partial<CatalogItem> = {}): CatalogItem => ({
  id,
  sourceId: 'nrcan',
  title: `Sheet ${id}`,
  category: 'topo',
  format: 'geopdf',
  packaging: 'none',
  url: `https://example.test/${id}.pdf`,
  ...over,
});

const facets: Record<string, ItemFacets> = {
  a: { kind: 'topo', activities: ['hiking', 'ski'], terrain: ['mountains'] },
  b: { kind: 'park', activities: ['hiking'], terrain: ['water'] },
  c: { kind: 'nautical', activities: ['paddling'], terrain: ['coast', 'water'] },
};
const facetsOf: FacetsOf = (i) => facets[i.id] ?? { kind: null, activities: [], terrain: [] };

const items = [
  item('a', { title: 'Mont Tremblant' }),
  item('b', { sourceId: 'sepaq', title: 'Jacques-Cartier' }),
  item('c', { title: 'Rivière Saguenay' }),
];

describe('explore filter', () => {
  it('an empty filter returns the same array', () => {
    expect(isExploreFilterEmpty({})).toBe(true);
    expect(isExploreFilterEmpty({ text: '  ' })).toBe(true);
    expect(filterExploreItems(items, {}, facetsOf)).toBe(items);
  });

  it('filters by kind, activity, terrain and source', () => {
    const ids = (f: Parameters<typeof filterExploreItems>[1]) =>
      filterExploreItems(items, f, facetsOf).map((i) => i.id);
    expect(ids({ kind: 'park' })).toEqual(['b']);
    expect(ids({ activity: 'hiking' })).toEqual(['a', 'b']);
    expect(ids({ terrain: 'water' })).toEqual(['b', 'c']);
    expect(ids({ sourceId: 'nrcan' })).toEqual(['a', 'c']);
    expect(ids({ activity: 'hiking', terrain: 'water' })).toEqual(['b']);
  });

  it('text is diacritic-folded and combines with facets', () => {
    expect(matchesExploreFilter(items[2]!, { text: 'riviere' }, facetsOf)).toBe(true);
    expect(matchesExploreFilter(items[2]!, { text: 'riviere', kind: 'topo' }, facetsOf)).toBe(
      false,
    );
  });
});

describe('countFacets', () => {
  it('counts every facet value and source', () => {
    const counts = countFacets(items, facetsOf);
    expect(counts.kinds).toEqual({ topo: 1, park: 1, nautical: 1 });
    expect(counts.activities).toEqual({ hiking: 2, ski: 1, paddling: 1 });
    expect(counts.terrains).toEqual({ mountains: 1, water: 2, coast: 1 });
    expect(counts.sources).toEqual({ nrcan: 2, sepaq: 1 });
  });

  it('skips a null kind', () => {
    expect(countFacets([item('z')], facetsOf).kinds).toEqual({});
  });
});

describe('legacy category → kind', () => {
  it('maps every category', () => {
    expect(kindFromCategory('parks')).toBe('park');
    expect(kindFromCategory('hunting')).toBe('hunting-fishing');
    expect(kindFromCategory('forest')).toBe('topo');
  });

  it('names the one category holding a kind, else null', () => {
    expect(categoryForKind('nautical')).toBe('nautical');
    // topo is implied by both "topo" and "forest".
    expect(categoryForKind('topo')).toBeNull();
    expect(categoryForKind('historical')).toBeNull();
    expect(categoryForKind(null)).toBeNull();
  });
});

describe('formatting', () => {
  it('formats a scale', () => {
    expect(formatMapScale(25000)).toBe('1:25 000');
    expect(formatMapScale(1000000)).toBe('1:1 000 000');
    expect(formatMapScale(0)).toBe('');
  });

  it('formats a map count', () => {
    expect(formatMapCount(1)).toBe('1 map');
    expect(formatMapCount(14200)).toBe('14 200 maps');
    expect(formatMapCount(0)).toBe('0 maps');
  });
});

describe('scopedFacetCounts (2.5.2 QA: Type counts inside a collection)', () => {
  it('without a collection, counts everything loaded', () => {
    expect(scopedFacetCounts(items, {}, facetsOf)).toEqual(countFacets(items, facetsOf));
  });

  it('inside a collection, Type, Activity and Terrain count only its maps', () => {
    const c = scopedFacetCounts(items, { sourceId: 'sepaq' }, facetsOf);
    expect(c.kinds).toEqual({ park: 1 });
    expect(c.activities).toEqual({ hiking: 1 });
    expect(c.terrains).toEqual({ water: 1 });
    // A count offered is a count listed: tapping each value lists exactly that many.
    for (const [kind, n] of Object.entries(c.kinds)) {
      expect(
        filterExploreItems(items, { sourceId: 'sepaq', kind: kind as never }, facetsOf),
      ).toHaveLength(n);
    }
  });

  it('keeps the Source counts over everything, so another publisher still says what it holds', () => {
    const c = scopedFacetCounts(items, { sourceId: 'sepaq' }, facetsOf);
    expect(c.sources).toEqual({ nrcan: 2, sepaq: 1 });
  });

  it('a collection with nothing loaded yet offers no values', () => {
    const c = scopedFacetCounts(items, { sourceId: 'cartes-plein-air' }, facetsOf);
    expect(c.kinds).toEqual({});
    expect(c.activities).toEqual({});
    expect(c.terrains).toEqual({});
  });
});
