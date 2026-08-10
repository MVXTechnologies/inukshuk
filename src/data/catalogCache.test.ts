import {
  CATALOG_INDEX_SCHEMA_VERSION,
  CATALOG_SCHEMA_VERSION,
  type CatalogShardRef,
} from '@core/catalog/schema';
import { catalogManifestUrl, loadCatalogManifest, loadCatalogShard } from './catalogCache';
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
