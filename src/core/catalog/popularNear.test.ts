import type { FacetsOf } from './exploreFacets';
import {
  popularNearStatus,
  popularNearYou,
  popularNearYouCards,
  POPULAR_PLACE_RADIUS_METERS,
  type PopularCard,
} from './popularNear';
import type { CatalogItem } from './schema';
import type { CatalogKind, LinkOutCollection, LinkOutPlace } from './taxonomy';

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

const place = (id: string, lat: number, lon: number): LinkOutPlace => ({
  id,
  name: id,
  type: 'National park',
  latitude: lat,
  longitude: lon,
  url: `https://example.test/${id}/`,
});
const sepaq = (places: LinkOutPlace[]): LinkOutCollection => ({
  id: 'sepaq',
  name: 'Parcs Québec',
  publisher: 'Sépaq',
  blurb: 'Maps on sepaq.com',
  homepage: 'https://example.test/',
  places,
});
const ids = (cards: PopularCard[]) =>
  cards.map((c) => (c.type === 'item' ? c.item.id : `place:${c.place.id}`));

describe('popularNearYouCards (the Québec City regression)', () => {
  // The published catalog from Québec City: CanTopo starts in New Brunswick.
  const nb = Array.from({ length: 8 }, (_, i) => item(`nb${i}`, 45.9 + i * 0.1, -67.4));
  const maine = item('me', 45.9, -70.3, { sourceId: 'usgs-ustopo', region: 'US-ME' });
  const jacquesCartier = place('jac', 47.32, -71.4); // ~58 km
  const grandsJardins = place('gja', 47.68, -70.85); // ~100 km
  const farPark = place('far', 49.5, -62.7); // Anticosti, ~700 km

  it('puts nearby parks ahead of 300 km sheets', () => {
    const out = popularNearYouCards(
      [...nb, maine],
      [sepaq([farPark, grandsJardins, jacquesCartier])],
      QUEBEC,
      facetsOf,
    );
    expect(ids(out).slice(0, 2)).toEqual(['place:jac', 'place:gja']);
    expect(ids(out)).not.toContain('place:far');
    expect(out).toHaveLength(8);
    expect(out[0]!.distanceMeters).toBeLessThan(POPULAR_PLACE_RADIUS_METERS);
  });

  it('keeps most of the row for downloadable maps', () => {
    const many = Array.from({ length: 10 }, (_, i) => place(`p${i}`, 46.9 + i * 0.02, -71.2));
    const out = popularNearYouCards(nb, [sepaq(many)], QUEBEC, facetsOf);
    expect(out.filter((c) => c.type === 'place')).toHaveLength(4);
    expect(out.filter((c) => c.type === 'item')).toHaveLength(4);
  });

  it('places still show when no catalog map is in range', () => {
    const out = popularNearYouCards([], [sepaq([jacquesCartier])], QUEBEC, facetsOf);
    expect(ids(out)).toEqual(['place:jac']);
  });

  it('dedupes a place listed by two collections', () => {
    const out = popularNearYouCards(
      [],
      [sepaq([jacquesCartier]), { ...sepaq([jacquesCartier]), id: 'other' }],
      QUEBEC,
      facetsOf,
    );
    expect(out).toHaveLength(1);
  });

  it('merges places only into the leading national group', () => {
    const out = popularNearYouCards(
      [nb[0]!, maine],
      [sepaq([place('mid', 46.0, -68.5)])], // ~225 km, weighted ~135 km
      QUEBEC,
      facetsOf,
    );
    expect(ids(out)).toEqual(['place:mid', 'nb0', 'me']);
  });

  it('is empty without a position or with a zero limit', () => {
    expect(popularNearYouCards(nb, [sepaq([jacquesCartier])], null, facetsOf)).toEqual([]);
    expect(
      popularNearYouCards(nb, [sepaq([jacquesCartier])], QUEBEC, facetsOf, { limit: 0 }),
    ).toEqual([]);
  });

  it('without places it is exactly popularNearYou', () => {
    const out = popularNearYouCards([...nb, maine], [], QUEBEC, facetsOf);
    expect(ids(out)).toEqual(
      popularNearYou([...nb, maine], QUEBEC, facetsOf).map((e) => e.item.id),
    );
  });
});

describe('popularNearStatus', () => {
  it('shows cards whenever there are any', () => {
    expect(popularNearStatus({ position: QUEBEC, cardCount: 3, loading: true })).toBe('cards');
  });

  it('says why it is empty instead of vanishing', () => {
    expect(popularNearStatus({ position: null, cardCount: 0, loading: false })).toBe('no-position');
    expect(popularNearStatus({ position: QUEBEC, cardCount: 0, loading: true })).toBe('loading');
    expect(popularNearStatus({ position: QUEBEC, cardCount: 0, loading: false })).toBe(
      'none-in-range',
    );
  });
});
