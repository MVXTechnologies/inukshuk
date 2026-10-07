/**
 * Explore on a map (#447), with MapLibre replaced by a prop-capturing stub:
 * the sheet counts the maps in view, the first view's shards load without a
 * tap, "Search this area" appears once the view reaches unloaded shards and
 * pulls them, a cluster tap zooms in, and a point tap selects a map (card,
 * footprint, Details). The geometry itself is `@core/catalog/exploreMap`'s,
 * tested there.
 *
 * With the link-out collections loaded, places (Sépaq, zecs) are points too:
 * checking an activity yields the sheets AND places tagged for it, a place's
 * card links out where a sheet's card downloads, and an activity with nothing
 * says so.
 */
import type { CatalogShardRef } from '@core/catalog/schema';
import type { MapDocument } from '@core/models';
import { loadCatalogShard } from '@data/catalogCache';
import { loadCatalogCollectionsRaw } from '@data/catalogCollections';
import { useLibraryStore } from '@state/libraryStore';
import { useCatalogStore } from '@state/catalogStore';
import type { ExploreFilter } from '@core/catalog/exploreFacets';
import { useExploreHandoffStore } from '@state/exploreHandoffStore';
import { useSettingsStore } from '@state/settingsStore';
import { act, fireEvent } from '@testing-library/react-native';
import { Linking, StyleSheet } from 'react-native';

import { ExploreMapScreen } from './ExploreMapScreen';
import {
  collectionsRaw,
  CUPERTINO,
  cupertinoIndex,
  cupertinoSheets,
  fixtureIndex,
  lacBeauport,
  mountWithProviders,
  QUEBEC,
  seedCatalog,
  serveCupertinoShard,
  settle,
} from './exploreTestUtils';
import { resetLinkOutCollectionsCache } from './useLinkOutCollections';

interface Captured {
  map?: Record<string, (...args: never[]) => unknown>;
  source?: {
    data: { features: { properties: { id: string; kind: string } }[] };
    onPress: (e: unknown) => void;
  };
  footprint?: boolean;
  crags?: { onPress: (e: unknown) => void };
}
const mockCaptured: Captured = {};
const mockEaseTo = jest.fn();
const mockFitBounds = jest.fn();
type MockProps = { children?: import('react').ReactNode; id?: string } & Record<string, unknown>;
const mockView = { bounds: [-72, 46, -70, 48], zoom: 7, center: [-71, 47] };
// What the crag layer "renders" (Explore → Climbing reads rendered features).
let mockRenderedCrags: unknown[] = [];
let mockCragTiles: string | null = null;

jest.mock('@maplibre/maplibre-react-native', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    Map: React.forwardRef(function MockMap(props: MockProps, ref) {
      mockCaptured.map = props as never;
      React.useImperativeHandle(ref, () => ({
        getViewState: async () => mockView,
        queryRenderedFeatures: async () => mockRenderedCrags,
      }));
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
    VectorSource: function MockVectorSource(props: MockProps) {
      if (props.id === 'explore-crags') mockCaptured.crags = props as never;
      return <View>{props.children}</View>;
    },
    Images: () => null,
    Layer: () => null,
  };
});
jest.mock('@data/climbing', () => ({ cragTilesUrl: () => mockCragTiles }));
jest.mock('@features/climbing/climbingActions', () => ({
  CragDownloadError: class extends Error {},
  downloadCrag: jest.fn(),
  estimateCragMap: () => 6_400_000,
}));
jest.mock('@features/map/mapStyle', () => ({ buildOsmStyle: () => ({ version: 8 }) }));
jest.mock('@data/basemapTiles', () => ({
  vectorBasemapOption: () => ({ tiles: [], dark: false, glyphs: 'https://glyphs.test' }),
}));
const mockPush = jest.fn();
const mockReplace = jest.fn();
const mockBack = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ navigate: jest.fn(), push: mockPush, back: mockBack, replace: mockReplace }),
}));
jest.mock('@data/catalogCache', () => ({
  loadCatalogManifest: jest.fn(),
  loadCatalogShard: jest.fn(),
  loadCatalogSearchDigest: jest.fn(),
  loadCatalogFacets: jest.fn(),
}));

jest.mock('@data/catalogCollections', () => ({ loadCatalogCollectionsRaw: jest.fn() }));
jest.mock('@features/store/downloadCatalogItem', () => ({
  CatalogDownloadCanceled: class extends Error {},
  cancelCatalogDownload: jest.fn(),
  downloadCatalogItemToLibrary: jest.fn(),
}));
jest.mock('@data/diskSpace', () => ({ assessFreeSpaceForWrite: () => null }));

