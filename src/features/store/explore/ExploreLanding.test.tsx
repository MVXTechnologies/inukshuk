/**
 * The Explore tab's Discover landing (#447): sections render from fixture
 * data, zero-count facets hide, the offline and legacy-index states degrade
 * honestly, and every tile routes to the right stack screen.
 */
import { loadCatalogManifest } from '@data/catalogCache';
import { loadCatalogCollectionsRaw } from '@data/catalogCollections';
import { StoreScreen } from '@features/store/StoreScreen';
import { useCatalogStore } from '@state/catalogStore';
import { useSettingsStore } from '@state/settingsStore';
import { fireEvent } from '@testing-library/react-native';
import { Linking } from 'react-native';

import {
  fixtureIndex,
  fixtureItem,
  mountWithProviders,
  QUEBEC,
  seedCatalog,
  sepaqRaw,
  settle,
  usTopo,
} from './exploreTestUtils';
import { resetLinkOutCollectionsCache } from './useLinkOutCollections';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ navigate: jest.fn(), push: mockPush, back: jest.fn(), replace: jest.fn() }),
}));
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
jest.mock('@data/catalogCollections', () => ({ loadCatalogCollectionsRaw: jest.fn() }));

const collectionsMock = loadCatalogCollectionsRaw as jest.Mock;

beforeEach(() => {
  resetLinkOutCollectionsCache();
  collectionsMock.mockResolvedValue(sepaqRaw);
  (loadCatalogManifest as jest.Mock).mockResolvedValue(null);
  useSettingsStore.setState({ lastKnownPosition: QUEBEC, units: 'metric' });
});

async function landing() {
  const view = await mountWithProviders(<StoreScreen />);
  await settle();
  return view;
}

it('renders every section from the index counts and loaded maps', async () => {
  seedCatalog(
    fixtureIndex({
      activityCounts: { hiking: 1204, ski: 0, paddling: 12 },
      terrainCounts: { mountains: 14200, water: 9800, glacier: 0 },
      sourceCounts: { 'nrcan-cantopo': 2234, 'chs-charts': 0 },
    }),
  );
  const view = await landing();

  // Popular near you: the carousel, with "See on map".
  expect(view.getByText('Popular near you')).toBeTruthy();
  expect(view.getByText('Québec — Lac-Beauport')).toBeTruthy();
  expect(view.getByText('Jacques-Cartier trails')).toBeTruthy();
  // By activity: counted activities only; zero and absent ones hidden.
  expect(view.getByText('By activity')).toBeTruthy();
  expect(view.getByLabelText('Hiking, 1204 maps')).toBeTruthy();
  expect(view.getByText('Paddling')).toBeTruthy();
  expect(view.queryByText('Ski')).toBeNull();
  expect(view.queryByText('Fishing')).toBeNull();
  // By terrain, with whole-catalog counts.
  expect(view.getByText('Mountains')).toBeTruthy();
  expect(view.getByText('14 200 maps')).toBeTruthy();
  expect(view.getByText('Rivers & lakes')).toBeTruthy();
  expect(view.queryByText('Glaciers')).toBeNull();
  // Collections: Parcs Québec first, then publishers with counts; an empty
  // publisher is left out.
  const rows = view.getAllByText(/^(Parcs Québec|NRCan CanTopo|CHS Charts)$/);
  expect(rows.map((n) => String(n.props.children))).toEqual(['Parcs Québec', 'NRCan CanTopo']);
  expect(view.getByText('3 places · Maps on sepaq.com')).toBeTruthy();
  expect(view.getByText('2 234 maps · OGL-Canada-2.0')).toBeTruthy();
  // By type: every kind with its total — the way into "All maps".
  expect(view.getByText('Topographic · 1')).toBeTruthy();
  expect(view.getByText('Nautical · 1')).toBeTruthy();
});

it('routes each tile to its stack screen', async () => {
  seedCatalog(fixtureIndex({ activityCounts: { hiking: 3 }, terrainCounts: { water: 2 } }));
  const view = await landing();

  await fireEvent.press(view.getByLabelText('Hiking, 3 maps'));
  expect(mockPush).toHaveBeenLastCalledWith('/explore/list?activity=hiking');
  await fireEvent.press(view.getByText('Rivers & lakes'));
  expect(mockPush).toHaveBeenLastCalledWith('/explore/list?terrain=water');
  await fireEvent.press(view.getByText('Parcs Québec'));
  expect(mockPush).toHaveBeenLastCalledWith('/explore/collection/sepaq');
  await fireEvent.press(view.getByText('NRCan CanTopo'));
  expect(mockPush).toHaveBeenLastCalledWith('/explore/list?source=nrcan-cantopo');
  await fireEvent.press(view.getByText('Nautical · 1'));
  expect(mockPush).toHaveBeenLastCalledWith('/explore/list?kind=nautical');
  await fireEvent.press(view.getByLabelText('Browse all maps'));
  expect(mockPush).toHaveBeenLastCalledWith('/explore/list');
  await fireEvent.press(view.getByText('Québec — Lac-Beauport'));
  expect(mockPush).toHaveBeenLastCalledWith('/explore/item/cantopo-021l14');
  await fireEvent.press(view.getByLabelText('See maps near you on a map'));
  expect(mockPush).toHaveBeenLastCalledWith('/explore/map');
  await fireEvent.press(view.getByLabelText('Browse all maps on the map'));
  expect(mockPush).toHaveBeenLastCalledWith('/explore/map');
});

it('has an explicit, labelled map pill — even with no position (#474)', async () => {
  useSettingsStore.setState({ lastKnownPosition: null });
  seedCatalog(fixtureIndex());
  const view = await landing();
  expect(view.getByText('Map')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('Browse all maps on the map'));
  expect(mockPush).toHaveBeenLastCalledWith('/explore/map');
});

