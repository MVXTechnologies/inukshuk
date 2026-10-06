import {
  listRegionPacks,
  readPackStyleTemplates,
  replaceRegionPack,
  OfflineConnectivityError,
  type OfflineRegion,
} from '@data/offline';
import { deletePackUrls, readPackUrls, savePackUrls } from '@data/packUrls';
import { reportError } from '@lib/errorReporting';

import { useOfflineStore } from './offlineStore';

jest.mock('@data/offline', () => {
  class OfflineConnectivityError extends Error {}
  return {
    OfflineConnectivityError,
    createRegionPack: jest.fn(),
    deleteRegionPack: jest.fn(async () => undefined),
    listRegionPacks: jest.fn(async () => []),
    readPackStyleTemplates: jest.fn(async () => null),
    replaceRegionPack: jest.fn(async () => undefined),
    setTileLimit: jest.fn(),
  };
});
jest.mock('@data/packUrls', () => ({
  deletePackUrls: jest.fn(async () => undefined),
  readPackUrls: jest.fn(async () => ({})),
  savePackUrls: jest.fn(async () => undefined),
}));
jest.mock('@data/regionNames', () => ({
  deleteRegionName: jest.fn(async () => undefined),
  readRegionNames: jest.fn(async () => ({})),
  saveRegionNames: jest.fn(async () => undefined),
}));
jest.mock('@lib/errorReporting', () => ({ reportError: jest.fn() }));

const region = (id: string, extra: Partial<OfflineRegion> = {}): OfflineRegion => ({
  id,
  packId: `native-${id}`,
  label: id,
  basemap: 'map',
  bounds: { minLng: -72, minLat: 46, maxLng: -71, maxLat: 47 },
  sizeBytes: 10,
  complete: true,
  format: 'vector',
  ...extra,
});

const OLD = { 'source:base': 'https://t.example/{z}/{x}/{y}.mvt?v=1' };
const STAMPED = { 'source:base': 'https://t.example/{z}/{x}/{y}.mvt?v=0' };

beforeEach(() => {
  jest.clearAllMocks();
  useOfflineStore.setState({ regions: [], progress: null });
});

describe('hydrate: the URL-template migration', () => {
  it("keeps a pack's own record, else its stamp, else stamps it from its saved style", async () => {
    (listRegionPacks as jest.Mock).mockResolvedValueOnce([
      region('recorded', { urls: OLD }),
      region('stamped'),
      region('legacy'),
      region('unknown'),
    ]);
    (readPackUrls as jest.Mock).mockResolvedValueOnce({ stamped: STAMPED, recorded: STAMPED });
    (readPackStyleTemplates as jest.Mock).mockImplementation(async (id: string) =>
      id === 'legacy' ? OLD : null,
    );

    await useOfflineStore.getState().hydrate();

    const byId = Object.fromEntries(useOfflineStore.getState().regions.map((r) => [r.id, r.urls]));
    expect(byId).toEqual({ recorded: OLD, stamped: STAMPED, legacy: OLD, unknown: undefined });
    // Only the newly-read legacy pack is written back; the others already had theirs.
    expect(savePackUrls).toHaveBeenCalledTimes(1);
    expect(savePackUrls).toHaveBeenCalledWith({ legacy: OLD });
    expect(readPackStyleTemplates).not.toHaveBeenCalledWith('recorded');
    expect(readPackStyleTemplates).not.toHaveBeenCalledWith('stamped');
  });

  it('writes nothing when every pack already has templates', async () => {
    (listRegionPacks as jest.Mock).mockResolvedValueOnce([region('a', { urls: OLD })]);
    await useOfflineStore.getState().hydrate();
    expect(savePackUrls).not.toHaveBeenCalled();
  });
});

describe('stampUrls', () => {
  it('persists the stamps and applies them to unrecorded regions only', async () => {
    useOfflineStore.setState({ regions: [region('a'), region('b', { urls: OLD })] });
    await useOfflineStore.getState().stampUrls({ a: STAMPED, b: STAMPED });
    expect(savePackUrls).toHaveBeenCalledWith({ a: STAMPED, b: STAMPED });
    expect(useOfflineStore.getState().regions.map((r) => r.urls)).toEqual([STAMPED, OLD]);
  });

  it('is a no-op for no stamps', async () => {
    await useOfflineStore.getState().stampUrls({});
    expect(savePackUrls).not.toHaveBeenCalled();
  });
});

describe('redownload', () => {
  const layer = {
    basemap: 'map' as const,
    format: 'vector' as const,
    styleJSON: '{}',
    minZoom: 8,
    maxZoom: 14,
  };

  it('replaces the pack under the same id, then drops its legacy stamp', async () => {
    const r = region('r', { label: 'Charlevoix', maxZoom: 14 });
    (replaceRegionPack as jest.Mock).mockImplementationOnce(
      async (_old: string, _args: unknown, onProgress: (p: number, b: number) => void) => {
        onProgress(50, 5);
        expect(useOfflineStore.getState().progress).toEqual({
          pct: 50,
          sizeBytes: 5,
          label: 'Updating Charlevoix',
        });
      },
    );
    await useOfflineStore.getState().redownload(r, layer);
    expect(replaceRegionPack).toHaveBeenCalledWith(
      'native-r',
      expect.objectContaining({ id: 'r', label: 'Charlevoix', basemap: 'map', format: 'vector' }),
      expect.any(Function),
    );
    expect(deletePackUrls).toHaveBeenCalledWith('r');
    expect(useOfflineStore.getState().progress).toBeNull();
    expect(listRegionPacks).toHaveBeenCalled();
  });

  it('reports an app failure, not a connectivity one, and rethrows both', async () => {
    (replaceRegionPack as jest.Mock).mockRejectedValueOnce(new Error('bad style'));
    await expect(useOfflineStore.getState().redownload(region('r'), layer)).rejects.toThrow(
      'bad style',
    );
    expect(reportError).toHaveBeenCalledTimes(1);

    (replaceRegionPack as jest.Mock).mockRejectedValueOnce(new OfflineConnectivityError('offline'));
    await expect(useOfflineStore.getState().redownload(region('r'), layer)).rejects.toThrow(
      'offline',
    );
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(deletePackUrls).not.toHaveBeenCalled();
    expect(useOfflineStore.getState().progress).toBeNull();
  });
});

it('remove drops the region, its name and its stamp', async () => {
  useOfflineStore.setState({ regions: [region('a'), region('b')] });
  await useOfflineStore.getState().remove('a');
  expect(deletePackUrls).toHaveBeenCalledWith('a');
  expect(useOfflineStore.getState().regions.map((r) => r.id)).toEqual(['b']);
});
