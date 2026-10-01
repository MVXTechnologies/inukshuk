import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';

import { SHOWN_MARK_RADIUS } from './ShownTrailLayers';

jest.mock('@maplibre/maplibre-react-native', () => ({
  GeoJSONSource: () => null,
  Layer: () => null,
}));
jest.mock('@ui/useSchemeTokens', () => ({ useSchemeTokens: () => ({}) }));

// MapLibre iOS throws (and the app dies) on a zoom curve nested inside another
// expression; the reference validator reports the same thing, so this guards it.
it('the stage-mark radius is a valid style value (zoom curve at the top level)', () => {
  const errors = validateStyleMin({
    version: 8,
    sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
    layers: [
      { id: 'dots', type: 'circle', source: 's', paint: { 'circle-radius': SHOWN_MARK_RADIUS } },
    ],
  } as never);
  expect(errors).toEqual([]);
});

it('the old nested form is what the validator rejects', () => {
  const nested = [
    'match',
    ['get', 'kind'],
    'join',
    ['interpolate', ['linear'], ['zoom'], 4, 2.5, 10, 4.5],
    7,
  ];
  const errors = validateStyleMin({
    version: 8,
    sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
    layers: [{ id: 'dots', type: 'circle', source: 's', paint: { 'circle-radius': nested } }],
  } as never);
  expect(errors.length).toBeGreaterThan(0);
});
