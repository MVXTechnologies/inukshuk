import type { TrackPhoto } from '@core/photos/model';
import { act, render } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { TrailPhotoLayers } from './TrailPhotoLayers';

type Props = Record<string, unknown> & { children?: ReactNode };
const mockLayers: Props[] = [];
const mockSources: Props[] = [];
const mockImages: { current: Props | null } = { current: null };
const mockSource = {
  getClusterExpansionZoom: jest.fn(),
  getClusterLeaves: jest.fn(),
};

jest.mock('@maplibre/maplibre-react-native', () => {
  const { forwardRef, useImperativeHandle } = jest.requireActual<typeof import('react')>('react');
  return {
    GeoJSONSource: forwardRef((props: Props, ref) => {
      useImperativeHandle(ref, () => mockSource);
      mockSources.push(props);
      return props.children ?? null;
    }),
    Layer: (props: Props) => {
      mockLayers.push(props);
      return null;
    },
    Images: (props: Props) => {
      mockImages.current = props;
      return null;
    },
  };
});
jest.mock('./photoUri', () => ({ photoFileUri: (p: string) => `file:///doc/${p}` }));

const photo = (id: string, takenAt: number, extra: Partial<TrackPhoto> = {}): TrackPhoto => ({
  id,
  trackId: 't1',
  distanceM: takenAt,
  lngLat: [-70.9 + takenAt / 1000, 47.07],
  placement: 'time',
  takenAt,
  file: `photos/t1/${id}.jpg`,
  thumb: `photos/t1/${id}.sq.jpg`,
  sprite: `photos/t1/${id}.map.png`,
  width: 1,
  height: 1,
  bytes: 1,
  createdAt: 0,
  updatedAt: 0,
  ...extra,
});

const PHOTOS = [
  photo('b', 20),
  photo('a', 10),
  photo('note:n', 5),
  photo('h', 1, { hidden: true }),
];

beforeEach(() => {
  mockLayers.length = 0;
  mockSources.length = 0;
  mockImages.current = null;
  mockSource.getClusterExpansionZoom.mockReset();
  mockSource.getClusterLeaves.mockReset();
});

const lastSource = (id: string) => [...mockSources].reverse().find((s) => s.id === id)!;
const press = (id: string, feature: object, point: [number, number] = [10, 10]) => {
  const stopPropagation = jest.fn();
  (lastSource(id).onPress as (e: unknown) => void)({
    stopPropagation,
    nativeEvent: { features: [feature], point },
  });
  return stopPropagation;
};
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

it('draws own visible photos, clustered, with prefixed ids', async () => {
  await render(<TrailPhotoLayers id="trail-2d" photos={PHOTOS} minZoom={12} />);
  const source = lastSource('trail-2d-photos');
  expect(source).toMatchObject({ cluster: true, clusterRadius: 34, clusterMaxZoom: 18 });
  const features = (source.data as GeoJSON.FeatureCollection).features;
  expect(features.map((f) => f.properties?.['id'])).toEqual(['a', 'b']);
  expect(new Set(mockLayers.map((l) => l.id))).toEqual(
    new Set([
      'trail-2d-photos-img',
      'trail-2d-photos-count',
      'trail-2d-photos-sel-ring',
      'trail-2d-photos-sel-img',
    ]),
  );
  expect(mockLayers.every((l) => l.minzoom === 12)).toBe(true);
});

it('registers sprites at 3 px per point plus the bundled badges, and loads missing ones', async () => {
  await render(<TrailPhotoLayers id="m" photos={PHOTOS} />);
  const images = mockImages.current!.images as Record<string, unknown>;
  const sprite = Object.entries(images).find(([k]) => k.endsWith('-0'));
  expect(sprite?.[1]).toEqual({ source: { uri: 'file:///doc/photos/t1/a.map.png', scale: 3 } });
  expect(images).toHaveProperty('ph-count-2');
  expect(images).toHaveProperty('ph-selected-ring');
  expect(images).not.toHaveProperty('ph-count-40');
  await act(async () =>
    (mockImages.current!.onImageMissing as (e: unknown) => void)({
      nativeEvent: { image: 'ph-count-40' },
    }),
  );
  expect(mockImages.current!.images).toHaveProperty('ph-count-40');
});

