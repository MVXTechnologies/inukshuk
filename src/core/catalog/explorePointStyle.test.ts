import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';

import {
  EXPLORE_CLUSTER_COUNT_LAYOUT,
  EXPLORE_CLUSTER_FILTER,
  EXPLORE_POINT_FILTER,
  exploreClusterPaint,
  explorePointPaint,
} from './explorePointStyle';

const colors = {
  cluster: '#55682F',
  clusterRing: '#FBF8F2',
  clusterInk: '#FBF8F2',
  map: '#55682F',
  place: '#C2410C',
};

const styleWith = (layers: unknown[]) =>
  ({
    version: 8,
    glyphs: 'https://example.test/{fontstack}/{range}.pbf',
    sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
    layers,
  }) as never;

// MapLibre iOS throws (and the app dies) on expressions Android tolerates; the
// reference validator reports the same thing, so this guards the layers.
it('the cluster, count and point layers are valid style layers', () => {
  const errors = validateStyleMin(
    styleWith([
      {
        id: 'clusters',
        type: 'circle',
        source: 's',
        filter: EXPLORE_CLUSTER_FILTER,
        paint: exploreClusterPaint(colors),
      },
      {
        id: 'count',
        type: 'symbol',
        source: 's',
        filter: EXPLORE_CLUSTER_FILTER,
        layout: { ...EXPLORE_CLUSTER_COUNT_LAYOUT, 'text-font': ['Noto Sans Bold'] },
        paint: { 'text-color': colors.clusterInk },
      },
      {
        id: 'points',
        type: 'circle',
        source: 's',
        filter: EXPLORE_POINT_FILTER,
        paint: explorePointPaint(colors),
      },
    ]),
  );
  expect(errors).toEqual([]);
});

it('no paint value uses a zoom curve (iOS crashes on one nested in match/case)', () => {
  const json = JSON.stringify([exploreClusterPaint(colors), explorePointPaint(colors)]);
  expect(json).not.toContain('"zoom"');
});

it('styles a place apart from a map sheet by shape as well as colour', () => {
  const paint = explorePointPaint(colors);
  // A sheet is a solid disc; a place is a light disc in a thick coloured ring.
  expect(paint['circle-color']).toEqual([
    'match',
    ['get', 'kind'],
    'place',
    colors.clusterRing,
    colors.map,
  ]);
  expect(paint['circle-stroke-color']).toEqual([
    'match',
    ['get', 'kind'],
    'place',
    colors.place,
    colors.clusterRing,
  ]);
  // Same outer radius either way: 6 + 4 = 8 + 2.
  expect(paint['circle-radius']).toEqual(['match', ['get', 'kind'], 'place', 6, 8]);
  expect(paint['circle-stroke-width']).toEqual(['match', ['get', 'kind'], 'place', 4, 2]);
});

it('the validator does reject a zoom curve nested in match (what this guards against)', () => {
  const nested = [
    'match',
    ['get', 'kind'],
    'place',
    ['interpolate', ['linear'], ['zoom'], 4, 4, 10, 8],
    8,
  ];
  const errors = validateStyleMin(
    styleWith([{ id: 'p', type: 'circle', source: 's', paint: { 'circle-radius': nested } }]),
  );
  expect(errors.length).toBeGreaterThan(0);
});
