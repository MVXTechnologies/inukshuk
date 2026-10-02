import { tileKey, type TileId } from '@core/map/contourRecovery';
import { act, renderHook } from '@testing-library/react-native';
import { encodeContourMvt } from '../../../../infra/tiles/worker/src/contourMath';
import {
  NUDGE_HIDDEN_MS,
  RECHECK_AFTER_NUDGE_MS,
  SETTLE_DELAY_MS,
  useContourRecovery,
  type ContourRecoveryMap,
  type SettledView,
} from './useContourRecovery';

/**
 * The map-screen half of contour recovery: what a camera settle sets off
 * against a (fake) MapLibre map and tile server. The rules themselves — how
 * many tries, how far apart — are `@core/map/contourRecovery`'s and tested
 * there; this covers that the hook keeps to them and never nudges the map
 * without cause.
 */

// --- A fake map: north-up, 512-px tiles, a 400 × 800 view --------------------

const VIEW = { width: 400, height: 800 };
const ZOOM = 13;
const TILE_PX = 512;
/** The tile whose top-left sits at screen (-56, 144): it fills most of the view. */
const HOME: TileId = { z: 13, x: 2571, y: 2742 };
const ORIGIN = { x: HOME.x * TILE_PX + 56, y: HOME.y * TILE_PX - 144 };

const worldX = (lon: number) => ((lon + 180) / 360) * TILE_PX * 2 ** ZOOM;
const worldY = (lat: number) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * TILE_PX * 2 ** ZOOM;
};
const lonAt = (x: number) => ((x + ORIGIN.x) / (TILE_PX * 2 ** ZOOM)) * 360 - 180;
const latAt = (y: number) => {
  const n = Math.PI * (1 - (2 * (y + ORIGIN.y)) / (TILE_PX * 2 ** ZOOM));
  return (Math.atan(Math.sinh(n)) * 180) / Math.PI;
};
/** The tile under a screen point. */
const tileAt = (x: number, y: number): TileId => ({
  z: ZOOM,
  x: Math.floor((x + ORIGIN.x) / TILE_PX),
  y: Math.floor((y + ORIGIN.y) / TILE_PX),
});

const SETTLED: SettledView = {
  bounds: [lonAt(0), latAt(VIEW.height), lonAt(VIEW.width), latAt(0)],
  zoom: ZOOM + 0.4,
  pitch: 0,
};
/** The three tiles in view: HOME, and a 144-px strip of the one above and the one below. */
const ABOVE: TileId = { ...HOME, y: HOME.y - 1 };
const BELOW: TileId = { ...HOME, y: HOME.y + 1 };

/** A tile with one line across its middle — or, for `corner`, only in its bottom-right corner. */
const tileBytes = (where: 'middle' | 'corner' | 'empty') =>
  encodeContourMvt(
    where === 'empty'
      ? []
      : [
          {
            ele: 500,
            level: 1,
            lines: [where === 'middle' ? [-32, 2000, 4128, 2100] : [3900, 3900, 4128, 4000]],
          },
        ],
  );

interface Server {
  /** What the tile server answers per tile; a missing entry is a tile with a line. */
  answers: Map<string, ('middle' | 'corner' | 'empty' | 503)[]>;
  fetched: string[];
}

async function setup({
  enabled = true,
  drawn = [] as TileId[],
  reloadWorks = true,
}: { enabled?: boolean; drawn?: TileId[]; reloadWorks?: boolean } = {}) {
  const server: Server = { answers: new Map(), fetched: [] };
  /** Tiles MapLibre has loaded and draws; everything else in view is a hole. */
  const loaded = new Set(drawn.map(tileKey));
  const visibility: boolean[] = [];
  const queries: [[number, number], [number, number]][] = [];
  const map: ContourRecoveryMap = {
    project: async ([lon, lat]) => [worldX(lon) - ORIGIN.x, worldY(lat) - ORIGIN.y],
    queryRenderedFeatures: async (bounds) => {
      queries.push(bounds);
      const [[left, top], [right, bottom]] = bounds;
      return loaded.has(tileKey(tileAt((left + right) / 2, (top + bottom) / 2))) ? [{}] : [];
    },
    setSourceVisibility: async (visible) => {
      visibility.push(visible);
      // Shown again: MapLibre asks for the tiles it lacks — now cached by the fetch.
      if (visible && reloadWorks) {
        for (const key of server.fetched) loaded.add(key);
      }
    },
  };
  const fetchTile = jest.fn(async (url: string) => {
    const key = /contours\/(\d+\/\d+\/\d+)\.mvt/.exec(url)?.[1] ?? '';
    server.fetched.push(key);
    const answer = server.answers.get(key)?.shift() ?? 'middle';
    if (answer === 503) throw new Error('HTTP 503');
    return tileBytes(answer);
  });
  const options = (isEnabled: boolean) => ({
    mapRef: { current: map },
    enabled: isEnabled,
    tilesUrl: 'https://tiles.example/contours/{z}/{x}/{y}.mvt?v=2',
    sourceId: 'basemap-contours',
    minzoom: 8,
    maxzoom: 13,
    layerIds: ['stone-contour-minor', 'stone-contour-major'],
    viewSize: () => VIEW,
    fetchTile,
  });
  const view = await renderHook(
    ({ isEnabled }: { isEnabled: boolean }) => useContourRecovery(options(isEnabled)),
    { initialProps: { isEnabled: enabled } },
  );
  jest.useFakeTimers();
  const settle = async (settled: SettledView = SETTLED) => {
    await act(async () => {
      view.result.current(settled);
    });
  };
  const wait = async (ms: number) => {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(ms);
    });
  };
  return { server, loaded, visibility, queries, fetchTile, view, settle, wait };
}

