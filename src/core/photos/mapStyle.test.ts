import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';

import {
  CLUSTER_FILTER,
  countImageName,
  countLayout,
  initialSprites,
  leafIds,
  mainMapPhotoChipLabel,
  mapPhotos,
  MAX_SPRITES,
  orderOfSprite,
  PHOTO_CLUSTER_MAX_ZOOM,
  PHOTO_CLUSTER_RADIUS,
  photoSetKey,
  readPhotoPress,
  selectedRingLayout,
  selectedSpriteLayout,
  spriteLayout,
  spriteName,
  spritePrefix,
  stackTapAction,
  touchSprites,
  PHOTO_SIZE_STOPS,
  photoScaleAt,
  spritePixelRatio,
} from './mapStyle';
import type { TrackPhoto } from './model';
import { PHOTO_CLUSTER_PROPERTIES } from './stack';

const photo = (id: string, takenAt?: number, extra: Partial<TrackPhoto> = {}) =>
  ({ id, distanceM: 0, ...(takenAt === undefined ? {} : { takenAt }), ...extra }) as TrackPhoto;

const style = (layers: unknown[]) =>
  ({
    version: 8,
    sources: {
      s: {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
        cluster: true,
        clusterRadius: PHOTO_CLUSTER_RADIUS,
        clusterMaxZoom: PHOTO_CLUSTER_MAX_ZOOM,
        clusterProperties: PHOTO_CLUSTER_PROPERTIES,
      },
      sel: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    },
    layers,
  }) as never;

// MapLibre iOS dies on expressions Android accepts (a nested ["zoom"]); the
// reference validator flags the same thing, so every layer is checked here.
it('emits valid layers and a valid clustered source', () => {
  const prefix = spritePrefix('trail-2d', 'abc');
  const errors = validateStyleMin(
    style([
      { id: 'img', type: 'symbol', source: 's', layout: spriteLayout(prefix), minzoom: 12 },
      { id: 'count', type: 'symbol', source: 's', filter: CLUSTER_FILTER, layout: countLayout() },
      { id: 'ring', type: 'symbol', source: 'sel', layout: selectedRingLayout() },
      { id: 'sel', type: 'symbol', source: 'sel', layout: selectedSpriteLayout(prefix) },
    ]),
  );
  expect(errors).toEqual([]);
});

it('grows the photos with zoom: clearly larger close in, one top-level interpolate', () => {
  const sizes = PHOTO_SIZE_STOPS.map(([, k]) => k);
  for (let i = 1; i < sizes.length; i++) expect(sizes[i]!).toBeGreaterThan(sizes[i - 1]!);
  expect(sizes.at(-1)! / sizes[0]!).toBeGreaterThanOrEqual(1.8);
  for (const layout of [spriteLayout('p-'), selectedSpriteLayout('p-'), selectedRingLayout()]) {
    const size = layout['icon-size'] as unknown[];
    expect(size.slice(0, 3)).toEqual(['interpolate', ['linear'], ['zoom']]);
  }
});

it('registers 2× sprites at 6 px per point, the older 132 px ones at 3', () => {
  expect(spritePixelRatio('photos/t1/p.map2.png')).toBe(6);
  expect(spritePixelRatio('team-photos/x/o-p-s2.png')).toBe(6);
  expect(spritePixelRatio('photos/t1/p.map.png')).toBe(3);
  expect(spritePixelRatio('team-photos/x/o-p-s.png')).toBe(3);
});

it('gives the same scale in JS for what cannot take a zoom expression', () => {
  const [first, mid, , last] = PHOTO_SIZE_STOPS;
  expect(photoScaleAt(first![0] - 3)).toBe(first![1]);
  expect(photoScaleAt(mid![0])).toBe(mid![1]);
  expect(photoScaleAt(last![0] + 2)).toBe(last![1]);
  expect(photoScaleAt((first![0] + mid![0]) / 2)).toBeCloseTo((first![1] + mid![1]) / 2, 6);
});

it('never uses a symbol sort key', () => {
  for (const layout of [spriteLayout('p-'), countLayout(), selectedSpriteLayout('p-')]) {
    expect(layout).not.toHaveProperty('symbol-sort-key');
  }
});

describe('mapPhotos', () => {
  it('draws visible own photos in time order, never note photos', () => {
    const drawn = mapPhotos([
      photo('b', 20),
      photo('note:n1'),
      photo('a', 10),
      photo('h', 5, { hidden: true }),
      photo('d', 1, { deletedAt: 3 }),
    ]);
    expect(drawn.map((p) => p.id)).toEqual(['a', 'b']);
  });
});

