/**
 * Viewport-culled heat and trail lines (#494) with 400 and 2,000 Strava-sized
 * Québec City trails, all generated in memory (nothing written to disk).
 * Skipped unless BENCH=1:
 *
 *   BENCH=1 npx jest src/features/map/viewportHeat.bench
 *   BENCH=1 BENCH_SIZES=2000 node --expose-gc node_modules/.bin/jest \
 *     src/features/map/viewportHeat.bench    # heap deltas need --expose-gc
 *
 * Each scenario warms the geometry cache (a second launch), mounts
 * `useTrackHeat` for one camera, and prints the load time, render and
 * rebuild counts, and what reaches MapLibre (GeoJSON bytes, features,
 * coordinates). A pan sequence then counts how often a settle rebuilds a
 * source. "no culling" builds for the whole library (the pre-#494 extent).
 */
import { simplifyTrack } from '@core/geo/track/simplify';
import { largeLibrary } from '@core/heat/__fixtures__/quebecLibrary';
import { nextCullRegion, type CullRegion } from '@core/map/viewportCull';
import type { BoundingBox, TrackSummary } from '@core/models';
import { clearTrackGeometryMemory, peekTrackGeometry, trackGeometryKey } from '@data/trackGeometry';
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

// Heat-on scenarios read the stored heat (#500) from an in-memory directory;
// `persistedHeat.bench` separates its cold build from a warm open.
jest.mock('@data/heatStoreFiles', () => {
  const { MemoryHeatIO } = jest.requireActual('@data/heatStoreMemoryIO');
  return { createHeatFileIO: () => new MemoryHeatIO() };
});

const mockGridLines = jest.fn();
const mockIndexBuilds = jest.fn();
jest.mock('@core/heat/heatGrid', () => {
  const actual = jest.requireActual('@core/heat/heatGrid');
  return {
    ...actual,
    heatGridLines: (...args: unknown[]) => {
      mockGridLines();
      return actual.heatGridLines(...args);
    },
    buildGridIndex: (...args: unknown[]) => {
      mockIndexBuilds();
      return actual.buildGridIndex(...args);
    },
  };
});

/** Run with `node --expose-gc node_modules/.bin/jest …` for meaningful heap deltas. */
const gc = (globalThis as { gc?: () => void }).gc;
const SIZES = (process.env.BENCH_SIZES ?? '400,2000').split(',').map(Number);
const d = process.env.BENCH ? describe : describe.skip;
jest.setTimeout(3_600_000);

/** Build N trails with stats.bbox, and a warm cache of their simplified geometry. */
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

/** A 400×800 dp phone viewport centred on (lng, lat) at `zoom` (512-px tiles). */
function viewportAt(lng: number, lat: number, zoom: number): BoundingBox {
  const degPerPx = 360 / (512 * 2 ** zoom);
  const halfW = 200 * degPerPx;
  const halfH = 400 * degPerPx * Math.cos((lat * Math.PI) / 180);
  return { minLng: lng - halfW, maxLng: lng + halfW, minLat: lat - halfH, maxLat: lat + halfH };
}

const CENTRE = { lng: -71.2, lat: 46.81 };

type Fc = { features: { geometry: { type: string; coordinates: unknown } }[] } | null;
function size(fc: Fc): string {
  if (!fc) return '—';
  const bytes = JSON.stringify(fc).length;
  let coords = 0;
  const count = (c: unknown): void => {
    if (Array.isArray(c) && typeof c[0] === 'number') coords++;
    else if (Array.isArray(c)) c.forEach(count);
  };
  fc.features.forEach((f) => count(f.geometry.coordinates));
  return `${fc.features.length} f / ${coords} coords / ${(bytes / 1e6).toFixed(2)} MB`;
}

async function settle(ms = 20) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

