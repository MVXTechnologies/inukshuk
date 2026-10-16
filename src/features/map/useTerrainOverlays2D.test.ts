import type { TerrainResult } from './terrainWorker';
import { useBusyTasksStore } from '@state/busyTasksStore';
import { useSettingsStore } from '@state/settingsStore';
import { useTerrainAreaStore } from '@state/terrainAreaStore';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { fetchDemTileBytes } from './dem';
import { computeTerrain } from './terrainWorker';
import { useTerrainOverlays2D } from './useTerrainOverlays2D';

jest.mock('./dem', () => ({
  fetchDemTileBytes: jest.fn(),
  prefetchDemTiles: jest.fn(async () => undefined),
}));
jest.mock('./terrainWorker', () => ({ computeTerrain: jest.fn() }));
jest.mock('@data/storage', () => ({
  writeOverlayPng: jest.fn((id: string) => `file:///overlays/${id}.png`),
}));

const fetchTiles = jest.mocked(fetchDemTileBytes);
const compute = jest.mocked(computeTerrain);

const out = (): TerrainResult => ({
  slopePngBase64: 'AQID',
  slopeWidth: 1,
  slopeHeight: 1,
  heightmap: null,
  elevationRange: { minM: 312, maxM: 1154 },
  timings: { decode: 0, slope: 0, encode: 0, heightmap: 0 },
});

type Box = [number, number, number, number];
let view: Box = [-71.3, 46.7, -71.1, 46.9];
const mapRef = {
  current: {
    getViewState: async () => ({ center: [0, 0], zoom: 12, bearing: 0, pitch: 0, bounds: view }),
  },
};

beforeEach(() => {
  useSettingsStore.setState({ terrainSlope: true, terrainContours: false });
  useBusyTasksStore.setState({ tasks: [] });
  fetchTiles.mockReset();
  compute.mockReset();
  // The covered area: the (padded) request bounds, as the real fetch rounds out to tiles.
  fetchTiles.mockImplementation(async (b) => ({
    tiles: [],
    keys: [],
    cols: 4,
    rows: 4,
    range: { z: 13, minX: 0, maxX: 3, minY: 0, maxY: 3 },
    bbox: b,
  }));
  compute.mockImplementation(async () => out());
});

function render() {
  return renderHook(
    ({ v }: { v: number }) =>
      useTerrainOverlays2D({ mapRef: mapRef as never, boundsVersion: v, active: true }),
    { initialProps: { v: 0 } },
  );
}

describe('useTerrainOverlays2D (#722)', () => {
  it('never re-uses the shown slope file for a new image, even after skipped requests', async () => {
    view = [-71.3, 46.7, -71.1, 46.9];
    const { result, rerender } = await render();
    await waitFor(() => expect(result.current.slope).not.toBeNull());
    const first = result.current.slope!.uri;
    // A settle inside the covered area: no compute (but a request id is used).
    await act(async () => rerender({ v: 1 }));
    await new Promise((r) => setTimeout(r, 450));
    expect(compute).toHaveBeenCalledTimes(1);
    // Far away: a new image must get a NEW url — MapLibre ignores a url it
    // already shows, which kept the OLD picture on the NEW corners.
    view = [-70.3, 47.7, -70.1, 47.9];
    await act(async () => rerender({ v: 2 }));
    await waitFor(() => expect(compute).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.slope!.coordinates[0][0]).toBeCloseTo(-70.4, 9));
    expect(result.current.slope!.uri).not.toBe(first);
    // And back: alternates again.
    view = [-72.3, 45.7, -72.1, 45.9];
    await act(async () => rerender({ v: 3 }));
    await waitFor(() => expect(compute).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(result.current.slope!.uri).toBe(first));
  });

  it('drops a result that finishes after a newer request started (stale race)', async () => {
    view = [-71.3, 46.7, -71.1, 46.9];
    let releaseFirst!: (o: TerrainResult) => void;
    compute.mockImplementationOnce(() => new Promise((r) => (releaseFirst = r)));
    const { result, rerender } = await render();
    await waitFor(() => expect(compute).toHaveBeenCalledTimes(1));
    view = [-70.3, 47.7, -70.1, 47.9];
    await act(async () => rerender({ v: 1 }));
    await waitFor(() => expect(compute).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.slope).not.toBeNull());
    const shown = result.current.slope!;
    await act(async () => releaseFirst(out())); // the old compute lands late
    expect(result.current.slope).toBe(shown);
    expect(result.current.slope!.coordinates[0][0]).toBeCloseTo(-70.4, 9);
  });

  it('shows nothing new for a superseded (null) compute, and registers busy tasks', async () => {
    view = [-71.3, 46.7, -71.1, 46.9];
    const kinds: string[] = [];
    const unsub = useBusyTasksStore.subscribe((s) => s.tasks.forEach((t) => kinds.push(t.kind)));
    compute.mockImplementationOnce(async () => null);
    const { result } = await render();
    await waitFor(() => expect(compute).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.slope).toBeNull();
    expect(kinds).toEqual(expect.arrayContaining(['tiles', 'slope']));
    expect(useBusyTasksStore.getState().tasks).toEqual([]); // all finished
    unsub();
  });
});

describe('useTerrainOverlays2D: aspect/altitude filter and busy progress (#723/#721)', () => {
  it('feeds the filter into the job, recomputes when it changes, publishes the ground range', async () => {
    view = [-71.3, 46.7, -71.1, 46.9];
    useTerrainAreaStore.setState({ elevationRange: null });
    const filter = { aspectMask: 0b10000011, minAltM: 800, maxAltM: null };
    useSettingsStore.setState({ terrainSlopeFilter: filter });
    const { result } = await render();
    await waitFor(() => expect(result.current.slope).not.toBeNull());
    expect(compute.mock.calls[0]![0].slope?.filter).toEqual(filter);
    expect(useTerrainAreaStore.getState().elevationRange).toEqual({ minM: 312, maxM: 1154 });
    // Same view, new filter: computed again with it.
    const next = { aspectMask: 0xff, minAltM: null, maxAltM: 1150 };
    await act(async () => useSettingsStore.setState({ terrainSlopeFilter: next }));
    await waitFor(() => expect(compute).toHaveBeenCalledTimes(2));
    expect(compute.mock.calls[1]![0].slope?.filter).toEqual(next);
  });

  it('counts DEM tiles into the tiles task ("Map tiles 12/40")', async () => {
    view = [-71.3, 46.7, -71.1, 46.9];
    const seen: string[] = [];
    const unsub = useBusyTasksStore.subscribe((s) =>
      s.tasks.forEach((t) => {
        if (t.kind === 'tiles' && t.progress) seen.push(`${t.progress.done}/${t.progress.total}`);
      }),
    );
    fetchTiles.mockImplementationOnce(async (b, _max, onProgress) => {
      onProgress?.(1, 2);
      onProgress?.(2, 2);
      return {
        tiles: [],
        keys: [],
        cols: 4,
        rows: 4,
        range: { z: 13, minX: 0, maxX: 3, minY: 0, maxY: 3 },
        bbox: b,
      };
    });
    const { result } = await render();
    await waitFor(() => expect(result.current.slope).not.toBeNull());
    expect(seen).toEqual(expect.arrayContaining(['1/2', '2/2']));
    unsub();
  });
});