const shardMock = loadCatalogShard as jest.Mock;
const collectionsMock = loadCatalogCollectionsRaw as jest.Mock;
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
  mockPush.mockReset();
  mockReplace.mockReset();
  mockBack.mockReset();
  mockFitBounds.mockReset();
  // No collections by default: the map is the catalog alone, as before them.
  resetLinkOutCollectionsCache();
  collectionsMock.mockResolvedValue(null);
  useLibraryStore.setState({ maps: [], folders: [] });
  useExploreHandoffStore.getState().clear();
  delete mockCaptured.source;
  delete mockCaptured.footprint;
  seedCatalog(fixtureIndex({ shards: [HERE, EAST] }));
  shardMock.mockResolvedValue({ items: [], fromCache: false, warnings: [] });
  useSettingsStore.setState({ lastKnownPosition: QUEBEC, units: 'metric' });
  mockCragTiles = null;
  mockRenderedCrags = [];
  delete mockCaptured.crags;
});

async function mapScreen(initialFilter: ExploreFilter = {}, fromList = false) {
  const view = await mountWithProviders(
    <ExploreMapScreen initialFilter={initialFilter} fromList={fromList} />,
  );
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

describe('navigation and the Activity filter (#474)', () => {
  it('has a back arrow that returns where the user came from', async () => {
    const view = await mapScreen();
    await fireEvent.press(view.getByLabelText('Back'));
    expect(mockBack).toHaveBeenCalledTimes(1);
    // Opened from the landing: the list toggle swaps in place.
    await fireEvent.press(view.getByLabelText('Show as a list'));
    expect(mockReplace).toHaveBeenCalledWith('/explore/list');
    // Nothing is handed to a list that is not there.
    expect(useExploreHandoffStore.getState().listFilter).toBeNull();
  });

  it('over a list: hands its filter back, and both back and the list toggle pop to it', async () => {
    const view = await mapScreen({ activity: 'hiking' }, true);
    expect(useExploreHandoffStore.getState().listFilter).toEqual({ activity: 'hiking' });

    await fireEvent.press(view.getByLabelText('Hiking, clear activity filter'));
    await fireEvent.press(view.getByLabelText('Filter by terrain'));
    await fireEvent.press(view.getByLabelText('Coast, 1 maps'));
    expect(useExploreHandoffStore.getState().listFilter).toEqual({ terrain: 'coast' });

    await fireEvent.press(view.getByLabelText('Show as a list'));
    await fireEvent.press(view.getByLabelText('Back'));
    expect(mockBack).toHaveBeenCalledTimes(2);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('offers Activity for real US Topo sheets (terrain only), and filters by it', async () => {
    seedCatalog(cupertinoIndex({ shards: [] }), { items: cupertinoSheets });
    useSettingsStore.setState({ lastKnownPosition: CUPERTINO });
    const view = await mapScreen();
    expect(mockCaptured.source?.data.features).toHaveLength(4);
    await fireEvent.press(view.getByLabelText('Filter by activity'));
    await fireEvent.press(view.getByLabelText('Hiking, 2 maps'));
    expect(view.getByLabelText('Hiking, clear activity filter')).toBeTruthy();
    expect(mockCaptured.source?.data.features).toHaveLength(2);
  });

  it('settles: a Hiking map loads its first view once, however often it re-renders', async () => {
    seedCatalog(cupertinoIndex());
    shardMock.mockImplementation(serveCupertinoShard);
    useSettingsStore.setState({ lastKnownPosition: CUPERTINO });
    const view = await mapScreen({ activity: 'hiking' });
    const calls = shardMock.mock.calls.length;
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        mockCaptured.map?.onRegionDidChange?.({
          nativeEvent: { bounds: [-72, 46, -70, 48], zoom: 7, center: [-71, 47] },
        } as never);
        useSettingsStore.setState({
          lastKnownPosition: { latitude: CUPERTINO.latitude + i * 0.001, longitude: -122.03 },
        });
      });
      await settle();
    }
    expect(shardMock.mock.calls.length).toBe(calls);
    expect(useCatalogStore.getState().loadingShards).toBe(false);
    expect(view.queryByText('Loading maps…')).toBeNull();
  });
});

