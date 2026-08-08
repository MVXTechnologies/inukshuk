import {
  categoriesPresent,
  filterCatalogItems,
  foldText,
  matchesCatalogFilter,
} from './filterCatalog';
import { CATALOG_CATEGORIES, type CatalogItem } from './schema';

const mk = (id: string, title: string, category: CatalogItem['category'] = 'topo'): CatalogItem => ({
  id,
  sourceId: 'src',
  title,
  category,
  format: 'geopdf',
  packaging: 'zip',
  url: `https://example.com/${id}.zip`,
  region: 'CA-QC',
});

const items = [
  mk('cantopo-021l14', 'Québec — CanTopo 021L14'),
  mk('cantopo-021m03', 'Rivière-à-Pierre — CanTopo 021M03'),
  mk('gsc-123', 'Geologie de la Gaspésie', 'geological'),
];

describe('foldText', () => {
  it('folds diacritics and case', () => {
    expect(foldText('Rivière-à-Pierre')).toBe('riviere-a-pierre');
    expect(foldText('QUÉBEC')).toBe('quebec');
    expect(foldText('Gaspésie')).toBe('gaspesie');
  });
});

describe('matchesCatalogFilter / filterCatalogItems', () => {
  it('matches accent-free queries against accented titles', () => {
    const out = filterCatalogItems(items, { text: 'riviere' });
    expect(out.map((i) => i.id)).toEqual(['cantopo-021m03']);
  });

  it('matches accented queries against the folded haystack too', () => {
    const out = filterCatalogItems(items, { text: 'Québec' });
    expect(out.map((i) => i.id)).toEqual(['cantopo-021l14']);
  });

  it('requires every token (AND semantics) across title and id', () => {
    expect(filterCatalogItems(items, { text: 'cantopo 021m' })).toHaveLength(1);
    expect(filterCatalogItems(items, { text: 'cantopo mordor' })).toHaveLength(0);
  });

  it('matches on the sheet id', () => {
    expect(filterCatalogItems(items, { text: '021L14' })[0]?.id).toBe('cantopo-021l14');
  });

  it('filters by category chip, combined with text', () => {
    expect(filterCatalogItems(items, { category: 'geological' })).toHaveLength(1);
    expect(filterCatalogItems(items, { category: 'geological', text: 'cantopo' })).toHaveLength(0);
    const geology = mk('gsc-123', 'Geologie de la Gaspésie', 'geological');
    expect(matchesCatalogFilter(geology, { category: 'geological', text: 'gaspesie' })).toBe(true);
  });

  it('returns the input array untouched when no criterion is active', () => {
    expect(filterCatalogItems(items, {})).toBe(items);
    expect(filterCatalogItems(items, { text: '   ', category: null })).toBe(items);
  });
});

describe('categoriesPresent', () => {
  it('lists present categories in fixed vocabulary order', () => {
    expect(categoriesPresent(items, CATALOG_CATEGORIES)).toEqual(['topo', 'geological']);
  });

  it('is empty for an empty catalog', () => {
    expect(categoriesPresent([], CATALOG_CATEGORIES)).toEqual([]);
  });
});
