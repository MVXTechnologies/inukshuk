import { nearbyCatalogItems } from './nearby';
import type { CatalogCategory, CatalogItem } from './schema';

function sheetAt(id: string, lat: number, lon: number, category: CatalogCategory): CatalogItem {
  return {
    id,
    sourceId: 'src',
    title: id,
    category,
    bbox: [lon - 0.05, lat - 0.05, lon + 0.05, lat + 0.05],
    format: 'geopdf',
    packaging: 'none',
    url: `https://example.test/${id}.pdf`,
  };
}

const QUEBEC = { latitude: 46.8, longitude: -71.2 };

describe('nearbyCatalogItems', () => {
  it('returns nothing without a known position (the graceful fallback)', () => {
    expect(nearbyCatalogItems([sheetAt('a', 46.8, -71.2, 'topo')], null)).toEqual([]);
  });

  it('ranks by distance and reports it', () => {
    const near = sheetAt('near', 46.85, -71.2, 'topo');
    const far = sheetAt('far', 45.5, -73.6, 'topo');
    const [first, second] = nearbyCatalogItems([far, near], QUEBEC, { perCategory: 5 });
    expect(first?.item.id).toBe('near');
    expect(second?.item.id).toBe('far');
    expect(first?.distanceMeters).toBeLessThan(second?.distanceMeters ?? 0);
  });

  it('caps each category so the section stays a mix', () => {
    const items = [
      ...Array.from({ length: 6 }, (_, i) => sheetAt(`t${i}`, 46.8 + i * 0.01, -71.2, 'topo')),
      sheetAt('chart', 47.2, -70.6, 'nautical'),
      sheetAt('park', 47.4, -70.4, 'parks'),
    ];
    const picked = nearbyCatalogItems(items, QUEBEC, { limit: 6, perCategory: 2 });
    const categories = picked.map((p) => p.item.category);
    expect(categories.filter((c) => c === 'topo')).toHaveLength(2);
    expect(categories).toContain('nautical');
    expect(categories).toContain('parks');
  });

  // The published catalog is a SINGLE category (65 877 topo sheets). A fixed
  // per-category cap would silently shrink "Around you" to two rows there,
  // which is exactly what shipped: the e2e fixture has two categories and hid
  // it. The default cap must therefore scale with the categories in range.
  it('fills the limit when only one category is around (production shape)', () => {
    const items = Array.from({ length: 20 }, (_, i) =>
      sheetAt(`t${i}`, 46.8 + i * 0.01, -71.2, 'topo'),
    );
    expect(nearbyCatalogItems(items, QUEBEC, { limit: 5 })).toHaveLength(5);
  });

  it('still mixes categories when several are around, with no explicit cap', () => {
    const items = [
      ...Array.from({ length: 6 }, (_, i) => sheetAt(`t${i}`, 46.8 + i * 0.01, -71.2, 'topo')),
      sheetAt('chart', 47.2, -70.6, 'nautical'),
      sheetAt('park', 47.4, -70.4, 'parks'),
    ];
    const categories = nearbyCatalogItems(items, QUEBEC, { limit: 6 }).map((p) => p.item.category);
    // ceil(6 / 3 categories in range) = 2 rows each — the mix is preserved.
    expect(categories.filter((c) => c === 'topo')).toHaveLength(2);
    expect(categories).toContain('nautical');
    expect(categories).toContain('parks');
  });

  it('counts only the categories actually in range, not the vocabulary', () => {
    // A far-away chart is out of radius, so nautical must not reserve a share
    // of the limit and shrink the topo rows the user can actually reach.
    const items = [
      ...Array.from({ length: 8 }, (_, i) => sheetAt(`t${i}`, 46.8 + i * 0.01, -71.2, 'topo')),
      sheetAt('sydney-chart', -33.9, 151.2, 'nautical'),
    ];
    expect(nearbyCatalogItems(items, QUEBEC, { limit: 5 })).toHaveLength(5);
  });

  it('honours an explicit cap over the adaptive default', () => {
    const items = Array.from({ length: 20 }, (_, i) =>
      sheetAt(`t${i}`, 46.8 + i * 0.01, -71.2, 'topo'),
    );
    expect(nearbyCatalogItems(items, QUEBEC, { limit: 5, perCategory: 2 })).toHaveLength(2);
  });

  it('honours the overall limit', () => {
    const items = Array.from({ length: 20 }, (_, i) =>
      sheetAt(`t${i}`, 46.8 + i * 0.01, -71.2, i % 2 === 0 ? 'topo' : 'nautical'),
    );
    expect(nearbyCatalogItems(items, QUEBEC, { limit: 3, perCategory: 9 })).toHaveLength(3);
  });

  it('drops items beyond the radius rather than pretending they are near', () => {
    const sydney = sheetAt('sydney', -33.9, 151.2, 'nautical');
    expect(nearbyCatalogItems([sydney], QUEBEC)).toEqual([]);
    expect(nearbyCatalogItems([sydney], QUEBEC, { radiusMeters: 20_000_000 })).toHaveLength(1);
  });

  it('skips items that cannot be placed', () => {
    const placeless: CatalogItem = {
      id: 'x',
      sourceId: 'src',
      title: 'x',
      category: 'topo',
      format: 'pdf',
      packaging: 'none',
      url: 'https://example.test/x.pdf',
    };
    expect(nearbyCatalogItems([placeless], QUEBEC)).toEqual([]);
  });

  it('breaks distance ties by id so the section never reshuffles', () => {
    const a = sheetAt('aaa', 46.9, -71.2, 'topo');
    const b = sheetAt('bbb', 46.9, -71.2, 'topo');
    expect(nearbyCatalogItems([b, a], QUEBEC, { perCategory: 5 }).map((p) => p.item.id)).toEqual([
      'aaa',
      'bbb',
    ]);
  });
});
