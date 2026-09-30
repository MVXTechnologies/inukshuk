import { mercatorPixel } from '@core/mapmaker/cropRaster';
import { layoutMadeMap } from '@core/mapmaker/layout';
import {
  TileFetchError,
  type TileFailure,
  type TilePlan,
  type PlannedTile,
} from '@core/mapmaker/tilePlan';
import { fetchPrintBasemap } from '../dem';
import { composeMapPdf, type ComposeHandle, type MakeMapOptions } from './composeMapPdf';

jest.mock('../dem', () => ({
  fetchPrintBasemap: jest.fn(),
  fetchHeightmap: jest.fn(),
}));

const fetchBase = jest.mocked(fetchPrintBasemap);

/** The frame the editor hands over for A4 1:25 000 at Mont-Sainte-Anne. */
const bbox = { minLng: -70.906, maxLng: -70.904, minLat: 47.0753, maxLat: 47.0767 };
const options: MakeMapOptions = {
  name: 'Mont-Sainte-Anne',
  format: 'a4',
  scaleDenom: 25000,
  basemap: 'map',
  contours: true,
  contourIntervalM: 20,
  slope: false,
  slopeMinDeg: 30,
  slopeMaxDeg: 45,
  slopeOpacity: 0.55,
  includeUserData: false,
  grid: true,
  compass: true,
  declinationDeg: null,
};
const input = { bbox, options, tracks: [], waypoints: [] };

function failing(plan: TilePlan, n: number, error: unknown): TileFailure<PlannedTile>[] {
  return plan.tiles.slice(0, n).map((tile) => ({ tile, error, attempts: 3 }));
}

beforeEach(() => fetchBase.mockReset());

describe('composeMapPdf tile retrieval (#460)', () => {
  it('plans a base raster that covers the whole frame (17 rows, not 16)', async () => {
    let seen: TilePlan | null = null;
    fetchBase.mockImplementation(async (plan) => {
      seen = plan;
      // Stop the compose right after planning: every tile failed.
      return {
        texture: { data: new Uint8Array(0), width: 0, height: 0 },
        failures: failing(plan, plan.tiles.length, new Error('x')),
      };
    });
    await expect(composeMapPdf(input, jest.fn())).rejects.toBeInstanceOf(TileFetchError);

    const plan = seen as TilePlan | null;
    expect(plan).not.toBeNull();
    if (!plan) return;
    const { drawBbox, rasterZoom } = layoutMadeMap(bbox, 'a4', { scaleDenom: 25000 });
    expect(plan.range.z).toBe(rasterZoom);
    expect(plan.range.maxY - plan.range.minY + 1).toBe(17);
    const tl = mercatorPixel(drawBbox.minLng, drawBbox.maxLat, plan.range);
    const br = mercatorPixel(drawBbox.maxLng, drawBbox.minLat, plan.range);
    expect(tl.x).toBeGreaterThanOrEqual(0);
    expect(tl.y).toBeGreaterThanOrEqual(0);
    expect(br.x).toBeLessThanOrEqual((plan.range.maxX - plan.range.minX + 1) * 256);
    expect(br.y).toBeLessThanOrEqual((plan.range.maxY - plan.range.minY + 1) * 256);
    expect(fetchBase).toHaveBeenCalledWith(plan, 'map', expect.any(Object));
  });

  it('too many missing tiles fail the make with a message that says how many and why', async () => {
    fetchBase.mockImplementation(async (plan) => ({
      texture: { data: new Uint8Array(0), width: 0, height: 0 },
      failures: failing(plan, 40, new Error('Unable to download a file: timeout')),
    }));
    await expect(composeMapPdf(input, jest.fn())).rejects.toThrow(
      /^couldn't download 40 of 204 map tiles \(Unable to download a file: timeout\)/,
    );
  });

  it('offline-only mode is reported as the setting it is', async () => {
    const offline = Object.assign(new Error('offline-only: map-16-1-1.png not cached'), {
      name: 'OfflineOnlyError',
    });
    fetchBase.mockImplementation(async (plan) => ({
      texture: { data: new Uint8Array(0), width: 0, height: 0 },
      failures: failing(plan, plan.tiles.length, offline),
    }));
    await expect(composeMapPdf(input, jest.fn())).rejects.toThrow(/offline-only mode is on/);
  });

  it('reports tile progress as tiles settle', async () => {
    const onProgress = jest.fn();
    fetchBase.mockImplementation(async (plan, _source, fetch) => {
      fetch?.onSettled?.(plan.tiles.length / 2, plan.tiles.length);
      return {
        texture: { data: new Uint8Array(0), width: 0, height: 0 },
        failures: failing(plan, plan.tiles.length, new Error('x')),
      };
    });
    await expect(composeMapPdf(input, onProgress)).rejects.toThrow();
    expect(onProgress).toHaveBeenCalledWith('tiles', 0.35);
  });

  it('a Cancel during the download stops before judging the tiles', async () => {
    const handle: ComposeHandle = { aborted: false };
    fetchBase.mockImplementation(async (plan, _source, fetch) => {
      handle.aborted = true;
      expect(fetch?.isAborted?.()).toBe(true);
      return {
        texture: { data: new Uint8Array(0), width: 0, height: 0 },
        failures: failing(plan, plan.tiles.length, new Error('x')),
      };
    });
    await expect(composeMapPdf(input, jest.fn(), handle)).rejects.toThrow('aborted');
  });

  it('refuses, in words, a frame zoomed out past the printable world', async () => {
    const world = { minLng: -100, maxLng: -40, minLat: -40, maxLat: 84 };
    await expect(
      composeMapPdf(
        { ...input, bbox: world, options: { ...options, scaleDenom: 90_000_000 } },
        jest.fn(),
      ),
    ).rejects.toThrow(/zoom in/);
    expect(fetchBase).not.toHaveBeenCalled();
  });
});
