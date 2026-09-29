import { placeTypes, pluralPlaceType, sortLinkOutPlaces } from './linkOutPlaces';
import type { LinkOutPlace } from './taxonomy';

const place = (id: string, name: string, type: string, lat: number, lon: number): LinkOutPlace => ({
  id,
  name,
  type,
  latitude: lat,
  longitude: lon,
  url: `https://www.sepaq.com/${id}`,
});

const places = [
  place('gaspesie', 'Parc national de la Gaspésie', 'National park', 48.95, -66.0),
  place('jc', 'Parc national de la Jacques-Cartier', 'National park', 47.32, -71.33),
  place('laurentides', 'Réserve faunique des Laurentides', 'Wildlife reserve', 47.6, -71.5),
  place('bic', 'Parc national du Bic', 'National park', 48.36, -68.8),
];
const QUEBEC = { latitude: 46.8139, longitude: -71.2082 };

it('sorts nearest first from a position', () => {
  const out = sortLinkOutPlaces(places, QUEBEC);
  expect(out.map((e) => e.place.id)).toEqual(['jc', 'laurentides', 'bic', 'gaspesie']);
  expect(out[0]!.distanceMeters).toBeGreaterThan(50_000);
  expect(out[0]!.distanceMeters).toBeLessThan(70_000);
});

it('filters to one type', () => {
  const out = sortLinkOutPlaces(places, QUEBEC, 'Wildlife reserve');
  expect(out.map((e) => e.place.id)).toEqual(['laurentides']);
});

it('falls back to alphabetical (diacritic-folded) without a position', () => {
  const out = sortLinkOutPlaces(places, null);
  expect(out.map((e) => e.place.id)).toEqual(['gaspesie', 'jc', 'bic', 'laurentides']);
  expect(out.every((e) => e.distanceMeters === null)).toBe(true);
});

it('lists place types in order and pluralizes them', () => {
  expect(placeTypes(places)).toEqual(['National park', 'Wildlife reserve']);
  expect(pluralPlaceType('National park')).toBe('National parks');
  expect(pluralPlaceType('Wildlife reserve')).toBe('Wildlife reserves');
  expect(pluralPlaceType('Territory')).toBe('Territories');
});
