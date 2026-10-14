import {
  CATALOG_INDEX_SCHEMA_VERSION,
  CATALOG_SCHEMA_VERSION,
  type CatalogShardRef,
} from '@core/catalog/schema';
import Constants from 'expo-constants';
import {
  catalogIndexBaseUrl,
  catalogIndexUrls,
  catalogManifestUrl,
  loadCatalogFacets,
  loadCatalogManifest,
  loadCatalogShard,
  resetCatalogIndexBaseUrl,
} from './catalogCache';
import * as storage from './storage';

jest.mock('./storage', () => ({
  readJson: jest.fn(),
  writeJson: jest.fn(),
}));

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { extra: { catalogManifestUrl: 'https://test.example/manifest.json' } } },
}));

const readJson = storage.readJson as jest.Mock;
const writeJson = storage.writeJson as jest.Mock;

/** Repoint the build-time catalog URL override the way an e2e/dev build does. */
function setManifestUrl(url: string): void {
  const extra = Constants.expoConfig?.extra;
  if (extra !== undefined) extra.catalogManifestUrl = url;
}

const validManifest = {
  schemaVersion: CATALOG_SCHEMA_VERSION,
  sources: [{ id: 's1', name: 'Source', licence: 'OGL-Canada-2.0', attribution: 'NRCan' }],
  items: [
    {
      id: 'cantopo-021l14',
      sourceId: 's1',
      title: 'CanTopo 021L14',
      category: 'topo',
      format: 'geopdf',
      packaging: 'zip',
      url: 'https://ftp.example/cantopo_021l14_geopdf.zip',
    },
  ],
};

const okResponse = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

let fetchMock: jest.Mock;

beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  readJson.mockResolvedValue(null);
  resetCatalogIndexBaseUrl();
});

describe('catalogManifestUrl', () => {
  it('prefers the extra override (e2e fixture builds)', () => {
    expect(catalogManifestUrl()).toBe('https://test.example/manifest.json');
  });
});

