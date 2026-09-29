/**
 * The explorer's filtered list (#447): the entry filter, the chips (clear a
 * facet, pick another), nearest-first order, the map toggle, and the empty
 * state that offers to look further while unloaded shards remain.
 */
import type { CatalogShardRef } from '@core/catalog/schema';
import { loadCatalogShard } from '@data/catalogCache';
import { useSettingsStore } from '@state/settingsStore';
import { fireEvent } from '@testing-library/react-native';

import { ExploreListScreen } from './ExploreListScreen';
import { fixtureIndex, mountWithProviders, QUEBEC, seedCatalog, settle } from './exploreTestUtils';

const mockReplace = jest.fn();
const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ navigate: jest.fn(), push: mockPush, back: jest.fn(), replace: mockReplace }),
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

const TITLES = /^(Québec — Lac-Beauport|Jacques-Cartier trails|Saguenay Fjord chart)$/;

beforeEach(() => {
  seedCatalog(fixtureIndex());
  useSettingsStore.setState({ lastKnownPosition: QUEBEC, units: 'metric' });
});

async function list(filter: Parameters<typeof ExploreListScreen>[0]['initialFilter']) {
  const view = await mountWithProviders(<ExploreListScreen initialFilter={filter} />);
  await settle();
  return view;
}

const shown = (view: Awaited<ReturnType<typeof list>>) =>
  view.queryAllByText(TITLES).map((n) => String(n.props.children));

it('shows the activity it was opened with, nearest first', async () => {
  const view = await list({ activity: 'hiking' });
  expect(view.getByRole('header', { name: 'Hiking' })).toBeTruthy();
  expect(shown(view)).toEqual(['Québec — Lac-Beauport', 'Jacques-Cartier trails']);
});

it('clears a facet chip and picks another from its options', async () => {
  const view = await list({ activity: 'hiking' });
  await fireEvent.press(view.getByLabelText('Hiking, clear activity filter'));
  expect(view.getByRole('header', { name: 'All maps' })).toBeTruthy();
  expect(shown(view)).toHaveLength(3);

  await fireEvent.press(view.getByLabelText('Filter by terrain'));
  await fireEvent.press(view.getByLabelText('Coast, 1 maps'));
  expect(shown(view)).toEqual(['Saguenay Fjord chart']);
});

it('filters by publisher and by type', async () => {
  const bySource = await list({ sourceId: 'chs-charts' });
  expect(bySource.getByRole('header', { name: 'CHS Charts' })).toBeTruthy();
  expect(shown(bySource)).toEqual(['Saguenay Fjord chart']);
  await bySource.unmount();

  const byKind = await list({ kind: 'park' });
  expect(shown(byKind)).toEqual(['Jacques-Cartier trails']);
});

it('rows open the detail screen; the header toggles to the map with the same filter', async () => {
  const view = await list({ activity: 'hiking' });
  await fireEvent.press(view.getByText('Québec — Lac-Beauport'));
  expect(mockPush).toHaveBeenCalledWith('/explore/item/cantopo-021l14');
  await fireEvent.press(view.getByLabelText('Show on a map'));
  expect(mockReplace).toHaveBeenCalledWith('/explore/map?activity=hiking');
});

it('offers to look further away while shards remain unloaded', async () => {
  const far: CatalogShardRef = {
    id: 'topo-far',
    category: 'topo',
    path: 'shards/far.json',
    itemCount: 1,
    bbox: [-120, 40, -110, 50],
  };
  (loadCatalogShard as jest.Mock).mockResolvedValue(null); // offline: the shard never lands
  seedCatalog(fixtureIndex({ shards: [far] }), { shardFailures: {} });
  const view = await list({ activity: 'climbing' });
  expect(view.getByText('No maps like this in the areas loaded so far.')).toBeTruthy();
  // The failed shard is cooling down now, so there is nothing further to try.
  expect(view.queryByText('Look further away')).toBeNull();
});
