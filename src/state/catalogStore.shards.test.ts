import type { CatalogIndex, CatalogItem, CatalogShardRef } from '@core/catalog/schema';
import { buildCatalogSearchDigest } from '@core/catalog/searchDigest';
import {
  loadCatalogManifest,
  loadCatalogSearchDigest,
  loadCatalogShard,
} from '@data/catalogCache';
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
  loadCatalogSearchDigest: jest.fn(),
}));

const loadManifestMock = loadCatalogManifest as jest.MockedFunction<typeof loadCatalogManifest>;
const loadShardMock = loadCatalogShard as jest.MockedFunction<typeof loadCatalogShard>;
const loadDigestMock = loadCatalogSearchDigest as jest.MockedFunction<
  typeof loadCatalogSearchDigest
>;

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
    shardFailures: {},
    loadingShards: false,
    fromCache: false,
    downloads: {},
    searchDigest: null,
    searchDigestTried: false,
    loadingSearch: false,
    searchScope: 'area-only',
    pendingQueryShardIds: [],
  });
  loadShardMock.mockReset();
  loadDigestMock.mockReset();
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

  // A shard the CDN has not published yet (partial deploy, cache lag) used to
  // be re-picked nearest-first forever: never added to loadedShardIds, so it
  // permanently consumed one of the six fetch slots and the shards behind it
  // could never load.
  describe('a shard that fails does not block the ones behind it', () => {
    /** Eight topo shards marching west; the nearest six are dead. */
    const many: CatalogIndex = {
      ...index,
      shards: Array.from({ length: 8 }, (_, i) => shardRef(`topo-w${i}`, 'topo', -80 - i * 10)),
    };

    async function loadMany(): Promise<void> {
      loadManifestMock.mockResolvedValue({ index: many, fromCache: false, warnings: [] });
      await useCatalogStore.getState().load();
    }

    it('does not re-request a shard that just failed', async () => {
      await loadMany();
      loadShardMock.mockResolvedValue(null);
      await useCatalogStore.getState().ensureShardsNear(QUEBEC, 'topo');
      const firstRound = loadShardMock.mock.calls.map(([shard]) => shard.id);
      expect(firstRound).toHaveLength(6);

      loadShardMock.mockClear();
      await useCatalogStore.getState().ensureShardsNear(QUEBEC, 'topo');
      const secondRound = loadShardMock.mock.calls.map(([shard]) => shard.id);
      for (const id of firstRound) expect(secondRound).not.toContain(id);
    });

    it('lets the budget advance to the shards behind the dead ones', async () => {
      await loadMany();
      const dead = new Set(['topo-w0', 'topo-w1', 'topo-w2', 'topo-w3', 'topo-w4', 'topo-w5']);
      loadShardMock.mockImplementation(async (shard) =>
        dead.has(shard.id)
          ? null
          : { items: [item(`${shard.id}-a`, shard.category)], fromCache: false, warnings: [] },
      );

      await useCatalogStore.getState().ensureShardsNear(QUEBEC, 'topo');
      expect(useCatalogStore.getState().loadedShardIds).toEqual([]);

      // Before the fix this round re-picked the same six dead shards and the
      // last two were unreachable for the whole session.
      await useCatalogStore.getState().ensureShardsNear(QUEBEC, 'topo');
      expect(useCatalogStore.getState().loadedShardIds).toEqual(['topo-w6', 'topo-w7']);
      expect(useCatalogStore.getState().items).toHaveLength(2);
    });

    it('forgets failures on a forced reload (the directory may have changed)', async () => {
      await loadMany();
      loadShardMock.mockResolvedValue(null);
      await useCatalogStore.getState().ensureShardsNear(QUEBEC, 'topo');
      expect(Object.keys(useCatalogStore.getState().shardFailures)).toHaveLength(6);

      useCatalogStore.setState({ status: 'ready' });
      await useCatalogStore.getState().load(true);
      expect(useCatalogStore.getState().shardFailures).toEqual({});
    });

    it('clears a shard’s failure once it does load', async () => {
      await loadMany();
      loadShardMock.mockResolvedValue(null);
      await useCatalogStore.getState().ensureShardsNear(QUEBEC, 'topo');
      expect(useCatalogStore.getState().shardFailures['topo-w0']).toBeDefined();

      // Same shard, offered again after the cooldown lapses.
      useCatalogStore.setState({ shardFailures: {} });
      loadShardMock.mockImplementation(async (shard) => ({
        items: [item(`${shard.id}-a`, shard.category)],
        fromCache: false,
        warnings: [],
      }));
      await useCatalogStore.getState().ensureShardsNear(QUEBEC, 'topo');
      expect(useCatalogStore.getState().shardFailures['topo-w0']).toBeUndefined();
    });
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

/**
 * Search across the whole catalog. Before the digest, the Search tab filtered
 * only the shards already pulled for the user's area, so a user in Québec
 * typing "Grand Canyon" got a confident "No maps match your search." about a
 * catalog holding it.
 */
describe('catalogStore query search', () => {
  const quebecSheet = item('cantopo-021l14', 'topo');
  const canyonSheet: CatalogItem = {
    ...item('usgs-36112a1', 'topo'),
    title: 'Grand Canyon — US Topo',
    bbox: [-112.2, 36, -112, 36.2],
  };

  const searchIndex: CatalogIndex = {
    ...index,
    shards: [
      { ...shardRef('topo-n40w080', 'topo', -80), bbox: [-80, 40, -70, 50] },
      { ...shardRef('topo-n30w120', 'topo', -120), bbox: [-113, 36, -112, 37] },
    ],
    search: { path: 'search.json' },
  };

  const digest = buildCatalogSearchDigest([
    { id: 'topo-n40w080', items: [{ ...quebecSheet, title: 'Québec — CanTopo 021L14' }] },
    { id: 'topo-n30w120', items: [canyonSheet] },
  ]);

  async function loadSearchIndex(): Promise<void> {
    loadManifestMock.mockResolvedValue({ index: searchIndex, fromCache: false, warnings: [] });
    await useCatalogStore.getState().load();
    loadShardMock.mockImplementation(async (shard) => ({
      items: shard.id === 'topo-n30w120' ? [canyonSheet] : [quebecSheet],
      fromCache: false,
      warnings: [],
    }));
  }

  it('pulls the far shard a nearest-first fetch would never have reached', async () => {
    await loadSearchIndex();
    loadDigestMock.mockResolvedValue({ digest, fromCache: false, warnings: [] });

    await useCatalogStore.getState().ensureShardsForQuery('Grand Canyon', QUEBEC);

    expect(loadShardMock.mock.calls.map(([s]) => s.id)).toEqual(['topo-n30w120']);
    expect(useCatalogStore.getState().items.map((i) => i.id)).toContain('usgs-36112a1');
    expect(useCatalogStore.getState().searchScope).toBe('complete');
    expect(useCatalogStore.getState().pendingQueryShardIds).toEqual([]);
  });

  // The claim the empty state rests on: with the digest loaded and nothing
  // selected, "no maps match your search" is a true statement.
  it('reports a complete scope for a query the catalog genuinely lacks', async () => {
    await loadSearchIndex();
    loadDigestMock.mockResolvedValue({ digest, fromCache: false, warnings: [] });

    await useCatalogStore.getState().ensureShardsForQuery('kilimanjaro', QUEBEC);

    expect(loadShardMock).not.toHaveBeenCalled();
    expect(useCatalogStore.getState().searchScope).toBe('complete');
  });

  it('falls back to "area only" when the digest cannot be fetched (offline)', async () => {
    await loadSearchIndex();
    loadDigestMock.mockResolvedValue(null);

    await useCatalogStore.getState().ensureShardsForQuery('Grand Canyon', QUEBEC);

    expect(useCatalogStore.getState().searchScope).toBe('area-only');
    expect(loadShardMock).not.toHaveBeenCalled();
  });

  it('does not re-fetch the digest on every keystroke after it fails', async () => {
    await loadSearchIndex();
    loadDigestMock.mockResolvedValue(null);

    await useCatalogStore.getState().ensureShardsForQuery('gra', QUEBEC);
    await useCatalogStore.getState().ensureShardsForQuery('gran', QUEBEC);
    await useCatalogStore.getState().ensureShardsForQuery('grand', QUEBEC);

    expect(loadDigestMock).toHaveBeenCalledTimes(1);
  });

  it('fetches the digest exactly once when it succeeds', async () => {
    await loadSearchIndex();
    loadDigestMock.mockResolvedValue({ digest, fromCache: false, warnings: [] });

    await useCatalogStore.getState().ensureShardsForQuery('grand', QUEBEC);
    await useCatalogStore.getState().ensureShardsForQuery('canyon', QUEBEC);

    expect(loadDigestMock).toHaveBeenCalledTimes(1);
  });

  it('leaves the scope unstated for a query too short to constrain anything', async () => {
    await loadSearchIndex();
    loadDigestMock.mockResolvedValue({ digest, fromCache: false, warnings: [] });

    await useCatalogStore.getState().ensureShardsForQuery('g', QUEBEC);

    expect(useCatalogStore.getState().searchScope).toBe('area-only');
  });

  it('is complete by construction for a shardless (inline) catalog', async () => {
    loadManifestMock.mockResolvedValue({
      index: { ...index, shards: [], items: [quebecSheet] },
      fromCache: false,
      warnings: [],
    });
    await useCatalogStore.getState().load();

    await useCatalogStore.getState().ensureShardsForQuery('anything', QUEBEC);

    expect(useCatalogStore.getState().searchScope).toBe('complete');
    expect(loadDigestMock).not.toHaveBeenCalled();
  });

  it('reports "partial" and keeps the rest pending when a query outruns the budget', async () => {
    // Nine shards all holding a "lake": more than the six-shard fetch budget.
    const lakeShards = Array.from({ length: 9 }, (_, i) => ({
      id: `topo-lake${i}`,
      items: [{ ...item(`lake-${i}`, 'topo'), title: `Lake ${i}` }],
    }));
    const wideIndex: CatalogIndex = {
      ...index,
      shards: lakeShards.map((s, i) => shardRef(s.id, 'topo', -80 - i * 5)),
      search: { path: 'search.json' },
    };
    loadManifestMock.mockResolvedValue({ index: wideIndex, fromCache: false, warnings: [] });
    await useCatalogStore.getState().load();
    loadShardMock.mockImplementation(async (shard) => ({
      items: [{ ...item(`${shard.id}-a`, 'topo'), title: 'Lake something' }],
      fromCache: false,
      warnings: [],
    }));
    loadDigestMock.mockResolvedValue({
      digest: buildCatalogSearchDigest(lakeShards),
      fromCache: false,
      warnings: [],
    });

    await useCatalogStore.getState().ensureShardsForQuery('lake', QUEBEC);
    expect(useCatalogStore.getState().loadedShardIds).toHaveLength(6);
    expect(useCatalogStore.getState().searchScope).toBe('partial');
    expect(useCatalogStore.getState().pendingQueryShardIds).toHaveLength(3);

    // Calling again drains the rest — this is what the "search the whole
    // catalog" affordance drives.
    await useCatalogStore.getState().ensureShardsForQuery('lake', QUEBEC);
    expect(useCatalogStore.getState().searchScope).toBe('complete');
    expect(useCatalogStore.getState().pendingQueryShardIds).toEqual([]);
  });

  it('does not leave a failed shard pending forever', async () => {
    await loadSearchIndex();
    loadDigestMock.mockResolvedValue({ digest, fromCache: false, warnings: [] });
    loadShardMock.mockResolvedValue(null);

    await useCatalogStore.getState().ensureShardsForQuery('Grand Canyon', QUEBEC);

    // The shard is dead, not "still coming": the screen must stop saying it is
    // searching. Scope is complete because nothing more can be fetched.
    expect(useCatalogStore.getState().pendingQueryShardIds).toEqual([]);
    expect(useCatalogStore.getState().searchScope).toBe('complete');
  });
});