describe('loadCatalogManifest', () => {
  it('fetches, parses and persists when there is no cache', async () => {
    fetchMock.mockResolvedValue(okResponse(validManifest));
    const result = await loadCatalogManifest();
    expect(result?.fromCache).toBe(false);
    expect(result?.index.items).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://test.example/manifest.json',
      expect.objectContaining({ headers: { Accept: 'application/json' } }),
    );
    expect(writeJson).toHaveBeenCalledWith(
      'catalog.json',
      expect.objectContaining({ url: 'https://test.example/manifest.json', raw: validManifest }),
    );
  });

  it('serves a fresh cache without touching the network', async () => {
    readJson.mockResolvedValue({
      fetchedAt: Date.now() - 1000,
      url: 'https://test.example/manifest.json',
      raw: validManifest,
    });
    const result = await loadCatalogManifest();
    expect(result?.fromCache).toBe(true);
    expect(result?.index.items).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refetches past the TTL and falls back to the stale cache on failure', async () => {
    readJson.mockResolvedValue({
      fetchedAt: Date.now() - 25 * 60 * 60 * 1000, // 25 h old
      url: 'https://test.example/manifest.json',
      raw: validManifest,
    });
    fetchMock.mockRejectedValue(new Error('offline'));
    const result = await loadCatalogManifest();
    expect(fetchMock).toHaveBeenCalled();
    expect(result?.fromCache).toBe(true);
    expect(result?.index.items).toHaveLength(1);
  });

  it('force bypasses a fresh cache (pull-to-refresh)', async () => {
    readJson.mockResolvedValue({
      fetchedAt: Date.now(),
      url: 'https://test.example/manifest.json',
      raw: validManifest,
    });
    fetchMock.mockResolvedValue(okResponse(validManifest));
    const result = await loadCatalogManifest({ force: true });
    expect(fetchMock).toHaveBeenCalled();
    expect(result?.fromCache).toBe(false);
  });

  it('ignores a cache written for a different manifest URL', async () => {
    readJson.mockResolvedValue({
      fetchedAt: Date.now(),
      url: 'https://other.example/manifest.json',
      raw: validManifest,
    });
    fetchMock.mockResolvedValue(okResponse(validManifest));
    const result = await loadCatalogManifest();
    expect(fetchMock).toHaveBeenCalled();
    expect(result?.fromCache).toBe(false);
  });

  // The offline-upgrade path. The previous build cached the v1 flat manifest
  // under .../catalog/v1/manifest.json in this same cache file; this build asks
  // for .../catalog/v2/index.json. Update on wifi, drive to a trailhead, open
  // Search: the fetch fails and the v1 copy must still browse (it did before
  // this branch), not produce "Couldn't load the map catalog."
  describe('offline upgrade from a v1 cache', () => {
    const V2_URL = 'https://test.example/catalog/v2/index.json';
    beforeEach(() => setManifestUrl(V2_URL));
    afterEach(() => setManifestUrl('https://test.example/manifest.json'));

    const v1Cached = {
      fetchedAt: Date.now() - 60 * 1000, // fresh, but written for the OLD url
      url: 'https://test.example/catalog/v1/manifest.json',
      raw: validManifest,
    };

    it('falls back to the superseded v1 copy when the network fails', async () => {
      readJson.mockResolvedValue(v1Cached);
      fetchMock.mockRejectedValue(new Error('offline'));
      const result = await loadCatalogManifest();
      expect(fetchMock).toHaveBeenCalledWith(
        'https://test.example/catalog/v2/index.json',
        expect.anything(),
      );
      expect(result).not.toBeNull();
      expect(result?.fromCache).toBe(true);
      // Adapted by the v1 branch of parseCatalogIndex: items inline, no shards.
      expect(result?.index.items).toHaveLength(1);
      expect(result?.index.shards).toEqual([]);
    });

    it('prefers the network and migrates the cache entry to the v2 URL', async () => {
      readJson.mockResolvedValue(v1Cached);
      const v2Index = {
        schemaVersion: CATALOG_INDEX_SCHEMA_VERSION,
        sources: validManifest.sources,
        shards: [
          {
            id: 'topo-n40w080',
            category: 'topo',
            path: 'shards/topo-n40w080.json',
            itemCount: 5,
            bbox: [-80, 40, -70, 50],
          },
        ],
        categoryCounts: { topo: 5 },
      };
      fetchMock.mockResolvedValue(okResponse(v2Index));
      const result = await loadCatalogManifest();
      expect(result?.fromCache).toBe(false);
      expect(result?.index.shards).toHaveLength(1);
      // Same cache file, now stamped with the v2 URL — the v1 copy is gone, so
      // the fallback above happens at most once per upgrade.
      expect(writeJson).toHaveBeenCalledWith(
        'catalog.json',
        expect.objectContaining({ url: 'https://test.example/catalog/v2/index.json' }),
      );
    });

    it('never falls back to a copy from another origin (dev / e2e override)', async () => {
      readJson.mockResolvedValue({ ...v1Cached, url: 'http://127.0.0.1:8787/index.json' });
      fetchMock.mockRejectedValue(new Error('offline'));
      expect(await loadCatalogManifest()).toBeNull();
    });

    it('does not serve a superseded copy while the network is fine', async () => {
      readJson.mockResolvedValue(v1Cached);
      fetchMock.mockResolvedValue(okResponse(validManifest));
      const result = await loadCatalogManifest();
      expect(fetchMock).toHaveBeenCalled();
      expect(result?.fromCache).toBe(false);
    });
  });

  it('treats an unusable remote manifest as a failure (cache fallback)', async () => {
    readJson.mockResolvedValue({
      fetchedAt: Date.now() - 25 * 60 * 60 * 1000,
      url: 'https://test.example/manifest.json',
      raw: validManifest,
    });
    fetchMock.mockResolvedValue(okResponse({ schemaVersion: 99 }));
    const result = await loadCatalogManifest();
    expect(result?.fromCache).toBe(true);
    expect(writeJson).not.toHaveBeenCalled(); // the bad payload is never cached
  });

  it('treats an HTTP error as a failure', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 } as unknown as Response);
    expect(await loadCatalogManifest()).toBeNull();
  });

  it('returns null when offline with no cache (first launch)', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    expect(await loadCatalogManifest()).toBeNull();
  });

  it('survives a corrupt cache document', async () => {
    readJson.mockResolvedValue({ totally: 'wrong' });
    fetchMock.mockResolvedValue(okResponse(validManifest));
    const result = await loadCatalogManifest();
    expect(result?.fromCache).toBe(false);
  });

  it('accepts a v2 index and exposes its shard directory', async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        schemaVersion: CATALOG_INDEX_SCHEMA_VERSION,
        sources: validManifest.sources,
        shards: [
          {
            id: 'topo-n40w080',
            category: 'topo',
            path: 'shards/topo-n40w080.json',
            itemCount: 128,
            bbox: [-80, 40, -70, 50],
          },
        ],
        categoryCounts: { topo: 128 },
      }),
    );
    const result = await loadCatalogManifest();
    expect(result?.index.shards).toHaveLength(1);
    expect(result?.index.items).toEqual([]);
    expect(result?.index.categoryCounts.topo).toBe(128);
  });
});

