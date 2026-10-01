/**
 * The stored heatmap (#500) with 400 and 2,000 Strava-sized Québec City
 * trails, generated in memory (the store writes to an in-memory directory).
 * Skipped unless BENCH=1:
 *
 *   BENCH=1 node --expose-gc node_modules/.bin/jest src/features/map/persistedHeat.bench
 *   BENCH=1 BENCH_SIZES=400 …
 *
 * Per size: the cold first build (every trail walked once, batches
 * written), what is stored, a warm open (a later launch: the map reads the
 * manifest and the tiles in view — no trail geometry), one new trail
 * arriving, and tap latency from the stored grid.
 */
import { simplifyTrack } from '@core/geo/track/simplify';
import { largeLibrary } from '@core/heat/__fixtures__/quebecLibrary';
import { nextCullRegion, type CullRegion } from '@core/map/viewportCull';
import type { BoundingBox, TrackSummary } from '@core/models';
import { HeatStore, setHeatStoreForTests } from '@data/heatStore';
import { MemoryHeatIO } from '@data/heatStoreMemoryIO';
import * as storage from '@data/storage';
import { clearTrackGeometryMemory, trackGeometryKey } from '@data/trackGeometry';
import { act, renderHook } from '@testing-library/react-native';

import { useTrackHeat, type TrackHeatViewport } from './useTrackHeat';

const mockCacheFiles = new Map<string, string>();
jest.mock('@data/storage', () => ({
  readFileText: jest.fn(async () => {
    throw new Error('the bench runs from a warm geometry cache');
  }),
  readTrackGeometryCache: jest.fn(async (id: string) => mockCacheFiles.get(id) ?? null),
  writeTrackGeometryCache: jest.fn((id: string, text: string) => {
    mockCacheFiles.set(id, text);
  }),
}));
jest.mock('@data/heatStoreFiles', () => ({ createHeatFileIO: jest.fn() }));

const gc = (globalThis as { gc?: () => void }).gc;
const SIZES = (process.env.BENCH_SIZES ?? '400,2000').split(',').map(Number);
const d = process.env.BENCH ? describe : describe.skip;
jest.setTimeout(3_600_000);

function library(n: number): TrackSummary[] {
  const lib = largeLibrary(n);
  mockCacheFiles.clear();
  return lib.tracks.map((t, i) => {
    const points = lib.points(i);
    let minLat = Infinity;
    let minLng = Infinity;
    let maxLat = -Infinity;
    let maxLng = -Infinity;
    for (const p of points) {
      minLat = Math.min(minLat, p.latitude);
      maxLat = Math.max(maxLat, p.latitude);
      minLng = Math.min(minLng, p.longitude);
      maxLng = Math.max(maxLng, p.longitude);
    }
    const g = simplifyTrack(points, lib.segmentStarts(i));
    mockCacheFiles.set(t.id, JSON.stringify({ key: trackGeometryKey(t), parts: g.parts }));
    return { ...t, stats: { ...t.stats, bbox: { minLat, minLng, maxLat, maxLng } } };
  });
}

function viewportAt(lng: number, lat: number, zoom: number): BoundingBox {
  const degPerPx = 360 / (512 * 2 ** zoom);
  const halfW = 200 * degPerPx;
  const halfH = 400 * degPerPx * Math.cos((lat * Math.PI) / 180);
  return { minLng: lng - halfW, maxLng: lng + halfW, minLat: lat - halfH, maxLat: lat + halfH };
}
const CENTRE = { lng: -71.2, lat: 46.81 };
const region = (zoom: number): CullRegion =>
  nextCullRegion(null, viewportAt(CENTRE.lng, CENTRE.lat, zoom), zoom);

const heapMb = () => {
  gc?.();
  return process.memoryUsage().heapUsed / 1e6;
};
const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;
const geometryReads = () => (storage.readTrackGeometryCache as jest.Mock).mock.calls.length;

async function tick(ms = 5) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