describe('activity points: catalog sheets and link-out places (Sépaq, zecs)', () => {
  beforeEach(() => {
    collectionsMock.mockResolvedValue(collectionsRaw);
  });

  const features = () =>
    (mockCaptured.source?.data.features ?? []).map(
      (f) => `${f.properties.kind} ${f.properties.id}`,
    );
  const tap = async (properties: Record<string, unknown>) => {
    await act(async () => {
      mockCaptured.source?.onPress({
        stopPropagation: jest.fn(),
        nativeEvent: {
          features: [
            {
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [-71.8, 47.1] },
              properties,
            },
          ],
        },
      });
    });
  };

  it('with no filter, places are points beside the sheets, and both are counted', async () => {
    const view = await mapScreen();
    expect(features()).toHaveLength(3 + 5);
    // North of 46.84°N (above the sheet), south of 48°N: both hiking sheets,
    // Jacques-Cartier, the Laurentides reserve and zec Batiscan-Neilson.
    expect(view.getByText('2 MAPS · 3 PLACES IN THIS AREA')).toBeTruthy();
    expect(view.getByLabelText('Zec Batiscan-Neilson')).toBeTruthy();
  });

  it('Hunting: offered with its place count, and yields the reserve and the zecs', async () => {
    const view = await mapScreen();
    await fireEvent.press(view.getByLabelText('Filter by activity'));
    // No catalog sheet is a hunting map: the chip exists because places are.
    await fireEvent.press(view.getByLabelText('Hunting, 3 maps and places'));
    expect(view.getByLabelText('Hunting, clear activity filter')).toBeTruthy();
    expect(features()).toEqual([
      'place place:sepaq/laurentides',
      'place place:zecs/zec-batiscan-neilson',
      'place place:zecs/zec-martin-valin',
    ]);
    expect(view.getByText('2 PLACES IN THIS AREA')).toBeTruthy();
    expect(view.queryByTestId('explore-map-empty')).toBeNull();
  });

  it('Paddling: the paddling sheets AND the places tagged for it', async () => {
    const view = await mapScreen();
    await fireEvent.press(view.getByLabelText('Filter by activity'));
    await fireEvent.press(view.getByLabelText('Paddling, 4 maps and places'));
    expect(features()).toEqual([
      'map parks-jacques-cartier',
      'map chs-saguenay',
      'place place:sepaq/jacques-cartier',
      'place place:zecs/zec-martin-valin',
    ]);
  });

  it('Type "Hunting & fishing" reaches the places through their type', async () => {
    const view = await mapScreen();
    await fireEvent.press(view.getByLabelText('Filter by type'));
    await fireEvent.press(view.getByLabelText('Hunting & fishing, 3 maps and places'));
    expect(features().every((f) => f.startsWith('place '))).toBe(true);
    expect(features()).toHaveLength(3);
  });

  it('a tapped place shows its card with the link-out action, not a download', async () => {
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    const view = await mapScreen({ activity: 'hunting' });
    await tap({ id: 'place:zecs/zec-batiscan-neilson', kind: 'place' });

    expect(view.getByTestId('explore-map-place-card')).toBeTruthy();
    expect(view.getByText('Zec Batiscan-Neilson')).toBeTruthy();
    expect(view.getByText('ZEC · Réseau Zec · hunting, fishing')).toBeTruthy();
    expect(view.getByText(/^\d+ km away$/)).toBeTruthy();
    expect(view.queryByText('Download · Free')).toBeNull();
    expect(view.queryByText('Details')).toBeNull();
    // A place has no footprint to draw.
    expect(mockCaptured.footprint).toBeUndefined();

    await fireEvent.press(view.getByText('Open on reseauzec.com'));
    expect(openURL).toHaveBeenCalledWith('https://zecbatiscanneilson.reseauzec.com/');

    await fireEvent.press(view.getByLabelText('Close'));
    expect(view.queryByTestId('explore-map-place-card')).toBeNull();
    openURL.mockRestore();
  });

  it('a tapped sheet shows source, distance and Download — or Open once installed', async () => {
    const view = await mapScreen({ activity: 'hiking' });
    await tap({ id: lacBeauport.id, kind: 'map' });
    expect(view.getByText('Topographic · NRCan CanTopo · 5 MB · Free')).toBeTruthy();
    expect(view.getByText(/^\d+ km away$/)).toBeTruthy();
    expect(view.getByText('Details')).toBeTruthy();
    expect(view.queryByText(/^Open on /)).toBeNull();
    expect(view.getByText('Download · Free')).toBeTruthy();

    await act(async () => {
      useLibraryStore.setState({
        maps: [{ id: 'm1', name: 'Lac-Beauport', sourceItemId: lacBeauport.id } as MapDocument],
      });
    });
    expect(view.getByText('Open on map')).toBeTruthy();
    expect(view.queryByText('Download · Free')).toBeNull();
  });

  it('an activity nothing carries gets a friendly empty state, not a blank map', async () => {
    const view = await mapScreen({ activity: 'snowshoe' });
    expect(features()).toEqual([]);
    expect(view.getByTestId('explore-map-empty')).toBeTruthy();
    expect(view.getByText('No snowshoe maps or places yet')).toBeTruthy();
    expect(view.queryByText(/Move the map/)).toBeNull();

    await fireEvent.press(view.getByText('Show all maps'));
    expect(view.queryByTestId('explore-map-empty')).toBeNull();
    expect(features()).toHaveLength(8);
  });

  it('says to search when the view still has unloaded shards', async () => {
    shardMock.mockResolvedValue(null);
    const view = await mapScreen({ activity: 'snowshoe' });
    await act(async () => {
      mockCaptured.map?.onRegionDidChange?.({
        nativeEvent: { bounds: [-67, 47, -64, 50], zoom: 7, center: [-65.5, 48.5] },
      } as never);
    });
    expect(view.getByText('No snowshoe maps loaded here')).toBeTruthy();
    expect(view.getByText('Search here')).toBeTruthy();
  });

  it('re-frames on the nearest points when the checked activity has none in view', async () => {
    const view = await mapScreen();
    await act(async () => {
      mockCaptured.map?.onRegionDidChange?.({
        nativeEvent: { bounds: [-60, 30, -58, 32], zoom: 7, center: [-59, 31] },
      } as never);
    });
    mockFitBounds.mockClear();
    await fireEvent.press(view.getByLabelText('Filter by activity'));
    await fireEvent.press(view.getByLabelText('Hunting, 3 maps and places'));
    expect(mockFitBounds).toHaveBeenCalledTimes(1);
    const [box, options] = mockFitBounds.mock.calls[0] as [number[], { duration: number }];
    // You (Québec City) and the three hunting places.
    expect(box[1]).toBeCloseTo(QUEBEC.latitude);
    expect(box[3]).toBeCloseTo(48.634);
    expect(options.duration).toBe(400);
  });
});

