import { CATALOG_SCHEMA_VERSION } from '@core/catalog/schema';
import { catalogManifestUrl, loadCatalogManifest } from './catalogCache';
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
  sources: [
    { id: 's1', name: 'Source', licence: 'OGL-Canada-2.0', attribution: 'NRCan' },
  ],
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
    expect(result?.manifest.items).toHaveLength(1);
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
    expect(result?.manifest.items).toHaveLength(1);
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
    expect(result?.manifest.items).toHaveLength(1);
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
});