describe('loadCatalogShard', () => {
  const shard: CatalogShardRef = {
    id: 'topo-n40w080',
    category: 'topo',
    path: 'shards/topo-n40w080.json',
    itemCount: 1,
  };
  const sourceIds = new Set(['s1']);
  const body = { id: 'topo-n40w080', items: validManifest.items };

  it('resolves the shard URL relative to the index and caches under its id', async () => {
    fetchMock.mockResolvedValue(okResponse(body));
    const result = await loadCatalogShard(shard, sourceIds);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://test.example/shards/topo-n40w080.json',
      expect.objectContaining({ headers: { Accept: 'application/json' } }),
    );
    expect(result?.items).toHaveLength(1);
    expect(result?.fromCache).toBe(false);
    expect(writeJson).toHaveBeenCalledWith(
      'catalog-shard-topo-n40w080.json',
      expect.objectContaining({ url: 'https://test.example/shards/topo-n40w080.json' }),
    );
  });

  it('serves a cached shard without touching the network (offline browsing)', async () => {
    readJson.mockResolvedValue({
      fetchedAt: Date.now() - 1000,
      url: 'https://test.example/shards/topo-n40w080.json',
      raw: body,
    });
    const result = await loadCatalogShard(shard, sourceIds);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result?.fromCache).toBe(true);
  });

  it('falls back to a stale cached shard when the network fails', async () => {
    readJson.mockResolvedValue({
      fetchedAt: Date.now() - 8 * 24 * 60 * 60 * 1000, // past the 7-day shard TTL
      url: 'https://test.example/shards/topo-n40w080.json',
      raw: body,
    });
    fetchMock.mockRejectedValue(new Error('offline'));
    const result = await loadCatalogShard(shard, sourceIds);
    expect(fetchMock).toHaveBeenCalled();
    expect(result?.fromCache).toBe(true);
    expect(result?.items).toHaveLength(1);
  });

  it('drops rows whose source the index never declared', async () => {
    fetchMock.mockResolvedValue(okResponse(body));
    const result = await loadCatalogShard(shard, new Set(['someone-else']));
    // Every row was rejected ⇒ nothing usable, and nothing cached.
    expect(result).toBeNull();
    expect(writeJson).not.toHaveBeenCalled();
  });

  it('returns null (not an error) when the shard is unreachable and uncached', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    expect(await loadCatalogShard(shard, sourceIds)).toBeNull();
  });

  it('refuses a shard path that would leave the catalog directory', async () => {
    expect(await loadCatalogShard({ ...shard, path: '../../secrets.json' }, sourceIds)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('loadCatalogFacets (#474)', () => {
  const ref = { path: 'facets.json', byteSize: 100 };
  const body = {
    schemaVersion: 1,
    shards: { 'topo-n40w080': { kinds: { topo: 3 }, activities: { hiking: 2 } } },
  };

  it('fetches, parses and caches the per-shard digest', async () => {
    fetchMock.mockResolvedValue(okResponse(body));
    const result = await loadCatalogFacets(ref);
    expect(fetchMock).toHaveBeenCalledWith('https://test.example/facets.json', expect.anything());
    expect(result?.facets.shards['topo-n40w080']?.activities).toEqual({ hiking: 2 });
    expect(writeJson).toHaveBeenCalledWith(
      'catalog-facets.json',
      expect.objectContaining({ url: 'https://test.example/facets.json' }),
    );
  });

  it('serves a fresh cache offline and falls back to a stale one', async () => {
    readJson.mockResolvedValue({
      fetchedAt: Date.now() - 1000,
      url: 'https://test.example/facets.json',
      raw: body,
    });
    expect((await loadCatalogFacets(ref))?.fromCache).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();

    readJson.mockResolvedValue({
      fetchedAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
      url: 'https://test.example/facets.json',
      raw: body,
    });
    fetchMock.mockRejectedValue(new Error('offline'));
    expect((await loadCatalogFacets(ref))?.fromCache).toBe(true);
  });

  it('returns null when unusable and uncached', async () => {
    fetchMock.mockResolvedValue(okResponse({ schemaVersion: 99, shards: {} }));
    expect(await loadCatalogFacets(ref)).toBeNull();
  });
});

// #680: 2.5.2 reads the credited edition (v3), which shares v2's unchanged
// shards through `../v2/` paths. Apps before 2.5.2 keep reading v2 and never
// see Cartes Plein-air. A missing or broken v3 must leave the store working on
// v2, never empty.
describe('catalog editions: v3 first, v2 as the fallback', () => {
  const V3 = 'https://inukshuk.mvxtechnologies.com/catalog/v3/index.json';
  const V2 = 'https://inukshuk.mvxtechnologies.com/catalog/v2/index.json';
  const HOST = 'https://inukshuk.mvxtechnologies.com/catalog';
  beforeEach(() => setManifestUrl(''));
  afterEach(() => setManifestUrl('https://test.example/manifest.json'));

  const shardRef = (id: string, path: string) => ({
    id,
    category: id.split('-')[0] ?? 'topo',
    path,
    itemCount: 1,
    bbox: [-80, 40, -70, 50],
  });
  const v3Index = {
    schemaVersion: CATALOG_INDEX_SCHEMA_VERSION,
    sources: validManifest.sources,
    shards: [
      shardRef('topo-n40w080', '../v2/shards/topo-n40w080.json'),
      shardRef('river-n40w080', 'shards/river-n40w080.json'),
    ],
    categoryCounts: { topo: 1, river: 1 },
  };
  const v2Index = {
    ...v3Index,
    shards: [shardRef('topo-n40w080', 'shards/topo-n40w080.json')],
    categoryCounts: { topo: 1 },
  };
  const notFound = { ok: false, status: 404 } as unknown as Response;
  const shardBody = { id: 'topo-n40w080', items: validManifest.items };
  const sourceIds = new Set(['s1']);

  /** Route fetches by URL; anything unrouted is a network failure. */
  function serve(routes: Record<string, Response>): void {
    fetchMock.mockImplementation(async (url: string) => {
      const response = routes[url];
      if (response === undefined) throw new Error(`offline: ${url}`);
      return response;
    });
  }
  const fetchedUrls = () => fetchMock.mock.calls.map((call: unknown[]) => call[0]);

  it('tries v3, then v2, and only those (no override)', () => {
    expect(catalogIndexUrls()).toEqual([V3, V2]);
  });

  it('an override (e2e fixture) is the only candidate: never production v2', async () => {
    setManifestUrl('http://127.0.0.1:8787/index.json');
    expect(catalogIndexUrls()).toEqual(['http://127.0.0.1:8787/index.json']);
    serve({});
    expect(await loadCatalogManifest()).toBeNull();
    expect(fetchedUrls()).toEqual(['http://127.0.0.1:8787/index.json']);
  });

  it('loads v3 and resolves shared shards to the very URL v2 uses (one cache entry)', async () => {
    serve({
      [V3]: okResponse(v3Index),
      [`${HOST}/v2/shards/topo-n40w080.json`]: okResponse(shardBody),
    });
    const result = await loadCatalogManifest();
    expect(result?.index.shards.map((s) => s.id)).toEqual(['topo-n40w080', 'river-n40w080']);
    expect(fetchedUrls()).toEqual([V3]);
    expect(catalogIndexBaseUrl()).toBe(V3);

    const shared = result?.index.shards[0];
    if (shared === undefined) throw new Error('no shard');
    expect((await loadCatalogShard(shared, sourceIds))?.items).toHaveLength(1);
    expect(fetchedUrls()[1]).toBe(`${HOST}/v2/shards/topo-n40w080.json`);
    expect(writeJson).toHaveBeenCalledWith(
      'catalog-shard-topo-n40w080.json',
      expect.objectContaining({ url: `${HOST}/v2/shards/topo-n40w080.json` }),
    );
  });

  it('resolves a v3-only shard under v3', async () => {
    serve({ [V3]: okResponse(v3Index), [`${HOST}/v3/shards/river-n40w080.json`]: notFound });
    const result = await loadCatalogManifest();
    const river = result?.index.shards[1];
    if (river === undefined) throw new Error('no shard');
    await loadCatalogShard(river, sourceIds);
    expect(fetchedUrls()[1]).toBe(`${HOST}/v3/shards/river-n40w080.json`);
  });

  it.each([
    ['missing (404)', notFound],
    ['unparseable', okResponse({ schemaVersion: 99 })],
  ])('falls back to v2 when v3 is %s, and resolves against v2', async (_label, v3Response) => {
    serve({
      [V3]: v3Response,
      [V2]: okResponse(v2Index),
      [`${HOST}/v2/shards/topo-n40w080.json`]: okResponse(shardBody),
    });
    const result = await loadCatalogManifest();
    expect(result?.fromCache).toBe(false);
    expect(result?.index.shards.map((s) => s.id)).toEqual(['topo-n40w080']);
    expect(fetchedUrls()).toEqual([V3, V2]);
    expect(catalogIndexBaseUrl()).toBe(V2);
    expect(writeJson).toHaveBeenCalledWith('catalog.json', expect.objectContaining({ url: V2 }));

    const shard = result?.index.shards[0];
    if (shard === undefined) throw new Error('no shard');
    expect((await loadCatalogShard(shard, sourceIds))?.items).toHaveLength(1);
    expect(fetchedUrls()[2]).toBe(`${HOST}/v2/shards/topo-n40w080.json`);
  });

  it('retries v3 even when a fresh v2 copy is cached (v3 deployed since)', async () => {
    readJson.mockResolvedValue({ fetchedAt: Date.now() - 1000, url: V2, raw: v2Index });
    serve({ [V3]: okResponse(v3Index) });
    const result = await loadCatalogManifest();
    expect(result?.fromCache).toBe(false);
    expect(result?.index.shards).toHaveLength(2);
    expect(catalogIndexBaseUrl()).toBe(V3);
  });

  it('serves a fresh v3 copy without touching the network', async () => {
    readJson.mockResolvedValue({ fetchedAt: Date.now() - 1000, url: V3, raw: v3Index });
    const result = await loadCatalogManifest();
    expect(result?.fromCache).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(catalogIndexBaseUrl()).toBe(V3);
  });

  it('offline right after the update: the v2 copy 2.5.1 cached still browses, against v2', async () => {
    readJson.mockResolvedValue({ fetchedAt: Date.now() - 60_000, url: V2, raw: v2Index });
    serve({});
    const result = await loadCatalogManifest();
    expect(result?.fromCache).toBe(true);
    expect(result?.index.shards.map((s) => s.path)).toEqual(['shards/topo-n40w080.json']);
    expect(fetchedUrls()).toEqual([V3, V2]);
    expect(catalogIndexBaseUrl()).toBe(V2);
  });

  it('returns null when neither edition is reachable and nothing is cached', async () => {
    serve({ [V3]: notFound, [V2]: notFound });
    expect(await loadCatalogManifest()).toBeNull();
    expect(catalogIndexBaseUrl()).toBe(V3);
  });
});
