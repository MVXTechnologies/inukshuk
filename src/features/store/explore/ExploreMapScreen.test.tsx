/**
 * Explore on a map (#447), with MapLibre replaced by a prop-capturing stub:
 * the sheet counts the maps in view, the first view's shards load without a
 * tap, "Search this area" appears once the view reaches unloaded shards and
 * pulls them, a cluster tap zooms in, and a point tap selects a map (card,
 * footprint, Details). The geometry itself is `@core/catalog/exploreMap`'s,
 * tested there.
 */
import type { CatalogShardRef } from '@core/catalog/schema';
import { loadCatalogShard } from '@data/catalogCache';
import { useSettingsStore } from '@state/settingsStore';
import { act, fireEvent } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { ExploreMapScreen } from './ExploreMapScreen';
import {
  fixtureIndex,
  lacBeauport,
  mountWithProviders,
  QUEBEC,
  seedCatalog,
  settle,
} from './exploreTestUtils';

interface Captured {
  map?: Record<string, (...args: never[]) => unknown>;
  source?: { data: { features: unknown[] }; onPress: (e: unknown) => void };
  footprint?: boolean;
}
const mockCaptured: Captured = {};
const mockEaseTo = jest.fn();
const mockFitBounds = jest.fn();
type MockProps = { children?: import('react').ReactNode; id?: string } & Record<string, unknown>;
const mockView = { bounds: [-72, 46, -70, 48], zoom: 7, center: [-71, 47] };

jest.mock('@maplibre/maplibre-react-native', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    Map: React.forwardRef(function MockMap(props: MockProps, ref) {
      mockCaptured.map = props as never;
      React.useImperativeHandle(ref, () => ({ getViewState: async () => mockView }));
      return <View>{props.children}</View>;
    }),
    Camera: React.forwardRef(function MockCamera(_props: MockProps, ref) {
      React.useImperativeHandle(ref, () => ({ easeTo: mockEaseTo, fitBounds: mockFitBounds }));
      return null;
    }),
    GeoJSONSource: React.forwardRef(function MockSource(props: MockProps, ref) {
      React.useImperativeHandle(ref, () => ({ getClusterExpansionZoom: async () => 10 }));
      if (props.id === 'explore-catalog') mockCaptured.source = props as never;
      if (props.id === 'explore-footprint') mockCaptured.footprint = true;
      return <View>{props.children}</View>;
    }),
    Layer: () => null,
  };
});
jest.mock('@features/map/mapStyle', () => ({ buildOsmStyle: () => ({ version: 8 }) }));
jest.mock('@data/basemapTiles', () => ({
  vectorBasemapOption: () => ({ tiles: [], dark: false, glyphs: 'https://glyphs.test' }),
}));
const mockPush = jest.fn();
const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ navigate: jest.fn(), push: mockPush, back: jest.fn(), replace: mockReplace }),
}));
jest.mock('@data/catalogCache', () => ({
  loadCatalogManifest: jest.fn(),
  loadCatalogShard: jest.fn(),
  loadCatalogSearchDigest: jest.fn(),
}));

const shardMock = loadCatalogShard as jest.Mock;
const shard = (id: string, bbox: [number, number, number, number]): CatalogShardRef => ({
  id,
  category: 'topo',
  path: `shards/${id}.json`,
  itemCount: 1,
  bbox,
  byteSize: 100,
});
const HERE = shard('topo-here', [-71.5, 46.5, -71, 47]);
const EAST = shard('topo-east', [-66, 48, -65, 49]);

beforeEach(() => {
  delete mockCaptured.source;
  delete mockCaptured.footprint;
  seedCatalog(fixtureIndex({ shards: [HERE, EAST] }));
  shardMock.mockResolvedValue({ items: [], fromCache: false, warnings: [] });
  useSettingsStore.setState({ lastKnownPosition: QUEBEC, units: 'metric' });
});

async function mapScreen() {
  const view = await mountWithProviders(<ExploreMapScreen initialFilter={{}} />);
  await act(async () => {
    mockCaptured.map?.onDidFinishLoadingMap?.();
  });
  await settle();
  return view;
}