d('stored heatmap', () => {
  describe.each(SIZES)('N=%i', (n) => {
    let tracks: TrackSummary[] = [];
    let ids: string[] = [];
    const io = new MemoryHeatIO();
    beforeAll(() => {
      tracks = library(n);
      ids = tracks.map((t) => t.id);
    });

    it('cold first build (heat on, no trace shown, zoom 12)', async () => {
      clearTrackGeometryMemory();
      (storage.readTrackGeometryCache as jest.Mock).mockClear();
      const store = new HeatStore({ io });
      setHeatStoreForTests(store);
      const heap0 = heapMb();
      const t0 = performance.now();
      let firstHeatMs = -1;
      const { result, unmount } = await renderHook(() =>
        useTrackHeat(tracks, [], ids, true, region(12)),
      );
      for (;;) {
        await tick(20);
        if (firstHeatMs < 0 && (result.current.heatLines?.features.length ?? 0) > 0)
          firstHeatMs = performance.now() - t0;
        const s = store.status();
        if (!s.rebuilding && s.queued === 0 && s.stored === n) break;
      }
      await act(() => store.whenIdle());
      await tick(50);
      const ms = performance.now() - t0;
      const tiles = store.storedTiles().size;
      console.log(
        `[N=${n}] COLD build: ${ms.toFixed(0)} ms total, first heat on screen ${firstHeatMs.toFixed(0)} ms, ` +
          `geometry reads ${geometryReads()}, batches ${store.stats.flushes}, heap +${(heapMb() - heap0).toFixed(0)} MB\n` +
          `    stored: ${tiles} tiles; grids ${kb(io.size('g_'))}, renders ${kb(io.size('r_'))}, ` +
          `manifest ${kb(io.size('manifest'))} (total ${kb(io.size())})`,
      );
      await unmount();
    });

    it.each([
      ['zoom 9 (whole city)', 9],
      ['zoom 12', 12],
      ['zoom 15', 15],
    ] as const)('warm open, heat on, no trace shown, %s', async (label, zoom) => {
      clearTrackGeometryMemory();
      (storage.readTrackGeometryCache as jest.Mock).mockClear();
      const store = new HeatStore({ io });
      setHeatStoreForTests(store);
      io.reads = 0;
      const heap0 = heapMb();
      const t0 = performance.now();
      let heatMs = -1;
      const { result, unmount } = await renderHook(
        ({ v }: { v: TrackHeatViewport }) => useTrackHeat(tracks, [], ids, true, v),
        { initialProps: { v: region(zoom) as TrackHeatViewport } },
      );
      const drawn = () => {
        const r = result.current;
        return (r.heatLines?.features.length ?? 0) + (r.heatGlow?.features.length ?? 0) > 0;
      };
      while (!drawn()) await tick(1);
      heatMs = performance.now() - t0;
      // Until a hot-spot tap resolves (tap tables loaded).
      while (!result.current.heatAt(CENTRE, 60, true).hot) await tick(1);
      const tapReadyMs = performance.now() - t0;
      await act(() => store.whenIdle());
      const heap = heapMb() - heap0;
      const t1 = performance.now();
      let hit = result.current.heatAt(CENTRE, 60, true);
      for (let i = 0; i < 99; i++) hit = result.current.heatAt(CENTRE, 60, true);
      const tapMs = (performance.now() - t1) / 100;
      const r = result.current;
      console.log(
        `[N=${n}] WARM open, ${label}: heat drawn after ${heatMs.toFixed(0)} ms, taps ready ${tapReadyMs.toFixed(0)} ms, ` +
          `geometry reads ${geometryReads()}, heat files read ${io.reads}, heap +${heap.toFixed(0)} MB, ` +
          `batches written ${store.stats.flushes}\n` +
          `    heat lines ${r.heatLines?.features.length} f / ${(JSON.stringify(r.heatLines).length / 1e6).toFixed(2)} MB, ` +
          `glow ${r.heatGlow?.features.length} pts; tap ${tapMs.toFixed(2)} ms → ${hit.trackIds.length} trails (hot ${hit.hot})`,
      );
      expect(geometryReads()).toBe(0);
      await unmount();
    });

    it('one new trail arrives (a recording saved)', async () => {
      clearTrackGeometryMemory();
      const store = new HeatStore({ io });
      setHeatStoreForTests(store);
      await store.open();
      const before = new Map(store.storedTiles());
      const src = tracks[0]!;
      const fresh: TrackSummary = { ...src, id: 'new-recording' };
      mockCacheFiles.set(fresh.id, mockCacheFiles.get(src.id)!.replace(src.id, fresh.id));
      (storage.readTrackGeometryCache as jest.Mock).mockClear();
      io.reads = 0;
      io.writes = 0;
      const t0 = performance.now();
      store.sync([...tracks, fresh]);
      await store.whenIdle();
      const ms = performance.now() - t0;
      const changed = [...store.storedTiles()].filter(([k, rev]) => before.get(k) !== rev).length;
      console.log(
        `[N=${n}] +1 trail: ${ms.toFixed(0)} ms (incl. 2 s debounce), geometry reads ${geometryReads()}, ` +
          `tiles rewritten ${changed}/${store.storedTiles().size}, files read ${io.reads}, written ${io.writes}`,
      );
      // Put it back for the next size's run (separate io per size anyway).
      store.sync(tracks);
      await store.whenIdle();
    });
  });
});
