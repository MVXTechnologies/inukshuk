import type { FacetsOf } from './exploreFacets';
import { popularNearYou } from './popularNear';
import type { CatalogItem } from './schema';
import type { CatalogKind } from './taxonomy';

const QUEBEC = { latitude: 46.8139, longitude: -71.2082 };

const item = (
  id: string,
  lat: number,
  lon: number,
  over: Partial<CatalogItem> = {},
): CatalogItem => ({
  id,
  sourceId: 'nrcan-cantopo',
  title: id,
  category: 'topo',
  bbox: [lon - 0.05, lat - 0.05, lon + 0.05, lat + 0.05],
  format: 'geopdf',
  packaging: 'none',
  url: `https://example.test/${id}.pdf`,
  ...over,
});

const kinds: Record<string, CatalogKind> = {};
const facetsOf: FacetsOf = (i) => ({ kind: kinds[i.id] ?? 'topo', activities: [], terrain: [] });

it('is empty without a position', () => {
  expect(popularNearYou([item('a', 46.9, -71.3)], null, facetsOf)).toEqual([]);
});

it('keeps Canadian sheets ahead of nearer US quads (the Québec rule)', () => {
  const maine = item('us', 45.9, -70.3, { sourceId: 'usgs-ustopo', region: 'US-ME' });
  const nb = item('ca', 45.9, -67.4); // further than Maine from Québec
  const out = popularNearYou([maine, nb], QUEBEC, facetsOf);
  expect(out.map((e) => e.item.id)).toEqual(['ca', 'us']);
});

it('weights by kind: a park a bit further leads a nearer topo sheet', () => {
  kinds['park'] = 'park';
  const topo = item('topo', 47.0, -71.2); // ~20 km
  const park = item('park', 47.1, -71.2, { category: 'parks' }); // ~32 km, weighted ~19
  const out = popularNearYou([topo, park], QUEBEC, facetsOf);
  expect(out.map((e) => e.item.id)).toEqual(['park', 'topo']);
  // Distances stay the real ones — the weight only orders.
  expect(out[0]!.distanceMeters).toBeGreaterThan(out[1]!.distanceMeters);
});

it('caps at the limit', () => {
  const many = Array.from({ length: 12 }, (_, i) => item(`s${i}`, 46.8 + i * 0.05, -71.2));
  expect(popularNearYou(many, QUEBEC, facetsOf, { limit: 5 })).toHaveLength(5);
  expect(popularNearYou(many, QUEBEC, facetsOf)).toHaveLength(8);
});
