import { act, renderHook } from '@testing-library/react-native';

import { DEFAULT_GEODETIC_URL } from '@data/basemapTiles';
import type { OfflineRegion } from '@data/offline';
import { useOfflineStore } from '@state/offlineStore';
import { DEFAULT_TILE_URL, useSettingsStore } from '@state/settingsStore';

import {
  currentPackUrls,
  nextStaleNotice,
  regionNeedsUpdate,
  regionUpdateLayer,
  staleMapCount,
  staleRegionUrls,
  staleUpdateGroup,
  useOfflinePackHealth,
  useOfflinePackHealthNotice,
} from './offlinePackHealth';

jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }));
// The store's native-pack layer; these tests drive the store's state directly.
jest.mock('@data/offline', () => ({ OfflineConnectivityError: class extends Error {} }));
// The notice's persisted record of what it already announced, in memory.
const mockAnnounced: string[] = [];
jest.mock('@data/packHealthNotice', () => ({
  readAnnouncedStale: jest.fn(async () => [...mockAnnounced]),
  saveAnnouncedStale: jest.fn(async (ids: string[]) => {
    mockAnnounced.splice(0, mockAnnounced.length, ...ids);
  }),
}));

const region = (id: string, extra: Partial<OfflineRegion> = {}): OfflineRegion => ({
  id,
  packId: `native-${id}`,
  label: id,
  basemap: 'map',
  bounds: { minLng: -71.3, minLat: 46.8, maxLng: -71.1, maxLat: 46.9 },
  sizeBytes: 10,
  complete: true,
  format: 'vector',
  maxZoom: 14,
  ...extra,
});

/** A vector map pack recorded with today's templates, but an older geodetic schema. */
function withOldGeodetic(r: OfflineRegion): OfflineRegion {
  const urls = currentPackUrls(DEFAULT_TILE_URL, r) ?? {};
  return { ...r, urls: { ...urls, 'source:geodetic': DEFAULT_GEODETIC_URL.replace('v=2', 'v=1') } };
}

const stampUrls = jest.fn(async () => undefined);

beforeEach(() => {
  stampUrls.mockClear();
  useOfflineStore.setState({ regions: [], progress: null, stampUrls });
  useSettingsStore.setState({ hydrated: true, tileUrl: DEFAULT_TILE_URL });
});