it('puts search and the map pill side by side in one row (2.1.1)', async () => {
  seedCatalog(fixtureIndex());
  const view = await landing();
  const search = view.getByLabelText('Search maps');
  const pill = view.getByLabelText('Browse all maps on the map');
  // Same parent row, laid out horizontally; the search field takes the room.
  const row = view.getByTestId('explore-search-row');
  expect(row).toHaveStyle({ flexDirection: 'row' });
  expect(row).toContainElement(search);
  expect(row).toContainElement(pill);
  // The header's duplicate map glyph and the landing's own pill row are gone.
  expect(view.queryByLabelText('Show on a map')).toBeNull();
  expect(view.queryByText('Browse on the map')).toBeNull();
  expect(view.getAllByLabelText('Browse all maps on the map')).toHaveLength(1);
});

it('lists US Topo sheets (terrain only, no stored activities) under Hiking when loaded', async () => {
  // Before #474 the landing's own fallback count ignored the terrain affinity,
  // so a catalog without index counts showed no "By activity" at all.
  seedCatalog(
    fixtureIndex({ items: [usTopo('cupertino', 37.31, -122.06, ['mountains'])], shards: [] }),
  );
  const view = await landing();
  expect(view.getByText('By activity')).toBeTruthy();
  expect(view.getByLabelText('Hiking')).toBeTruthy();
});

it('without index counts, shows only what loaded maps carry — and no totals', async () => {
  seedCatalog(fixtureIndex());
  const view = await landing();
  expect(view.getByLabelText('Hiking')).toBeTruthy();
  expect(view.queryByText('Ski')).toBeTruthy(); // Lac-Beauport carries ski
  expect(view.getByText('Mountains')).toBeTruthy();
  expect(view.queryByText(/\d maps$/)).toBeNull(); // no terrain/publisher totals claimed
});

it('hides activity and terrain entirely for a catalog from before the taxonomy', async () => {
  const legacy = [
    fixtureItem('a', 'Old sheet A', 46.9, -71.3),
    fixtureItem('b', 'Old sheet B', 47.0, -71.2),
  ];
  seedCatalog(fixtureIndex({ items: legacy, categoryCounts: { topo: 2 } }));
  collectionsMock.mockResolvedValue(null);
  const view = await landing();
  expect(view.getByText('Popular near you')).toBeTruthy();
  expect(view.queryByText('By activity')).toBeNull();
  expect(view.queryByText('By terrain')).toBeNull();
  // collections.json unavailable → no Parcs Québec row.
  expect(view.queryByText('Parcs Québec')).toBeNull();
  expect(view.getByText('Topographic · 2')).toBeTruthy();
});

it('says the catalog is the saved copy when offline', async () => {
  seedCatalog(fixtureIndex(), { fromCache: true });
  const view = await landing();
  expect(view.getByText('Showing the saved catalog — downloads need a connection.')).toBeTruthy();
});

it('asks for a first fix instead of an empty carousel without a position', async () => {
  useSettingsStore.setState({ lastKnownPosition: null });
  seedCatalog(fixtureIndex());
  const view = await landing();
  expect(view.queryByText('Popular near you')).toBeNull();
  expect(view.getByText('Open the Map tab once to see the maps near you first.')).toBeTruthy();
});

describe('Popular near you never vanishes silently', () => {
  it('folds nearby parks in, each card drawing a footprint thumbnail', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    seedCatalog(fixtureIndex());
    const view = await landing();
    // Jacques-Cartier and the Laurentides reserve are within reach; Gaspésie is not.
    expect(view.getByText('Parc national de la Jacques-Cartier')).toBeTruthy();
    expect(view.getByText('Réserve faunique des Laurentides')).toBeTruthy();
    expect(view.queryAllByText('Parc national de la Gaspésie')).toHaveLength(0);
    // Every card has an offline footprint picture.
    expect(
      view.getAllByTestId('footprint-thumb', { includeHiddenElements: true }).length,
    ).toBeGreaterThanOrEqual(4);
    await fireEvent.press(view.getByText('Parc national de la Jacques-Cartier'));
    expect(open).toHaveBeenCalledWith('https://www.sepaq.com/pq/jac/');
    open.mockRestore();
  });

  it('says it is still looking while the nearest shards load', async () => {
    collectionsMock.mockResolvedValue(null);
    seedCatalog(fixtureIndex({ items: [] }), { loadingShards: true });
    const view = await landing();
    expect(view.getByText('Popular near you')).toBeTruthy();
    expect(view.getByText('Finding maps near you…')).toBeTruthy();
  });

  it('says so when nothing is in range', async () => {
    collectionsMock.mockResolvedValue(null);
    seedCatalog(fixtureIndex({ items: [usTopo('cupertino', 37.31, -122.06, ['mountains'])] }));
    const view = await landing();
    expect(view.getByText('No maps in the catalog near you yet.')).toBeTruthy();
  });
});

it('ends with the organisation call to action', async () => {
  seedCatalog(fixtureIndex());
  const view = await landing();
  expect(view.getByTestId('org-maps-cta')).toBeTruthy();
  expect(view.getByText('Your organisation’s maps aren’t here?')).toBeTruthy();
  expect(view.getByText('marc-andre.vigneault@mvxtechnologies.com')).toBeTruthy();
});

it('offers Retry when the catalog cannot load at all', async () => {
  useCatalogStore.setState({ status: 'error', index: null, items: [] });
  const view = await landing();
  expect(view.getByText(/Couldn’t load the map catalog/)).toBeTruthy();
  expect(view.getByText('Retry')).toBeTruthy();
});