describe('Explore → Climbing', () => {
  const crag = (
    i: string,
    n: string,
    lng: number,
    lat: number,
    extra: Record<string, unknown> = {},
  ) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lng, lat] },
    properties: {
      i,
      n,
      r: 37,
      s: 10,
      b: '4,20,7,6',
      g0: 4,
      g1: 22,
      st: 3,
      src: 1,
      rg: 'Charlevoix',
      v: 'a',
      ...extra,
    },
  });

  it('lists the crags in view and opens a crag card with Download and Topo', async () => {
    mockCragTiles = 'https://tiles.test/crags/{z}/{x}/{y}.mvt';
    mockRenderedCrags = [
      crag('ob-1', 'Palissades de Charlevoix', -71.1, 46.9),
      crag('ob-1', 'Palissades de Charlevoix', -71.1, 46.9),
      crag('ob-2', 'Val-Bélair', -71.5, 46.85, { a: 2, r: 61 }),
    ];
    const view = await mapScreen({ activity: 'climbing' });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    await settle();
    expect(view.getByText('2 CRAGS IN THIS AREA · 98 ROUTES')).toBeTruthy();
    expect(view.getByPlaceholderText('Filter these crags')).toBeTruthy();
    expect(view.queryByTestId('explore-map-empty')).toBeNull();
    await fireEvent.press(view.getByTestId('crag-row-ob-1'));
    expect(view.getByTestId('crag-card')).toBeTruthy();
    expect(view.getByText('Download · 6 MB')).toBeTruthy();
    expect(view.getByText('Access unknown · check FQME')).toBeTruthy();
    expect(view.getByText('Route data: OpenBeta (CC0)')).toBeTruthy();
    await fireEvent.press(view.getByTestId('crag-card-topo'));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/climbing/[uid]', params: { uid: 'ob-1' } });
    // A closed crag is never offered for download.
    await act(async () => {
      mockCaptured.crags?.onPress({
        stopPropagation: jest.fn(),
        nativeEvent: { features: [crag('ob-2', 'Val-Bélair', -71.5, 46.85, { a: 2 })] },
      });
    });
    expect(view.getByText('Access closed')).toBeTruthy();
    expect(view.queryByTestId('crag-card-primary')).toBeNull();
  });

  it('is not offered before the crag tiles are published', async () => {
    const view = await mapScreen({ activity: 'climbing' });
    expect(mockCaptured.crags).toBeUndefined();
    expect(view.getByPlaceholderText('Filter these maps')).toBeTruthy();
  });
});