d('viewport-culled heat and trail lines', () => {
  describe.each(SIZES)('N=%i', (n) => {
    let tracks: TrackSummary[] = [];
    let ids: string[] = [];
    beforeAll(() => {
      const t0 = performance.now();
      tracks = library(n);
      ids = tracks.map((t) => t.id);
      console.log(
        `[N=${n}] fixture + warm cache built in ${(performance.now() - t0).toFixed(0)} ms`,
      );
    });

    const scenarios: [
      label: string,
      heat: boolean,
      showAll: boolean,
      view: () => TrackHeatViewport,
    ][] = [
      ['no culling (viewport "all"), heat on, every trail shown', true, true, () => 'all'],
      ['heat on, every trail shown, zoom 9 (whole city)', true, true, () => region(9)],
      ['heat on, every trail shown, zoom 12', true, true, () => region(12)],
      ['heat on, every trail shown, zoom 15', true, true, () => region(15)],
      ['heat on, no trail shown, zoom 12', true, false, () => region(12)],
      ['heat off, every trail shown, zoom 15', false, true, () => region(15)],
      ['heat off, every trail shown, zoom 12', false, true, () => region(12)],
      ['heat off, every trail shown, zoom 10', false, true, () => region(10)],
    ];
    function region(zoom: number): CullRegion {
      return nextCullRegion(null, viewportAt(CENTRE.lng, CENTRE.lat, zoom), zoom);
    }

    it.each(scenarios)('%s', async (label, heat, showAll, view) => {
      clearTrackGeometryMemory();
      mockGridLines.mockClear();
      mockIndexBuilds.mockClear();
      const shown = showAll ? ids : [];
      const all = heat ? ids : shown;
      gc?.();
      const heapBefore = process.memoryUsage().heapUsed;
      let renders = 0;
      const t0 = performance.now();
      const { result, unmount } = await renderHook(
        ({ v }: { v: TrackHeatViewport }) => {
          renders++;
          return useTrackHeat(tracks, shown, all, heat, v);
        },
        { initialProps: { v: view() } },
      );
      // Wait until every trail this view loads is in and the last batch settled.
      const loadedNow = () => tracks.filter((t) => peekTrackGeometry(t) !== undefined).length;
      let last = { renders: -1, loaded: -1, at: performance.now() };
      for (;;) {
        await settle(10);
        const now = { renders, loaded: loadedNow(), at: performance.now() };
        if (now.renders !== last.renders || now.loaded !== last.loaded) last = now;
        else if (now.at - last.at > 400) break;
      }
      const ms = last.at - t0;
      const loaded = loadedNow();
      gc?.();
      const heapMb = (process.memoryUsage().heapUsed - heapBefore) / 1e6;
      const r = result.current;
      console.log(
        `[N=${n}] ${label}: ${ms.toFixed(0)} ms, renders ${renders}, geometries loaded ${loaded}, ` +
          `heat-line builds ${mockGridLines.mock.calls.length}, tap-index builds ` +
          `${mockIndexBuilds.mock.calls.length}, heap +${heapMb.toFixed(0)} MB\n` +
          `    lines ${size(r.lines)}\n    heat lines ${size(r.heatLines)}\n` +
          `    heat glow ${size(r.heatGlow)}`,
      );
      await unmount();
    });

    it('pan sequence at zoom 14: settles vs rebuilds', async () => {
      clearTrackGeometryMemory();
      const zoom = 14;
      let viewport = viewportAt(CENTRE.lng, CENTRE.lat, zoom);
      let reg = nextCullRegion(null, viewport, zoom);
      const { result, rerender, unmount } = await renderHook(
        ({ v }: { v: TrackHeatViewport }) => useTrackHeat(tracks, ids, ids, true, v),
        { initialProps: { v: reg as TrackHeatViewport } },
      );
      for (let i = 0; i < 200 && tracks.some((t) => peekTrackGeometry(t) === undefined); i++) {
        await settle(50);
      }
      await settle(100);
      let regionChanges = 0;
      let linesChanges = 0;
      let heatChanges = 0;
      let worstMs = 0;
      const settles = 40;
      for (let i = 0; i < settles; i++) {
        // A walk: small 10 % nudges, with a 60 % jump every 10th settle.
        const step = i % 10 === 9 ? 0.6 : 0.1;
        const w = viewport.maxLng - viewport.minLng;
        viewport = {
          ...viewport,
          minLng: viewport.minLng + w * step,
          maxLng: viewport.maxLng + w * step,
        };
        const next = nextCullRegion(reg, viewport, zoom);
        const before = result.current;
        const t0 = performance.now();
        if (next !== reg) {
          regionChanges++;
          reg = next;
          await rerender({ v: reg });
        }
        await settle(5);
        worstMs = Math.max(worstMs, performance.now() - t0 - 5);
        if (result.current.lines !== before.lines) linesChanges++;
        if (result.current.heatLines !== before.heatLines) heatChanges++;
      }
      console.log(
        `[N=${n}] pan at zoom 14: ${settles} settles → ${regionChanges} region changes, ` +
          `${linesChanges} trail-line rebuilds, ${heatChanges} heat-line rebuilds, worst settle ` +
          `${worstMs.toFixed(0)} ms (geometry loads included)`,
      );
      await unmount();
    });
  });
});