it('counts the maps in view and loads the first view without a tap', async () => {
  const view = await mapScreen();
  // Saguenay (48.2°N) is north of the view; the other two are in it.
  expect(view.getByText('2 MAPS IN THIS AREA')).toBeTruthy();
  expect(mockCaptured.source?.data.features).toHaveLength(3);
  expect(shardMock.mock.calls.map(([s]) => (s as CatalogShardRef).id)).toEqual(['topo-here']);
  // Everything reaching into this view is in: no button.
  expect(view.queryByText('Search this area')).toBeNull();
});

it('offers "Search this area" after a move to unloaded shards, and loads them', async () => {
  const view = await mapScreen();
  await act(async () => {
    mockCaptured.map?.onRegionDidChange?.({
      nativeEvent: { bounds: [-67, 47, -64, 50], zoom: 7, center: [-65.5, 48.5] },
    } as never);
  });
  await fireEvent.press(view.getByText('Search this area'));
  await settle();
  expect(shardMock.mock.calls.map(([s]) => (s as CatalogShardRef).id)).toContain('topo-east');
  expect(view.queryByText('Search this area')).toBeNull();
});

it('zooms into a tapped cluster', async () => {
  await mapScreen();
  const stopPropagation = jest.fn();
  await act(async () => {
    mockCaptured.source?.onPress({
      stopPropagation,
      nativeEvent: {
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [-71.2, 46.9] },
            properties: { cluster: true, cluster_id: 5, point_count: 2 },
          },
        ],
      },
    });
  });
  await settle();
  expect(stopPropagation).toHaveBeenCalled();
  expect(mockEaseTo).toHaveBeenCalledWith(
    expect.objectContaining({ center: [-71.2, 46.9], zoom: 10 }),
  );
});

it('a tapped point shows its card and footprint, and Details opens it', async () => {
  const view = await mapScreen();
  await act(async () => {
    mockCaptured.source?.onPress({
      stopPropagation: jest.fn(),
      nativeEvent: {
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [-71.3, 46.95] },
            properties: { id: lacBeauport.id },
          },
        ],
      },
    });
  });
  expect(view.getByText('Topographic · NRCan CanTopo · 5 MB · Free')).toBeTruthy();
  expect(mockCaptured.footprint).toBe(true);
  await fireEvent.press(view.getByText('Details'));
  expect(mockPush).toHaveBeenCalledWith('/explore/item/cantopo-021l14');
});

it('filter chips narrow the points; the list toggle keeps the filter', async () => {
  const view = await mapScreen();
  await fireEvent.press(view.getByLabelText('Filter by type'));
  await fireEvent.press(view.getByLabelText('Nautical, 1 maps'));
  expect(mockCaptured.source?.data.features).toHaveLength(1);
  await fireEvent.press(view.getByLabelText('Show as a list'));
  expect(mockReplace).toHaveBeenCalledWith('/explore/list?kind=nautical');
});

it('keeps the list sheet one height whether it lists maps or none (#459 flicker)', async () => {
  const view = await mapScreen();
  const sheetHeight = () =>
    (StyleSheet.flatten(view.getByTestId('explore-map-sheet').props.style) as { height?: number })
      .height;
  expect(view.getByText('2 MAPS IN THIS AREA')).toBeTruthy();
  const withMaps = sheetHeight();
  expect(withMaps).toBeGreaterThan(0);

  // Empty ground: the sheet must not collapse (that uncovered the map, brought
  // clusters into view, regrew the sheet, and looped).
  await act(async () => {
    mockCaptured.map?.onRegionDidChange?.({
      nativeEvent: { bounds: [-60, 30, -58, 32], zoom: 7, center: [-59, 31] },
    } as never);
  });
  expect(view.getByText('0 MAPS IN THIS AREA')).toBeTruthy();
  expect(view.getByText('Move the map to find maps in another area.')).toBeTruthy();
  expect(sheetHeight()).toBe(withMaps);

  // A layout pass never changes the count: nothing measures the sheet any more.
  await settle();
  expect(view.getByText('0 MAPS IN THIS AREA')).toBeTruthy();
});