it('draws nothing without photos to draw', async () => {
  await render(<TrailPhotoLayers id="x" photos={[photo('note:n', 1)]} />);
  expect(mockSources).toEqual([]);
});

it('rings the selected photo in its own source', async () => {
  await render(<TrailPhotoLayers id="t" photos={PHOTOS} selectedId="b" />);
  const sel = lastSource('t-photos-sel').data as GeoJSON.FeatureCollection;
  expect(sel.features.map((f) => f.properties)).toEqual([{ id: 'b', order: 1 }]);
});

it('opens a single photo', async () => {
  const onPhotoPress = jest.fn();
  await render(<TrailPhotoLayers id="t" photos={PHOTOS} onPhotoPress={onPhotoPress} />);
  const stop = press('t-photos', { properties: { id: 'a', order: 0 } });
  await flush();
  expect(stop).toHaveBeenCalled();
  expect(onPhotoPress).toHaveBeenCalledWith(['a']);
});

it('lets a waypoint pin take the tap first', async () => {
  const onPhotoPress = jest.fn();
  const pressGuard = jest.fn(async () => true);
  await render(
    <TrailPhotoLayers id="t" photos={PHOTOS} onPhotoPress={onPhotoPress} pressGuard={pressGuard} />,
  );
  press('t-photos', { properties: { id: 'a', order: 0 } }, [3, 4]);
  await flush();
  expect(pressGuard).toHaveBeenCalledWith([3, 4]);
  expect(onPhotoPress).not.toHaveBeenCalled();
});

const stack = {
  properties: { cluster: true, cluster_id: 9, point_count: 2, order: 0 },
  geometry: { type: 'Point', coordinates: [-70.9, 47.07] },
};

it('zooms into a stack that splits', async () => {
  const zoomTo = jest.fn();
  mockSource.getClusterExpansionZoom.mockResolvedValue(15);
  await render(
    <TrailPhotoLayers id="t" photos={PHOTOS} getZoom={async () => 13} zoomTo={zoomTo} />,
  );
  press('t-photos', stack);
  await flush();
  expect(zoomTo).toHaveBeenCalledWith([-70.9, 47.07], 15);
});

it('opens a stack that only splits past z18, its photos in time order', async () => {
  const onPhotoPress = jest.fn();
  mockSource.getClusterExpansionZoom.mockResolvedValue(20);
  mockSource.getClusterLeaves.mockResolvedValue([
    { properties: { id: 'b', order: 1 } },
    { properties: { id: 'a', order: 0 } },
  ]);
  await render(
    <TrailPhotoLayers
      id="t"
      photos={PHOTOS}
      onPhotoPress={onPhotoPress}
      getZoom={async () => 18}
      zoomTo={jest.fn()}
    />,
  );
  press('t-photos', stack);
  await flush();
  expect(onPhotoPress).toHaveBeenCalledWith(['a', 'b']);
});

it('can leave the tap to the map and hand over its action', async () => {
  const onPhotoPress = jest.fn();
  let run: (() => void) | null = null;
  await render(
    <TrailPhotoLayers
      id="t"
      photos={PHOTOS}
      onPhotoPress={onPhotoPress}
      deferPress={(r) => {
        run = r;
      }}
    />,
  );
  const stop = press('t-photos', { properties: { id: 'b', order: 1 } });
  expect(stop).not.toHaveBeenCalled();
  expect(onPhotoPress).not.toHaveBeenCalled();
  run!();
  await flush();
  expect(onPhotoPress).toHaveBeenCalledWith(['b']);
});

it('ignores a press on nothing it knows', async () => {
  const onPhotoPress = jest.fn();
  await render(<TrailPhotoLayers id="t" photos={PHOTOS} onPhotoPress={onPhotoPress} />);
  press('t-photos', { properties: {} });
  await flush();
  expect(onPhotoPress).not.toHaveBeenCalled();
});
