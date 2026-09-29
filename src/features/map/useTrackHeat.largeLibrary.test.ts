/**
 * Regression guards for a large library (#465): ~400 Strava-sized trails on
 * the map. These fail if loading goes back to one rebuild per trail, if a
 * source loses its identity on an unrelated re-render, if full-resolution
 * geometry reaches a source, or if the heat path runs while it is off.
 * Time ceilings are deliberately generous (CI machines vary); the counts are
 * the real contract. The detailed numbers live in `largeLibrary.bench.test.ts`.
 */
import { buildGpx } from '@core/geo/gpx';
import { simplifyTrack } from '@core/geo/track/simplify';
import { largeLibrary } from '@core/heat/__fixtures__/quebecLibrary';
import * as storage from '@data/storage';
import { clearTrackGeometryMemory, peekTrackGeometry, trackGeometryKey } from '@data/trackGeometry';
import { act, renderHook } from '@testing-library/react-native';

import { useTrackHeat } from './useTrackHeat';
import { useTrackOverlays } from './useTrackOverlays';

const mockLib = largeLibrary(400, { stepSec: 10 });
const mockIndexOf = (s: string) => Number(/trk-(\d+)/.exec(s)?.[1] ?? -1);
const mockCacheFiles = new Map<string, string>();

jest.mock('@data/storage', () => ({
  readFileText: jest.fn(async (uri: string) => {
    const i = mockIndexOf(uri);
    return mockBuildGpx({
      points: mockLib.points(i),
      segmentStarts: mockLib.segmentStarts(i),
      metadata: {},
    });
  }),
  readTrackGeometryCache: jest.fn(async (id: string) => mockCacheFiles.get(id) ?? null),
  writeTrackGeometryCache: jest.fn((id: string, text: string) => {
    mockCacheFiles.set(id, text);
  }),
}));
const mockBuildGpx = buildGpx;

const mockIndexBuilds = jest.fn();
const mockGridBuilds = jest.fn();
jest.mock('@core/heat/heatGrid', () => {
  const actual = jest.requireActual('@core/heat/heatGrid');
  return {
    ...actual,
    buildGridIndex: (...args: unknown[]) => {
      mockIndexBuilds();
      return actual.buildGridIndex(...args);
    },
    buildHeatGrid: (...args: unknown[]) => {
      mockGridBuilds();
      return actual.buildHeatGrid(...args);
    },
  };
});

const tracks = mockLib.tracks;
const ids = tracks.map((t) => t.id);
const N = tracks.length;
const rawPoints = tracks.reduce((s, t) => s + t.stats.pointCount, 0);

/** Pretend a previous launch cached every trail's simplified geometry. */
function warmCache(count = N) {
  for (let i = 0; i < count; i++) {
    const t = tracks[i]!;
    const g = simplifyTrack(mockLib.points(i), mockLib.segmentStarts(i));
    mockCacheFiles.set(t.id, JSON.stringify({ key: trackGeometryKey(t), parts: g.parts }));
  }
}

