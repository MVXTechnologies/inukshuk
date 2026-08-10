import type { CatalogIndex, CatalogItem, CatalogShardRef } from '@core/catalog/schema';
import { loadCatalogManifest, loadCatalogShard } from '@data/catalogCache';
import { useCatalogStore } from './catalogStore';

/**
 * The progressive half of the world catalog: the store fetches the small index
 * first and pulls only the shards a screen actually needs. These are the
 * behaviours the Search tab depends on and that a pure module can't cover —
 * de-duplication across shards, not re-fetching what is already in, and a
 * partial failure still leaving the user with the shards that did load.
 */

jest.mock('@data/catalogCache', () => ({
  loadCatalogManifest: jest.fn(),
  loadCatalogShard: jest.fn(),
}));

const loadManifestMock = loadCatalogManifest as jest.MockedFunction<typeof loadCatalogManifest>;
const loadShardMock = loadCatalogShard as jest.MockedFunction<typeof loadCatalogShard>;

const QUEBEC = { latitude: 46.8, longitude: -71.2 };

function shardRef(
  id: string,
  category: CatalogShardRef['category'],
  west: number,
): CatalogShardRef {
  return {
    id,
    category,
    path: `shards/${id}.json`,
    itemCount: 1,
    bbox: [west, 40, west + 10, 50],
    byteSize: 1000,
  };
}

function item(id: string, category: CatalogItem['category']): CatalogItem {
  return {
    id,
    sourceId: 's1',
    title: id,
    category,
    bbox: [-71.5, 46.5, -71, 47],
    format: 'geopdf',
    packaging: 'zip',
    url: `https://example.test/${id}.zip`,
  };
}

const index: CatalogIndex = {
  schemaVersion: 2,
  sources: [{ id: 's1', name: 'S', licence: 'PD', attribution: 'S' }],
  shards: [
    shardRef('topo-n40w080', 'topo', -80),
    shardRef('nautical-n40w080', 'nautical', -80),
    shardRef('topo-n40e170', 'topo', 170),
  ],
  items: [],
  categoryCounts: { topo: 2, nautical: 1 },
};

async function loadIndex(): Promise<void> {
  loadManifestMock.mockResolvedValue({ index, fromCache: false, warnings: [] });
  await useCatalogStore.getState().load();
}

beforeEach(() => {
  useCatalogStore.setState({
    status: 'idle',
    index: null,
    items: [],
    loadedShardIds: [],
    loadingShards: false,
    fromCache: false,
    downloads: {},
  });
  loadShardMock.mockReset();
});

describe('catalogStore shard loading', () => {
  it('fetches the nearest shards across categories and merges their items', async () => {
    await loadIndex();
    loadShardMock.mockImplementation(async (shard) => ({
      items: [item(`${shard.id}-a`, shard.category)],
      fromCache: false,
      warnings: [],
    }));

    await useCatalogStore.getState().ensureShardsNear(QUEBEC, null);

    const loaded = useCatalogStore.getState().loadedShardIds;
    expect(loaded).toContain('topo-n40w080');
    expect(loaded).toContain('nautical-n40w080');
    expect(useCatalogStore.getState().items).toHaveLength(loaded.length);
    expect(useCatalogStore.getState().loadingShards).toBe(false);
  });

  it('does not re-fetch a shard it already holds', async () => {
    await loadIndex();
    loadShardMock.mockImplementation(async (shard) => ({
      items: [item(`${shard.id}-a`, shard.category)],
      fromCache: false,
      warnings: [],
    }));

    await useCatalogStore.getState().ensureShardsNear(QUEBEC, 'topo');
    const firstCallCount = loadShardMock.mock.calls.length;
    await useCatalogStore.getState().ensureShardsNear(QUEBEC, 'topo');
    expect(loadShardMock.mock.calls.length).toBe(firstCallCount);
  });

  it('restricts the fetch to the selected category', async () => {
    await loadIndex();
    loadShardMock.mockImplementation(async (shard) => ({
      items: [item(`${shard.id}-a`, shard.category)],
      fromCache: false,
      warnings: [],
    }));

    await useCatalogStore.getState().ensureShardsNear(QUEBEC, 'nautical');
    expect(loadShardMock.mock.calls.map(([shard]) => shard.id)).toEqual(['nautical-n40w080']);
  });

  it('keeps the shards that did load when one fails', async () => {
    await loadIndex();
    loadShardMock.mockImplementation(async (shard) =>
      shard.category === 'topo'
        ? null
        : { items: [item(`${shard.id}-a`, shard.category)], fromCache: false, warnings: [] },
    );

    await useCatalogStore.getState().ensureShardsNear(QUEBEC, null);
    expect(useCatalogStore.getState().loadedShardIds).toEqual(['nautical-n40w080']);
    expect(useCatalogStore.getState().items).toHaveLength(1);
    expect(useCatalogStore.getState().status).toBe('ready');
  });

  it('never lists the same item twice when shards overlap', async () => {
    await loadIndex();
    loadShardMock.mockResolvedValue({
      items: [item('shared', 'topo')],
      fromCache: false,
      warnings: [],
    });

    await useCatalogStore.getState().ensureShardsNear(QUEBEC, null);
    expect(useCatalogStore.getState().items.map((i) => i.id)).toEqual(['shared']);
  });

  it('is a no-op for a shardless (inline) index', async () => {
    loadManifestMock.mockResolvedValue({
      index: { ...index, shards: [], items: [item('inline', 'topo')] },
      fromCache: false,
      warnings: [],
    });
    await useCatalogStore.getState().load();
    await useCatalogStore.getState().ensureShardsNear(QUEBEC, null);
    expect(loadShardMock).not.toHaveBeenCalled();
    expect(useCatalogStore.getState().items.map((i) => i.id)).toEqual(['inline']);
  });

  it('starts from the fresh index on reload rather than stale shard items', async () => {
    await loadIndex();
    loadShardMock.mockResolvedValue({
      items: [item('old', 'topo')],
      fromCache: false,
      warnings: [],
    });
    await useCatalogStore.getState().ensureShardsNear(QUEBEC, 'topo');
    expect(useCatalogStore.getState().items).toHaveLength(1);

    useCatalogStore.setState({ status: 'ready' });
    await useCatalogStore.getState().load(true);
    expect(useCatalogStore.getState().items).toEqual([]);
    expect(useCatalogStore.getState().loadedShardIds).toEqual([]);
  });
});
