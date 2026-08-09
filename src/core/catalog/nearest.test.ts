import { bboxCenter, catalogItemDistanceMeters, sortCatalogItems } from './nearest';
import type { CatalogBbox, CatalogItem } from './schema';

const mk = (id: string, title: string, bbox?: CatalogBbox): CatalogItem => ({
  id,
  sourceId: 'src',
  title,
  category: 'topo',
  format: 'geopdf',
  packaging: 'zip',
  url: `https://example.com/${id}.zip`,
  ...(bbox !== undefined ? { bbox } : {}),
});

// Québec City is ~46.81N -71.21W. Sheets at increasing distance:
const quebecSheet = mk('q', 'Québec', [-71.5, 46.75, -71, 47]); // ~0–20 km
const saintRaymond = mk('sr', 'Saint-Raymond', [-72, 46.75, -71.5, 47]); // ~40 km
const gaspe = mk('g', 'Gaspé', [-64.5, 48.75, -64, 49]); // ~550 km
const vancouver = mk('v', 'Vancouver', [-123.5, 49, -123, 49.25]); // ~3700 km
const noBbox = mk('n', 'Atlas générique');

const origin = { latitude: 46.81, longitude: -71.21 };

describe('bboxCenter', () => {
  it('returns the midpoint of the bbox', () => {
    expect(bboxCenter([-72, 46, -70, 48])).toEqual({ latitude: 47, longitude: -71 });
  });
});

describe('catalogItemDistanceMeters', () => {
  it('measures to the bbox center', () => {
    const d = catalogItemDistanceMeters(quebecSheet, origin);
    expect(d).not.toBeNull();
    expect(d!).toBeGreaterThan(0);
    expect(d!).toBeLessThan(20_000);
  });

  it('grows with real-world distance', () => {
    const near = catalogItemDistanceMeters(saintRaymond, origin)!;
    const mid = catalogItemDistanceMeters(gaspe, origin)!;
    const far = catalogItemDistanceMeters(vancouver, origin)!;
    expect(near).toBeLessThan(mid);
    expect(mid).toBeLessThan(far);
    // Sanity anchors: Gaspé ~550 km, Vancouver ~3700 km from Québec City.
    expect(mid).toBeGreaterThan(400_000);
    expect(mid).toBeLessThan(700_000);
    expect(far).toBeGreaterThan(3_000_000);
  });

  it('is null without a bbox', () => {
    expect(catalogItemDistanceMeters(noBbox, origin)).toBeNull();
  });
});

describe('sortCatalogItems', () => {
  const shuffled = [vancouver, noBbox, gaspe, quebecSheet, saintRaymond];

  it('sorts nearest-first with an origin, un-placeable items last', () => {
    expect(sortCatalogItems(shuffled, origin).map((i) => i.id)).toEqual(['q', 'sr', 'g', 'v', 'n']);
  });

  it('falls back to folded alphabetical without an origin', () => {
    expect(sortCatalogItems(shuffled, null).map((i) => i.id)).toEqual(['n', 'g', 'q', 'sr', 'v']);
  });

  it('sorts alphabetically ignoring diacritics', () => {
    const a = mk('a', 'Éboulements', [-70.5, 47.25, -70, 47.5]);
    const b = mk('b', 'Escoumins', [-69.5, 48, -69, 48.25]);
    expect(sortCatalogItems([b, a], null).map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('does not mutate the input array', () => {
    const input = [...shuffled];
    sortCatalogItems(input, origin);
    expect(input.map((i) => i.id)).toEqual(shuffled.map((i) => i.id));
  });
});
