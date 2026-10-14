import { CATALOG_INDEX_SCHEMA_VERSION } from '@core/catalog/schema';
import { loadCatalogManifest, resetCatalogIndexBaseUrl } from './catalogCache';
import { loadCatalogCollectionsRaw } from './catalogCollections';
import * as storage from './storage';

jest.mock('./storage', () => ({
  readJson: jest.fn(),
  writeJson: jest.fn(),
}));

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { extra: { catalogManifestUrl: '' } } },
}));

const readJson = storage.readJson as jest.Mock;
const writeJson = storage.writeJson as jest.Mock;

const HOST = 'https://inukshuk.mvxtechnologies.com/catalog';
const V3_COLLECTIONS = `${HOST}/v3/collections.json`;
const V2_COLLECTIONS = `${HOST}/v2/collections.json`;
const collections = [{ id: 'sepaq', name: 'Parcs Québec', places: [] }];
const ok = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const notFound = { ok: false, status: 404 } as unknown as Response;

let fetchMock: jest.Mock;

/** Route fetches by URL; anything unrouted is a network failure. */
function serve(routes: Record<string, Response>): void {
  fetchMock.mockImplementation(async (url: string) => {
    const response = routes[url];
    if (response === undefined) throw new Error(`offline: ${url}`);
    return response;
  });
}
const fetchedUrls = () => fetchMock.mock.calls.map((call: unknown[]) => call[0]);

beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  readJson.mockResolvedValue(null);
  resetCatalogIndexBaseUrl();
});

describe('loadCatalogCollectionsRaw across catalog editions (#680)', () => {
  it('reads v3 first', async () => {
    serve({ [V3_COLLECTIONS]: ok(collections) });
    expect(await loadCatalogCollectionsRaw()).toEqual(collections);
    expect(fetchedUrls()).toEqual([V3_COLLECTIONS]);
    expect(writeJson).toHaveBeenCalledWith(
      'catalog-collections.json',
      expect.objectContaining({ url: V3_COLLECTIONS }),
    );
  });

  it('falls back to v2 when v3 is missing', async () => {
    serve({ [V3_COLLECTIONS]: notFound, [V2_COLLECTIONS]: ok(collections) });
    expect(await loadCatalogCollectionsRaw()).toEqual(collections);
    expect(fetchedUrls()).toEqual([V3_COLLECTIONS, V2_COLLECTIONS]);
  });

  it('asks next to the index the store fell back to first', async () => {
    serve({
      [`${HOST}/v3/index.json`]: notFound,
      [`${HOST}/v2/index.json`]: ok({
        schemaVersion: CATALOG_INDEX_SCHEMA_VERSION,
        sources: [{ id: 's1', name: 'S', licence: 'CC-BY-4.0', attribution: 'S' }],
        shards: [{ id: 'topo-a', category: 'topo', path: 'shards/topo-a.json', itemCount: 1 }],
        categoryCounts: { topo: 1 },
      }),
      [V2_COLLECTIONS]: ok(collections),
    });
    expect(await loadCatalogManifest()).not.toBeNull();
    fetchMock.mockClear();
    expect(await loadCatalogCollectionsRaw()).toEqual(collections);
    expect(fetchedUrls()).toEqual([V2_COLLECTIONS]);
  });

  it('keeps a cached copy from either edition when both are unreachable', async () => {
    readJson.mockResolvedValue({ fetchedAt: 0, url: V2_COLLECTIONS, raw: collections });
    serve({});
    expect(await loadCatalogCollectionsRaw()).toEqual(collections);
  });

  it('ignores a cached copy from another catalog', async () => {
    readJson.mockResolvedValue({
      fetchedAt: Date.now(),
      url: 'http://127.0.0.1:8787/collections.json',
      raw: collections,
    });
    serve({});
    expect(await loadCatalogCollectionsRaw()).toBeNull();
  });
});
