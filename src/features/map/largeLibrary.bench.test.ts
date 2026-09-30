/**
 * Large-library benchmark (#465): ~400 Strava-sized trails through the map's
 * heat/trail pipeline and the Library's derivations. Skipped unless BENCH=1:
 *
 *   BENCH=1 BENCH_N=400 npx jest src/features/map/largeLibrary.bench
 *
 * Prints timings; the CI-sized regression guards live in
 * `useTrackHeat.largeLibrary.test.ts`.
 */
import { buildGpx, buildGpx as mockBuildGpx, parseGpx } from '@core/geo/gpx';
import { largeLibrary } from '@core/heat/__fixtures__/quebecLibrary';
import { scanGpxTrack } from '@core/geo/gpx/scan';
import { geometryVertexCount, simplifyTrack } from '@core/geo/track/simplify';
import {
  buildHeatGrid,
  CellGrid,
  HEAT_LINE_CELL_M,
  heatGlowPoints,
  heatGridLines,
  walkTrackCells,
} from '@core/heat/heatGrid';
import { act, renderHook } from '@testing-library/react-native';

const N = Number(process.env.BENCH_N ?? 400);
const mockLib = largeLibrary(N);
const lib = mockLib;
const mockIndexOf = (uri: string) => Number(/trk-(\d+)\.gpx$/.exec(uri)?.[1] ?? -1);

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