describe('sprite names', () => {
  it('change with the drawn set, and only with it', () => {
    const k1 = photoSetKey([photo('a'), photo('b')]);
    expect(photoSetKey([photo('a'), photo('b')])).toBe(k1);
    expect(photoSetKey([photo('b'), photo('a')])).not.toBe(k1);
    expect(photoSetKey([photo('ab')])).not.toBe(photoSetKey([photo('a'), photo('b')]));
    expect(photoSetKey([])).toMatch(/^[0-9a-z]+$/);
  });

  it('round-trip a rank and ignore other names', () => {
    const prefix = spritePrefix('main-t1', 'k9');
    expect(spriteName(prefix, 12)).toBe('ph-main-t1-k9-12');
    expect(orderOfSprite(prefix, 'ph-main-t1-k9-12')).toBe(12);
    expect(orderOfSprite(prefix, 'ph-main-t1-k8-12')).toBeNull();
    expect(orderOfSprite(prefix, 'ph-main-t1-k9-x')).toBeNull();
    expect(orderOfSprite(prefix, 'ph-count-3')).toBeNull();
  });

  it('name the count badge, capped to 2 … 100', () => {
    expect(countImageName(7)).toBe('ph-count-7');
    expect(countImageName(1)).toBe('ph-count-2');
    expect(countImageName(250)).toBe('ph-count-100');
  });
});

describe('sprite LRU', () => {
  it('keeps the most recently asked, capped', () => {
    expect(touchSprites(['a', 'b', 'c'], ['a'], 3)).toEqual(['b', 'c', 'a']);
    expect(touchSprites(['a', 'b', 'c'], ['d', 'd'], 3)).toEqual(['b', 'c', 'd']);
    expect(touchSprites([], ['x'])).toEqual(['x']);
  });

  it('starts with the first ranks', () => {
    expect(initialSprites('p-', 3)).toEqual(['p-0', 'p-1', 'p-2']);
    expect(initialSprites('p-', 1000)).toHaveLength(MAX_SPRITES);
  });
});

describe('main map chip', () => {
  it('names one trail, counts several', () => {
    expect(mainMapPhotoChipLabel([{ name: 'Lac des Cygnes', count: 33 }])).toBe(
      'Lac des Cygnes · 33 photos',
    );
    expect(
      mainMapPhotoChipLabel([
        { name: 'A', count: 1 },
        { name: 'B', count: 0 },
      ]),
    ).toBe('A · 1 photo');
    expect(
      mainMapPhotoChipLabel([
        { name: 'A', count: 30 },
        { name: 'B', count: 15 },
      ]),
    ).toBe('45 photos on 2 trails');
    expect(mainMapPhotoChipLabel([{ name: 'A', count: 0 }])).toBeNull();
    expect(mainMapPhotoChipLabel([])).toBeNull();
  });
});

describe('presses', () => {
  it('reads a single photo and a stack', () => {
    expect(readPhotoPress({ properties: { id: 'a', order: 0 } })).toEqual({
      kind: 'photo',
      id: 'a',
    });
    expect(
      readPhotoPress({
        properties: { cluster: true, cluster_id: 7, point_count: 3, order: 2 },
        geometry: { type: 'Point', coordinates: [-71, 47] },
      }),
    ).toEqual({ kind: 'stack', clusterId: 7, lngLat: [-71, 47] });
  });

  it('ignores anything else', () => {
    expect(readPhotoPress({ properties: null })).toBeNull();
    expect(readPhotoPress({ properties: { order: 1 } })).toBeNull();
    expect(readPhotoPress({ properties: { cluster: true, cluster_id: 'x' } })).toBeNull();
    expect(
      readPhotoPress({ properties: { cluster_id: 3 }, geometry: { type: 'LineString' } }),
    ).toBeNull();
    expect(
      readPhotoPress({
        properties: { cluster_id: 3 },
        geometry: { type: 'Point', coordinates: ['a', 1] },
      }),
    ).toBeNull();
  });

  it('zooms into a stack that splits, opens one that will not', () => {
    expect(stackTapAction(14, 12)).toEqual({ kind: 'zoom', zoom: 14 });
    // At its edge the reported zoom can be the current one: always go deeper.
    expect(stackTapAction(13, 13)).toEqual({ kind: 'zoom', zoom: 14 });
    expect(stackTapAction(18, 17.8)).toEqual({ kind: 'zoom', zoom: 18 });
    expect(stackTapAction(19, 17)).toEqual({ kind: 'open' });
    expect(stackTapAction(null, 12)).toEqual({ kind: 'open' });
    expect(stackTapAction(Number.NaN, 12)).toEqual({ kind: 'open' });
  });

  it('lists a stack’s photos in time order', () => {
    expect(
      leafIds([
        { properties: { id: 'c', order: 4 } },
        { properties: { id: 'a', order: 1 } },
        { properties: { order: 2 } },
        { properties: null },
      ]),
    ).toEqual(['a', 'c']);
  });
});
