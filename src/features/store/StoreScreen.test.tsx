/**
 * The Search tab's whole-catalog search, at the real call site.
 *
 * This is the regression test for a bug that passed CI and shipped: the screen
 * filtered the items it happened to have pulled for the user's area, and the
 * shard-fetch effect did not list `query` among its deps — so typing never
 * fetched anything and a user in Montréal searching "Grand Canyon" was told
 * "No maps match your search." about a catalog holding it.
 *
 * Everything below the network boundary is real: the store, the search digest,
 * shard selection, the item filter and the screen's own empty-state logic.
 */
import type { CatalogIndex, CatalogItem, CatalogShardRef } from '@core/catalog/schema';
import { buildCatalogSearchDigest } from '@core/catalog/searchDigest';
import { loadCatalogManifest, loadCatalogSearchDigest, loadCatalogShard } from '@data/catalogCache';
import { StoreScreen } from '@features/store/StoreScreen';
import { useCatalogStore } from '@state/catalogStore';
import { useSettingsStore } from '@state/settingsStore';
import { act, render } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';

jest.mock('expo-router', () => ({ useRouter: () => ({ navigate: jest.fn() }) }));
jest.mock('@features/store/downloadCatalogItem', () => ({
  CatalogDownloadCanceled: class extends Error {},
  cancelCatalogDownload: jest.fn(),
  downloadCatalogItemToLibrary: jest.fn(),
}));
jest.mock('@data/catalogCache', () => ({
  loadCatalogManifest: jest.fn(),
  loadCatalogShard: jest.fn(),
  loadCatalogSearchDigest: jest.fn(),
}));

const item = (id: string, title: string, lat: number, lon: number): CatalogItem => ({
  id,
  sourceId: 's1',
  title,
  category: 'topo',
  bbox: [lon - 0.05, lat - 0.05, lon + 0.05, lat + 0.05],
  format: 'geopdf',
  packaging: 'none',
  url: `https://example.test/${id}.pdf`,
});

// 30 shards marching west of Montréal, plus the Grand Canyon far away.
const nearShards: CatalogShardRef[] = Array.from({ length: 30 }, (_, i) => ({
  id: `topo-near${String(i).padStart(2, '0')}`,
  category: 'topo' as const,
  path: `shards/near${i}.json`,
  itemCount: 1,
  bbox: [-74 - i, 45, -73 - i, 46] as [number, number, number, number],
  byteSize: 200,
}));
const GRAND: CatalogShardRef = {
  id: 'topo-grand',
  category: 'topo',
  path: 'shards/grand.json',
  itemCount: 1,
  bbox: [-112.2, 36.0, -112.0, 36.2],
  byteSize: 200,
};
const canyon = item('usgs-36112a1', 'Grand Canyon — US Topo', 36.1, -112.1);
const itemsFor = (shard: CatalogShardRef): CatalogItem[] =>
  shard.id === 'topo-grand'
    ? [canyon]
    : [item(shard.id, `Sheet ${shard.id}`, 45.5, (shard.bbox?.[0] ?? -74) + 0.5)];

const index: CatalogIndex = {
  schemaVersion: 2,
  sources: [{ id: 's1', name: 'Src', licence: 'PD', attribution: 'Src' }],
  shards: [...nearShards, GRAND],
  items: [],
  categoryCounts: { topo: 31 },
  search: { path: 'search.json' },
};
const digest = buildCatalogSearchDigest(
  [...nearShards, GRAND].map((s) => ({ id: s.id, items: itemsFor(s) })),
);

const fetched: string[] = [];

beforeEach(() => {
  jest.useFakeTimers();
  fetched.length = 0;
  (loadCatalogManifest as jest.Mock).mockResolvedValue({ index, fromCache: false, warnings: [] });
  (loadCatalogShard as jest.Mock).mockImplementation(async (shard: CatalogShardRef) => {
    fetched.push(shard.id);
    return { items: itemsFor(shard), fromCache: false, warnings: [] };
  });
  (loadCatalogSearchDigest as jest.Mock).mockResolvedValue({
    digest,
    fromCache: false,
    warnings: [],
  });
  useCatalogStore.setState({
    status: 'idle',
    index: null,
    items: [],
    loadedShardIds: [],
    shardFailures: {},
    loadingShards: false,
    searchDigest: null,
    searchDigestTried: false,
    loadingSearch: false,
    searchScope: 'area-only',
    pendingQueryShardIds: [],
  });
  useSettingsStore.setState({ lastKnownPosition: { latitude: 45.5, longitude: -73.6 } });
});

afterEach(() => jest.useRealTimers());

const flush = async () => {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      jest.advanceTimersByTime(400);
    });
  }
};

async function mount() {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 400, height: 800 },
        insets: { top: 0, left: 0, right: 0, bottom: 0 },
      }}
    >
      <PaperProvider>
        <StoreScreen />
      </PaperProvider>
    </SafeAreaProvider>,
  );
}

it('typing "Grand Canyon" fetches the far shard and shows the map', async () => {
  const view = await mount();
  await flush();
  expect(fetched).not.toContain('topo-grand');
  expect(view.queryByText('Grand Canyon — US Topo')).toBeNull();

  fetched.length = 0;
  await act(async () => {
    view.getByPlaceholderText('Search maps').props.onChangeText('Grand Canyon');
  });
  await flush();

  expect(fetched).toContain('topo-grand');
  expect(view.queryByText('No maps match your search.')).toBeNull();
  expect(view.getByText('Grand Canyon — US Topo')).toBeTruthy();
});

it('never claims "no maps match" while the catalog is only partly searched', async () => {
  // Digest unreachable — exactly the offline case.
  (loadCatalogSearchDigest as jest.Mock).mockResolvedValue(null);
  const view = await mount();
  await flush();
  await act(async () => {
    view.getByPlaceholderText('Search maps').props.onChangeText('Grand Canyon');
  });
  await flush();

  expect(view.queryByText('No maps match your search.')).toBeNull();
  expect(view.getByText(/this area only/)).toBeTruthy();
  expect(view.getByText('Search the whole catalog')).toBeTruthy();
});

it('still says "no maps match" when the catalog genuinely has none', async () => {
  const view = await mount();
  await flush();
  await act(async () => {
    view.getByPlaceholderText('Search maps').props.onChangeText('kilimanjaro');
  });
  await flush();

  expect(view.getByText('No maps match your search.')).toBeTruthy();
});