const mockBuild = jest.fn();
// Counts whole-library index rebuilds (before #465 this wrapped
// `buildHeatIndex`, which the old hook called twice per rebuild).
jest.mock('@core/heat/heatGrid', () => {
  const actual = jest.requireActual('@core/heat/heatGrid');
  return {
    ...actual,
    buildGridIndex: (...args: unknown[]) => {
      mockBuild();
      return actual.buildGridIndex(...args);
    },
  };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { useTrackHeat } = require('./useTrackHeat') as typeof import('./useTrackHeat');
let clearMemory: (() => void) | undefined;
let allLoaded: () => boolean = () => true;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const geo = require('@data/trackGeometry');
  clearMemory = geo.clearTrackGeometryMemory;
  allLoaded = () => mockLib.tracks.every((t) => geo.peekTrackGeometry(t) !== undefined);
} catch {
  clearMemory = undefined;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const storageMock = require('@data/storage') as { readFileText: jest.Mock };
let readsBefore = 0;
const readsSoFar = () => storageMock.readFileText.mock.calls.length;
const readCount = () => {
  const n = storageMock.readFileText.mock.calls.length - readsBefore;
  readsBefore = storageMock.readFileText.mock.calls.length;
  return n;
};

const d = process.env.BENCH ? describe : describe.skip;
jest.setTimeout(3_600_000);

d(`large library benchmark (N=${N})`, () => {
  it('per-trail pipeline costs', () => {
    let pts = 0;
    let gpxBytes = 0;
    let tBuild = 0;
    let tParse = 0;
    let tScan = 0;
    for (let i = 0; i < N; i++) {
      const points = lib.points(i);
      pts += points.length;
      let t = performance.now();
      const gpx = buildGpx({ points, segmentStarts: lib.segmentStarts(i), metadata: {} });
      tBuild += performance.now() - t;
      gpxBytes += gpx.length;
      t = performance.now();
      parseGpx(gpx);
      tParse += performance.now() - t;
      t = performance.now();
      scanGpxTrack(gpx);
      tScan += performance.now() - t;
    }
    console.log(
      `N=${N} points=${pts} (avg ${Math.round(pts / N)}) gpx=${(gpxBytes / 1e6).toFixed(0)} MB\n` +
        `parseGpx total ${tParse.toFixed(0)} ms, scanGpxTrack total ${tScan.toFixed(0)} ms ` +
        `(buildGpx ${tBuild.toFixed(0)} ms, fixture only)`,
    );
  });

  it('simplified pipeline costs (one full rebuild)', () => {
    let tSimplify = 0;
    const geoms = lib.tracks.map((_, i) => {
      const pts = lib.points(i);
      const t0 = performance.now();
      const g = simplifyTrack(pts, lib.segmentStarts(i));
      tSimplify += performance.now() - t0;
      return g;
    });
    const vertices = geoms.reduce((s, g) => s + geometryVertexCount(g), 0);
    const grid = new CellGrid(HEAT_LINE_CELL_M);
    let t = performance.now();
    const w = geoms.map((g) => walkTrackCells({ id: '', parts: g.parts }, grid));
    const tWalk = performance.now() - t;
    t = performance.now();
    const hg = buildHeatGrid(w, grid);
    const lines = heatGridLines(hg);
    const glow = heatGlowPoints(hg);
    const tGrid = performance.now() - t;
    t = performance.now();
    const index = jest
      .requireActual('@core/heat/heatGrid')
      .buildGridIndex(
        lib.tracks.map((tr, i) => ({ id: tr.id, categoryId: tr.category, cells: w[i]?.cells })),
      );
    const tIndex = performance.now() - t;
    console.log(
      `simplify ${tSimplify.toFixed(0)} ms (${vertices} vertices kept of ` +
        `${lib.tracks.reduce((s, x) => s + x.stats.pointCount, 0)}), ` +
        `walk ${tWalk.toFixed(0)} ms, grid+lines+glow ${tGrid.toFixed(0)} ms ` +
        `(${lines.features.reduce((s, f) => s + f.geometry.coordinates.reduce((a, l) => a + l.length, 0), 0)} heat-line coords, ` +
        `${(JSON.stringify(lines).length / 1e6).toFixed(2)} MB; ${glow.features.length} glow pts), ` +
        `grid tap index ${tIndex.toFixed(0)} ms (${index.size} cells)`,
    );
  });

  const scenarios: [string, boolean, boolean, boolean][] = [
    // label, show every trail, heatmap on, warm geometry cache (second launch)
    ['heatmap on, no trail shown, cold', false, true, false],
    ['heatmap on, no trail shown, warm cache', false, true, true],
    ['heatmap off, every trail shown, warm cache', true, false, true],
    ['heatmap on, every trail shown, cold', true, true, false],
  ];
  it.each(scenarios)('useTrackHeat load: %s', async (label, showAll, heatOn, warm) => {
    mockBuild.mockClear();
    readsBefore = 0;
    if (!warm) mockCacheFiles.clear();
    clearMemory?.();
    const ids = lib.tracks.map((t) => t.id);
    const shown = showAll ? ids : [];
    const all = heatOn ? ids : shown;
    let renders = 0;
    const t0 = performance.now();
    const { result, unmount } = await renderHook(() => {
      renders++;
      return useTrackHeat(lib.tracks, shown, all, heatOn);
    });
    lastCalls = -1;
    for (let spins = 0; spins < 1_000_000; spins++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 1));
      });
      // Before #465 there is no geometry module: every GPX read = loaded.
      const done = clearMemory ? allLoaded() : readsSoFar() >= (heatOn || showAll ? N : 0);
      if (done && mockBuild.mock.calls.length > 0 && (await settled())) break;
    }
    const ms = performance.now() - t0 - 150; // minus the settle wait
    const lines = result.current.lines;
    const coords = lines
      ? lines.features.reduce(
          (s, f) =>
            s +
            (f.geometry.type === 'LineString'
              ? f.geometry.coordinates.length
              : f.geometry.coordinates.reduce((a, p) => a + p.length, 0)),
          0,
        )
      : 0;
    const r = result.current as unknown as Record<string, { features: unknown[] } | null>;
    const heatFeatures = (r.heatPoints ?? r.heatGlow)?.features.length ?? 0;
    console.log(
      `[${label}] total ${ms.toFixed(0)} ms, renders ${renders}, buildHeatIndex calls ` +
        `${mockBuild.mock.calls.length}, GPX reads ${readCount()}, heat/glow features ${heatFeatures}, ` +
        `line features ${lines?.features.length ?? 0}, line coords ${coords}, lines JSON ` +
        `${lines ? (JSON.stringify(lines).length / 1e6).toFixed(1) : 0} MB`,
    );
    await unmount();
  });
});

// "Settled": no render for a few ticks.
let lastCalls = -1;
async function settled(): Promise<boolean> {
  const calls = mockBuild.mock.calls.length;
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  const done = mockBuild.mock.calls.length === calls && calls === lastCalls;
  lastCalls = calls;
  return done;
}
