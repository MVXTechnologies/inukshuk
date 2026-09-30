/**
 * The explorer's filtered list (#447): the entry filter, the chips (clear a
 * facet, pick another), nearest-first order, the map toggle, and the empty
 * state that offers to look further while unloaded shards remain.
 */
import type { ExploreFilter } from '@core/catalog/exploreFacets';
import { parseCatalogFacets } from '@core/catalog/facets';
import type { CatalogShardRef } from '@core/catalog/schema';
import { loadCatalogFacets, loadCatalogShard } from '@data/catalogCache';
import { useExploreHandoffStore } from '@state/exploreHandoffStore';
import { useSettingsStore } from '@state/settingsStore';
import { act, fireEvent } from '@testing-library/react-native';

import { ExploreListScreen } from './ExploreListScreen';
import {
  CUPERTINO,
  cupertinoFacetsRaw,
  cupertinoIndex,
  fixtureIndex,
  mountWithProviders,
  QUEBEC,
  seedCatalog,
  serveCupertinoShard,
  settle,
  usTopo,
} from './exploreTestUtils';

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
  loadCatalogFacets: jest.fn(),
}));

const TITLES = /^(Québec — Lac-Beauport|Jacques-Cartier trails|Saguenay Fjord chart)$/;

beforeEach(() => {
  mockPush.mockReset();
  mockReplace.mockReset();
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

it('rows open the detail screen; the header pushes the map with the same filter', async () => {
  const view = await list({ activity: 'hiking' });
  await fireEvent.press(view.getByText('Québec — Lac-Beauport'));
  expect(mockPush).toHaveBeenCalledWith('/explore/item/cantopo-021l14');
  // Pushed (not replaced) so the map's back arrow returns to this list.
  await fireEvent.press(view.getByLabelText('Show on a map'));
  expect(mockPush).toHaveBeenLastCalledWith('/explore/map?activity=hiking&from=list');
  expect(mockReplace).not.toHaveBeenCalled();
});

it('has a labelled "Browse on the map" pill carrying the current filter (#474)', async () => {
  const view = await list({ terrain: 'coast' });
  expect(view.getByText('Browse on the map')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('Browse Coast on the map'));
  expect(mockPush).toHaveBeenLastCalledWith('/explore/map?terrain=coast&from=list');
});

it('adopts the filter the map hands back, and ignores a stale one on arrival (#474)', async () => {
  useExploreHandoffStore.getState().handBack({ kind: 'nautical' }); // some earlier map
  const view = await list({ activity: 'hiking' });
  expect(view.getByRole('header', { name: 'Hiking' })).toBeTruthy();
  expect(useExploreHandoffStore.getState().listFilter).toBeNull();

  await act(async () => {
    useExploreHandoffStore.getState().handBack({ activity: 'paddling' });
  });
  expect(view.getByRole('header', { name: 'Paddling' })).toBeTruthy();
  expect(shown(view)).toEqual(['Jacques-Cartier trails', 'Saguenay Fjord chart']);
  expect(useExploreHandoffStore.getState().listFilter).toBeNull();
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

/**
 * The owner's "Hiking bugs big time" (#474), against shards shaped like the
 * live catalog: US Topo sheets carry terrain and no stored activities.
 */
describe('with realistic US Topo shards (Cupertino, #474)', () => {
  const facetsMock = () => loadCatalogFacets as jest.Mock;
  const shardMock = () => loadCatalogShard as jest.Mock;
  const titles = (view: Awaited<ReturnType<typeof list>>) =>
    view.queryAllByText(/— US Topo$/).map((n) => String(n.props.children));

  beforeEach(() => {
    shardMock().mockReset().mockImplementation(serveCupertinoShard);
    facetsMock()
      .mockReset()
      .mockResolvedValue({
        facets: parseCatalogFacets(cupertinoFacetsRaw).facets,
        fromCache: false,
        warnings: [],
      });
    seedCatalog(cupertinoIndex());
    useSettingsStore.setState({ lastKnownPosition: CUPERTINO });
  });

  it('lists the mountain sheets under Hiking (terrain affinity), nearest first', async () => {
    const view = await list({ activity: 'hiking' });
    expect(view.getByRole('header', { name: 'Hiking' })).toBeTruthy();
    expect(titles(view).slice(0, 2)).toEqual([
      'Cupertino, California — US Topo',
      'Castle Rock Ridge, California — US Topo',
    ]);
    expect(view.queryByText('No maps like this in the areas loaded so far.')).toBeNull();
  });

  it('lists something for every activity and terrain the landing counts', async () => {
    const index = cupertinoIndex();
    const cases = [
      ...Object.keys(index.activityCounts ?? {}).map((activity) => ({ activity })),
      ...Object.keys(index.terrainCounts ?? {}).map((terrain) => ({ terrain })),
    ] as ExploreFilter[];
    for (const filter of cases) {
      seedCatalog(cupertinoIndex());
      const view = await list(filter);
      expect([filter, titles(view).length > 0]).toEqual([filter, true]);
      await view.unmount();
    }
  });

  it('works with no location too', async () => {
    useSettingsStore.setState({ lastKnownPosition: null });
    const view = await list({ activity: 'hiking' });
    expect(titles(view)).toContain('Cupertino, California — US Topo');
  });

  it('pulls only the shards that hold the facet: Climbing reaches Shasta in one go', async () => {
    const view = await list({ activity: 'climbing' });
    expect(titles(view)).toEqual(['Mount Shasta, California — US Topo']);
    const fetched = shardMock().mock.calls.map(
      (call: unknown[]) => (call[0] as CatalogShardRef).id,
    );
    expect(fetched).toEqual(['topo-n40w130-1']);
  });
});

describe('an empty list never pages by itself (#474)', () => {
  // Eight shards of plain sheets and no facets digest: nothing matches, so
  // the list stays empty while rings remain to load.
  const plainShards: CatalogShardRef[] = Array.from({ length: 8 }, (_, i) => ({
    id: `topo-ring-${i}`,
    category: 'topo',
    path: `shards/ring-${i}.json`,
    itemCount: 1,
    bbox: [-122 + i, 37, -121.5 + i, 37.5],
    byteSize: 100,
  }));

  beforeEach(() => {
    (loadCatalogShard as jest.Mock).mockReset().mockImplementation((ref: CatalogShardRef) =>
      Promise.resolve({
        items: [usTopo(`plain-${ref.id}`, 37.25, -121.75 + Number(ref.id.slice(-1)))],
        fromCache: false,
        warnings: [],
      }),
    );
    seedCatalog(cupertinoIndex({ shards: plainShards, facets: undefined }));
    useSettingsStore.setState({ lastKnownPosition: CUPERTINO });
  });

  it('loads one ring, then waits for "Look further away"', async () => {
    const shardMock = loadCatalogShard as jest.Mock;
    const view = await list({ terrain: 'glacier' });
    expect(shardMock).toHaveBeenCalledTimes(6);
    expect(view.getByText('No maps like this in the areas loaded so far.')).toBeTruthy();
    expect(view.getByText('Look further away')).toBeTruthy();

    // The owner's flicker: VirtualizedList calls onEndReached on an EMPTY list
    // every time the empty view's height changes — and it does change, between
    // "Loading maps for this area…" and the message. Paging from there made a
    // loop: load a ring → spinner → message → onEndReached → load the next
    // ring… until the whole world catalog was in (and then, with nothing left,
    // no button). Drive the list's real edge logic through native layout
    // passes of alternating heights: nothing may load.
    const results = view.getByTestId('explore-results');
    await fireEvent(results, 'layout', {
      nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 700 } },
    });
    for (const height of [180, 240, 180, 240]) {
      await fireEvent(results, 'contentSizeChange', 400, height);
      await settle();
    }
    expect(shardMock).toHaveBeenCalledTimes(6);

    // A GPS fix persisted a few metres on (City Run) is no reason to reload.
    await act(async () => {
      useSettingsStore.setState({
        lastKnownPosition: { latitude: CUPERTINO.latitude + 0.001, longitude: -122.03 },
      });
    });
    await settle();
    expect(shardMock).toHaveBeenCalledTimes(6);

    await fireEvent.press(view.getByText('Look further away'));
    await settle();
    expect(shardMock).toHaveBeenCalledTimes(8);
    // Everything is loaded now: nothing further to offer.
    expect(view.queryByText('Look further away')).toBeNull();
  });
});