afterEach(() => {
  jest.useRealTimers();
});

const ALL = [ABOVE, HOME, BELOW];

describe('useContourRecovery', () => {
  it('leaves a map that draws its contours alone', async () => {
    const { fetchTile, visibility, queries, settle, wait } = await setup({ drawn: ALL });
    await settle();
    // Nothing before the map has had time to load its tiles.
    await wait(SETTLE_DELAY_MS - 1);
    expect(queries).toHaveLength(0);
    await wait(1);
    expect(queries.length).toBeGreaterThan(0);
    await wait(60_000);
    expect(fetchTile).not.toHaveBeenCalled();
    expect(visibility).toEqual([]);
  });

  it('asks each tile once: a later settle on the same view costs nothing', async () => {
    const { queries, settle, wait } = await setup({ drawn: ALL });
    await settle();
    await wait(SETTLE_DELAY_MS);
    const first = queries.length;
    await settle();
    await wait(SETTLE_DELAY_MS + 1000);
    expect(queries).toHaveLength(first);
  });

  it('fetches a tile that draws nothing and gets the map to load it again', async () => {
    const { fetchTile, visibility, loaded, settle, wait } = await setup({
      drawn: [ABOVE, BELOW],
    });
    await settle();
    await wait(SETTLE_DELAY_MS);
    expect(fetchTile).toHaveBeenCalledTimes(1);
    expect(fetchTile).toHaveBeenCalledWith('https://tiles.example/contours/13/2571/2742.mvt?v=2');
    // Hidden, then shown again a few frames later.
    expect(visibility).toEqual([false]);
    await wait(NUDGE_HIDDEN_MS);
    expect(visibility).toEqual([false, true]);
    expect(loaded.has(tileKey(HOME))).toBe(true);
    // It looks once more, finds the lines, and stops for good.
    await wait(RECHECK_AFTER_NUDGE_MS + 60_000);
    expect(fetchTile).toHaveBeenCalledTimes(1);
    expect(visibility).toEqual([false, true]);
  });

  it('retries a 503 after 2 s and 6 s, then leaves the tile alone', async () => {
    const { server, fetchTile, visibility, settle, wait } = await setup({
      drawn: [ABOVE, BELOW],
    });
    server.answers.set(tileKey(HOME), [503, 503, 503, 'middle']);
    await settle();
    await wait(SETTLE_DELAY_MS);
    expect(fetchTile).toHaveBeenCalledTimes(1);
    await wait(1999);
    expect(fetchTile).toHaveBeenCalledTimes(1);
    await wait(1);
    expect(fetchTile).toHaveBeenCalledTimes(2);
    await wait(5999);
    expect(fetchTile).toHaveBeenCalledTimes(2);
    await wait(1);
    expect(fetchTile).toHaveBeenCalledTimes(3);
    // Three tries, no more — whatever happens next, and never a nudge for it.
    await wait(120_000);
    await settle();
    await wait(SETTLE_DELAY_MS + 60_000);
    expect(fetchTile).toHaveBeenCalledTimes(3);
    expect(visibility).toEqual([]);
  });

  it('nudges once a retry succeeds', async () => {
    const { server, fetchTile, visibility, settle, wait } = await setup({
      drawn: [ABOVE, BELOW],
    });
    server.answers.set(tileKey(HOME), [503, 'middle']);
    await settle();
    await wait(SETTLE_DELAY_MS);
    expect(visibility).toEqual([]);
    await wait(2000 + NUDGE_HIDDEN_MS);
    expect(fetchTile).toHaveBeenCalledTimes(2);
    expect(visibility).toEqual([false, true]);
  });

  it('does not nudge for a tile with no lines (a lake, a plain)', async () => {
    const { server, fetchTile, visibility, settle, wait } = await setup({
      drawn: [ABOVE, BELOW],
    });
    server.answers.set(tileKey(HOME), ['empty']);
    await settle();
    await wait(SETTLE_DELAY_MS + 60_000);
    await settle();
    await wait(SETTLE_DELAY_MS + 60_000);
    expect(fetchTile).toHaveBeenCalledTimes(1);
    expect(visibility).toEqual([]);
  });

  it('does not nudge when the tile’s lines are all outside the part in view', async () => {
    const { server, fetchTile, visibility, settle, wait } = await setup({
      drawn: [ABOVE, BELOW],
    });
    // HOME's only line is in its bottom-right corner, off the 400-px-wide view.
    server.answers.set(tileKey(HOME), ['corner']);
    await settle();
    await wait(SETTLE_DELAY_MS + 60_000);
    expect(fetchTile).toHaveBeenCalledTimes(1);
    expect(visibility).toEqual([]);
    // Still not fetched again on the next settle: its lines are kept.
    await settle();
    await wait(SETTLE_DELAY_MS + 60_000);
    expect(fetchTile).toHaveBeenCalledTimes(1);
  });

  it('gives up after two nudges that do not bring the tile', async () => {
    const { fetchTile, visibility, settle, wait } = await setup({
      drawn: [ABOVE, BELOW],
      reloadWorks: false,
    });
    await settle();
    await wait(SETTLE_DELAY_MS + NUDGE_HIDDEN_MS);
    expect(visibility).toEqual([false, true]);
    // The second, no sooner than 5 s after the first.
    await wait(RECHECK_AFTER_NUDGE_MS);
    expect(visibility).toEqual([false, true]);
    await wait(5000);
    expect(visibility).toEqual([false, true, false, true]);
    await wait(120_000);
    await settle();
    await wait(SETTLE_DELAY_MS + 120_000);
    expect(visibility).toEqual([false, true, false, true]);
    expect(fetchTile).toHaveBeenCalledTimes(1);
  });

  it('fetches several holes in one pass and nudges once for all of them', async () => {
    const { fetchTile, visibility, settle, wait } = await setup({ drawn: [] });
    await settle();
    await wait(SETTLE_DELAY_MS + NUDGE_HIDDEN_MS);
    expect(fetchTile).toHaveBeenCalledTimes(3);
    expect(visibility).toEqual([false, true]);
  });

  it('stays out of the way: switched off, zoomed out, or tilted', async () => {
    const off = await setup({ enabled: false });
    await off.settle();
    await off.wait(60_000);
    expect(off.queries).toHaveLength(0);
    jest.useRealTimers();

    const on = await setup();
    // Below z10 a loaded tile may draw nothing; a tilted map is not a similarity.
    await on.settle({ ...SETTLED, zoom: 9.9 });
    await on.wait(60_000);
    await on.settle({ ...SETTLED, pitch: 40 });
    await on.wait(60_000);
    expect(on.queries).toHaveLength(0);
    expect(on.fetchTile).not.toHaveBeenCalled();
  });

  it('starts looking when it is switched on with a settled camera', async () => {
    const { view, fetchTile, settle, wait } = await setup({ enabled: false });
    await settle();
    await wait(60_000);
    expect(fetchTile).not.toHaveBeenCalled();
    await act(async () => {
      view.rerender({ isEnabled: true });
    });
    await wait(SETTLE_DELAY_MS);
    expect(fetchTile).toHaveBeenCalled();
  });

  it('a new settle restarts the wait, and unmounting cancels it', async () => {
    const { view, queries, settle, wait } = await setup();
    await settle();
    await wait(SETTLE_DELAY_MS - 500);
    await settle();
    await wait(SETTLE_DELAY_MS - 500);
    expect(queries).toHaveLength(0);
    await act(async () => {
      view.unmount();
    });
    await wait(60_000);
    expect(queries).toHaveLength(0);
  });

  it('survives a map that goes away mid-pass', async () => {
    const { view, fetchTile, settle, wait } = await setup();
    fetchTile.mockImplementationOnce(async () => {
      throw new Error('aborted');
    });
    await settle();
    await wait(SETTLE_DELAY_MS);
    await act(async () => {
      view.unmount();
    });
    await wait(60_000);
    expect(fetchTile.mock.calls.length).toBeLessThanOrEqual(4);
  });
});