async function waitUntil(done: () => boolean, maxMs = 60_000) {
  const start = Date.now();
  while (!done()) {
    if (Date.now() - start > maxMs) throw new Error('timed out');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
  // Let the final batch flush and its renders settle.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

const allLoaded = (list = tracks) => list.every((t) => peekTrackGeometry(t) !== undefined);

beforeAll(() => warmCache());

beforeEach(() => {
  clearTrackGeometryMemory();
  mockIndexBuilds.mockClear();
  mockGridBuilds.mockClear();
});

jest.setTimeout(60_000);

describe('useTrackHeat with 400 trails', () => {
  it('loads the whole library with a bounded number of rebuilds (not one per trail)', async () => {
    let renders = 0;
    const t0 = Date.now();
    const { result } = await renderHook(() => {
      renders++;
      return useTrackHeat(tracks, [], ids, true);
    });
    await waitUntil(() => allLoaded());
    const ms = Date.now() - t0;

    // Batches grow geometrically: ~log2(400) + a couple, never ~400.
    expect(mockGridBuilds.mock.calls.length).toBeLessThanOrEqual(12);
    expect(renders).toBeLessThanOrEqual(14);
    // The warm path never touches a GPX file.
    expect(storage.readFileText).not.toHaveBeenCalled();
    // Generous CI ceiling for 400 trails (≈1 s locally; the O(n²) version took minutes).
    expect(ms).toBeLessThan(15_000);

    const { heatLines, heatGlow } = result.current;
    expect(heatLines).not.toBeNull();
    // Bounded by ground covered, not by fixes: 1 feature per pass bucket and
    // far fewer vertices than the library's raw points.
    expect(heatLines!.features.length).toBeLessThanOrEqual(8);
    const heatVertices = heatLines!.features.reduce(
      (s, f) => s + f.geometry.coordinates.reduce((a, l) => a + l.length, 0),
      0,
    );
    expect(heatVertices).toBeLessThan(rawPoints / 3);
    expect(heatGlow!.features.length).toBeGreaterThan(0);
    expect(heatGlow!.features.length).toBeLessThan(20_000);
  });

  it('keeps every source and callback identity across an unrelated re-render', async () => {
    const { result, rerender } = await renderHook(
      ({ shown }: { shown: string[] }) => useTrackHeat(tracks, shown, ids, true),
      { initialProps: { shown: ids.slice(0, 50) } },
    );
    await waitUntil(() => allLoaded());
    const before = result.current;
    const builds = mockGridBuilds.mock.calls.length;
    // A GPS tick / selection: the caller rebuilds its id arrays with the same content.
    await rerender({ shown: [...ids.slice(0, 50)] });
    before.heatAt({ lng: -71.2, lat: 46.81 }, 50, true);
    await rerender({ shown: [...ids.slice(0, 50)] });
    expect(result.current).toBe(before);
    expect(result.current.lines).toBe(before.lines);
    expect(result.current.heatLines).toBe(before.heatLines);
    expect(result.current.heatGlow).toBe(before.heatGlow);
    expect(mockGridBuilds.mock.calls.length).toBe(builds);
  });

  it('builds nothing heavy while the heatmap is off and no trail is shown', async () => {
    const { result } = await renderHook(() => useTrackHeat(tracks, [], [], false));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(storage.readTrackGeometryCache).not.toHaveBeenCalled();
    expect(storage.readFileText).not.toHaveBeenCalled();
    expect(mockGridBuilds).not.toHaveBeenCalled();
    expect(result.current.lines).toBeNull();
    expect(result.current.heatLines).toBeNull();
    expect(result.current.heatGlow).toBeNull();
  });

  it('draws all 400 shown trails from simplified geometry, without the heat grid when off', async () => {
    const { result } = await renderHook(() => useTrackHeat(tracks, ids, ids, false));
    await waitUntil(() => allLoaded());
    const lines = result.current.lines!;
    expect(lines.features).toHaveLength(N);
    const coords = lines.features.reduce(
      (s, f) =>
        s +
        (f.geometry.type === 'LineString'
          ? f.geometry.coordinates.length
          : f.geometry.coordinates.reduce((a, p) => a + p.length, 0)),
      0,
    );
    expect(coords).toBeLessThan(rawPoints / 3);
    expect(mockGridBuilds).not.toHaveBeenCalled();
    expect(result.current.heatLines).toBeNull();
  });

  it('answers a tap in time independent of the library size, newest first', async () => {
    const { result } = await renderHook(() => useTrackHeat(tracks, [], ids, true));
    await waitUntil(() => allLoaded());
    // Home (every favourite route starts there): the hottest spot of the library.
    const home = { lng: -71.2, lat: 46.81 };
    const t0 = Date.now();
    let hit = result.current.heatAt(home, 60, true);
    for (let i = 0; i < 199; i++) hit = result.current.heatAt(home, 60, true);
    const perTap = (Date.now() - t0) / 200;
    expect(hit.hot).toBe(true);
    expect(hit.trackIds.length).toBeGreaterThan(20);
    const started = hit.trackIds.map((id) => tracks.find((t) => t.id === id)!.startedAt);
    expect([...started].sort((a, b) => b - a)).toEqual(started);
    // Generous: a Map-backed lookup is well under a millisecond locally.
    expect(perTap).toBeLessThan(25);
  });

  it('opens a single-pass trail from its heat line', async () => {
    // A lone ride far from everything else.
    const solo = tracks.slice(0, 1).map((t) => ({ ...t, id: 'solo' }));
    const others = tracks.slice(1, 60);
    const list = [...others, ...solo];
    mockCacheFiles.set(
      'solo',
      JSON.stringify({
        key: trackGeometryKey(solo[0]!),
        parts: [
          [
            [-70.5, 47.2],
            [-70.49, 47.2],
          ],
        ],
      }),
    );
    const { result } = await renderHook(() =>
      useTrackHeat(
        list,
        [],
        list.map((t) => t.id),
        true,
      ),
    );
    await waitUntil(() => allLoaded(list));
    const hit = result.current.heatAt({ lng: -70.495, lat: 47.2 }, 10, true);
    expect(hit).toEqual({ trackIds: ['solo'], hot: false });
    // Not drawn → not tappable.
    expect(result.current.heatAt({ lng: -70.495, lat: 47.2 }, 10, false).trackIds).toEqual([]);
    // lineFor serves the (simplified) highlight for any loaded trail.
    expect(result.current.lineFor('solo')?.geometry.type).toBe('LineString');
    expect(result.current.lineFor('nope')).toBeNull();
  });
});

describe('one GPX parse per trail across consumers', () => {
  it('shares geometry between the heat, the overlays and a cold cache', async () => {
    mockCacheFiles.clear();
    const some = tracks.slice(0, 40);
    const someIds = some.map((t) => t.id);
    await renderHook(() => {
      useTrackHeat(some, someIds, someIds, true);
      return useTrackOverlays(some, someIds);
    });
    await waitUntil(() => allLoaded(some));
    expect((storage.readFileText as jest.Mock).mock.calls.length).toBe(40);
    // …and wrote the cache, so the next launch parses nothing.
    expect(mockCacheFiles.size).toBe(40);
    warmCache();
  });
});