describe('currentPackUrls / staleRegionUrls', () => {
  it("is today's full template set for the pack's kind, none for retired relief", () => {
    const urls = currentPackUrls(DEFAULT_TILE_URL, region('a'));
    expect(urls?.['source:geodetic']).toBe(DEFAULT_GEODETIC_URL);
    expect(urls?.['source:basemap-vector']).toMatch(/\/basemap\//);
    expect(currentPackUrls(DEFAULT_TILE_URL, region('r', { basemap: 'relief' }))).toBeNull();
  });

  it('names the templates that moved, and nothing for a healthy or unrecorded pack', () => {
    const healthy = region('h');
    expect(staleRegionUrls(DEFAULT_TILE_URL, healthy)).toEqual([]);
    expect(
      staleRegionUrls(DEFAULT_TILE_URL, {
        ...healthy,
        urls: currentPackUrls(DEFAULT_TILE_URL, healthy) ?? {},
      }),
    ).toEqual([]);
    expect(staleRegionUrls(DEFAULT_TILE_URL, withOldGeodetic(healthy))).toEqual([
      'source:geodetic',
    ]);
    expect(
      staleRegionUrls(DEFAULT_TILE_URL, { ...region('r', { basemap: 'relief' }), urls: {} }),
    ).toEqual([]);
  });

  it("flags a raster map pack once the user's tile setting moved", () => {
    const raster = region('o', { format: 'raster' });
    const recorded = { ...raster, urls: currentPackUrls(DEFAULT_TILE_URL, raster) ?? {} };
    expect(staleRegionUrls('https://tiles.example/{z}/{x}/{y}.png', recorded)).toEqual([
      'source:osm',
    ]);
  });
});

describe('regionNeedsUpdate', () => {
  it('covers moved templates and raster packs of the vector map', () => {
    expect(regionNeedsUpdate(DEFAULT_TILE_URL, withOldGeodetic(region('a')))).toBe(true);
    expect(regionNeedsUpdate(DEFAULT_TILE_URL, region('b'))).toBe(false);
    expect(
      regionNeedsUpdate(DEFAULT_TILE_URL, region('c', { format: 'raster', urls: undefined })),
    ).toBe(true);
  });
});

describe('regionUpdateLayer', () => {
  it("re-downloads with today's style, the same base map and quality", () => {
    const layer = regionUpdateLayer(DEFAULT_TILE_URL, region('a', { maxZoom: 15 }));
    expect(layer).toMatchObject({ basemap: 'map', format: 'vector', maxZoom: 15 });
    expect(layer?.minZoom).toBeLessThanOrEqual(15);
    expect(JSON.parse(layer?.styleJSON ?? '{}')).toHaveProperty('sources');
  });

  it('falls back to the shallowest quality, keeps satellite raster, skips relief', () => {
    const sat = regionUpdateLayer(
      DEFAULT_TILE_URL,
      region('s', { basemap: 'satellite', format: 'raster', maxZoom: undefined }),
    );
    expect(sat).toMatchObject({ basemap: 'satellite', format: 'raster', maxZoom: 15 });
    expect(regionUpdateLayer(DEFAULT_TILE_URL, region('r', { basemap: 'relief' }))).toBeNull();
  });
});

describe('useOfflinePackHealth', () => {
  it('lists the complete regions needing an update', async () => {
    useOfflineStore.setState({
      regions: [
        withOldGeodetic(region('stale')),
        { ...withOldGeodetic(region('partial')), complete: false },
        { ...region('fine'), urls: currentPackUrls(DEFAULT_TILE_URL, region('fine')) ?? {} },
      ],
    });
    const { result } = await renderHook(() => useOfflinePackHealth());
    expect([...result.current]).toEqual(['stale']);
  });

  it("stamps complete unrecorded packs with today's templates, once settings are in", async () => {
    useSettingsStore.setState({ hydrated: false });
    useOfflineStore.setState({
      regions: [
        region('legacy'),
        { ...region('busy'), complete: false },
        region('old', { basemap: 'relief' }),
      ],
    });
    const { result } = await renderHook(() => useOfflinePackHealth());
    expect(result.current.size).toBe(0);
    expect(stampUrls).not.toHaveBeenCalled();

    await act(async () => {
      useSettingsStore.setState({ hydrated: true });
    });
    expect(stampUrls).toHaveBeenCalledTimes(1);
    expect(stampUrls).toHaveBeenCalledWith({
      legacy: currentPackUrls(DEFAULT_TILE_URL, region('legacy'), 'none'),
    });
  });

  it('stamps only the base layer: a legacy pack may hold no extension tiles at all', async () => {
    useOfflineStore.setState({ regions: [region('legacy')] });
    await renderHook(() => useOfflinePackHealth());
    const stamped = (stampUrls.mock.calls[0] as unknown as [Record<string, object>])[0].legacy;
    expect(stamped).toHaveProperty(['source:basemap-vector']);
    expect(stamped).not.toHaveProperty(['source:geodetic']);
    expect(stamped).not.toHaveProperty(['source:tides']);
  });
});

describe('staleUpdateGroup / staleMapCount', () => {
  const parts = [
    withOldGeodetic(region('trail-t-s1-1')),
    region('trail-t-s1-2'),
    withOldGeodetic(region('trail-t-s1-3')),
    withOldGeodetic(region('trail-t-s2-1')),
    withOldGeodetic(region('a')),
  ];
  const stale = new Set(['trail-t-s1-1', 'trail-t-s1-3', 'trail-t-s2-1', 'a']);

  it("updates a trail download's stale parts together, anything else alone", () => {
    const first = parts[0] as OfflineRegion;
    const last = parts[4] as OfflineRegion;
    expect(staleUpdateGroup(first, parts, stale).map((r) => r.id)).toEqual([
      'trail-t-s1-1',
      'trail-t-s1-3',
    ]);
    expect(staleUpdateGroup(last, parts, stale).map((r) => r.id)).toEqual(['a']);
  });

  it('counts offline maps, not packs', () => {
    expect(staleMapCount(stale)).toBe(3);
    expect(staleMapCount(new Set())).toBe(0);
  });
});

describe('nextStaleNotice', () => {
  it('speaks only when the stale list grows, and records the list as it is', () => {
    expect(nextStaleNotice([], ['a'])).toEqual({ announce: true, save: ['a'] });
    expect(nextStaleNotice(['a'], ['a'])).toEqual({ announce: false, save: null });
    expect(nextStaleNotice(['a', 'b'], ['a'])).toEqual({ announce: false, save: ['a'] });
    expect(nextStaleNotice(['a'], ['a', 'b'])).toEqual({ announce: true, save: ['a', 'b'] });
    expect(nextStaleNotice(['a'], [])).toEqual({ announce: false, save: [] });
  });
});

describe('useOfflinePackHealthNotice', () => {
  beforeEach(() => {
    mockAnnounced.length = 0;
    useOfflineStore.setState({ hydrated: true });
  });

  it("tells the user, counting a trail download's parts as one map", async () => {
    useOfflineStore.setState({
      regions: [
        withOldGeodetic(region('a')),
        withOldGeodetic(region('trail-t-s1-1')),
        withOldGeodetic(region('trail-t-s1-2')),
      ],
    });
    const { result } = await renderHook(() => useOfflinePackHealthNotice());
    expect(result.current.message).toBe('2 offline maps need updating');
    expect(mockAnnounced).toEqual(['a', 'trail-t-s1-']);
  });

  it('stays quiet on the next cold start, and speaks again only when the list grows', async () => {
    useOfflineStore.setState({ regions: [withOldGeodetic(region('a'))] });
    const first = await renderHook(() => useOfflinePackHealthNotice());
    expect(first.result.current.message).toBe('An offline map needs updating');
    await first.unmount();

    // A cold start: a fresh hook, the same persisted record.
    const second = await renderHook(() => useOfflinePackHealthNotice());
    expect(second.result.current.message).toBeNull();

    await act(async () => {
      useOfflineStore.setState({
        regions: [withOldGeodetic(region('a')), withOldGeodetic(region('b'))],
      });
    });
    expect(second.result.current.message).toBe('2 offline maps need updating');
  });

  it('says nothing when all is well, and judges nothing before the regions load', async () => {
    mockAnnounced.push('a');
    useOfflineStore.setState({ hydrated: false, regions: [] });
    const { result } = await renderHook(() => useOfflinePackHealthNotice());
    expect(result.current.message).toBeNull();
    // Not loaded yet is not "all fixed": the record survives.
    expect(mockAnnounced).toEqual(['a']);

    await act(async () => {
      useOfflineStore.setState({ hydrated: true });
    });
    expect(result.current.message).toBeNull();
    expect(mockAnnounced).toEqual([]);
  });
});
