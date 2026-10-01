import { layoutMadeMap, RASTER_LONG_EDGE_PX } from '@core/mapmaker/layout';
import {
  maxTilesPerSideFor,
  planTiles,
  TileFetchError,
  type TilePlan,
} from '@core/mapmaker/tilePlan';
import * as storage from '@data/storage';
import UPNG from 'upng-js';
import { fetchHeightmap, fetchPrintBasemap } from './dem';

jest.mock('@data/storage', () => ({ downloadBytes: jest.fn() }));

const download = jest.mocked(storage.downloadBytes);
const noSleep = { sleep: () => Promise.resolve() };

/** A 256² PNG tile of one colour. */
function pngTile(r: number, g: number, b: number, a = 255): Uint8Array {
  const px = new Uint8Array(256 * 256 * 4);
  for (let i = 0; i < px.length; i += 4) {
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = a;
  }
  return new Uint8Array(UPNG.encode([px.buffer], 256, 256, 0));
}

const RED = pngTile(200, 10, 10);

function offlineError(name: string) {
  return Object.assign(new Error(`offline-only: ${name} not cached`), {
    name: 'OfflineOnlyError',
  });
}

/** RGBA of the pixel at the centre of stitched cell (col, row). */
function cellPixel(tex: { data: Uint8Array; width: number }, col: number, row: number) {
  const i = ((row * 256 + 128) * tex.width + col * 256 + 128) * 4;
  return Array.from(tex.data.subarray(i, i + 4));
}

const smallPlan: TilePlan = planTiles(
  { minLng: -71.23, maxLng: -71.19, minLat: 46.8, maxLat: 46.82 },
  14,
  { minZoom: 0, maxZoom: 19 },
  17,
);

beforeEach(() => download.mockReset());

it('the fixture sheet has several tiles to lose one of', () => {
  expect(smallPlan.tiles.length).toBeGreaterThanOrEqual(4);
});

describe('fetchPrintBasemap (#460)', () => {
  it('requests every planned tile from the Esri print template, with our User-Agent', async () => {
    download.mockResolvedValue(RED);
    const { failures } = await fetchPrintBasemap(smallPlan, 'map', noSleep);
    expect(failures).toEqual([]);
    expect(download).toHaveBeenCalledTimes(smallPlan.tiles.length);
    for (const t of smallPlan.tiles) {
      expect(download).toHaveBeenCalledWith(
        `https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/${t.z}/${t.y}/${t.x}`,
        `map-${t.z}-${t.x}-${t.y}.png`,
        { 'User-Agent': expect.stringContaining('Inukshuk') },
      );
    }
  });

  it('imagery comes from World_Imagery and caches as .jpg', async () => {
    download.mockResolvedValue(RED);
    await fetchPrintBasemap(smallPlan, 'satellite', noSleep);
    const [url, name] = download.mock.calls[0]!;
    expect(url).toMatch(/World_Imagery\/MapServer\/tile\/14\/\d+\/\d+$/);
    expect(name).toMatch(/^satellite-14-\d+-\d+\.jpg$/);
  });

  it('a tile that fails twice then arrives is retried into the sheet — no hole', async () => {
    const flaky = smallPlan.tiles[0]!;
    let flakyCalls = 0;
    download.mockImplementation(async (_url, name) => {
      if (name === `map-${flaky.z}-${flaky.x}-${flaky.y}.png` && flakyCalls++ < 2) {
        throw new Error('Unable to download a file: timeout');
      }
      return RED;
    });
    const { texture, failures } = await fetchPrintBasemap(smallPlan, 'map', noSleep);
    expect(failures).toEqual([]);
    expect(cellPixel(texture, flaky.col, flaky.row)).toEqual([200, 10, 10, 255]);
  });

  it('a tile that never arrives is REPORTED and painted paper — the rest of the sheet survives', async () => {
    // Before #460 this rejected the whole make with the bare download error.
    const dead = smallPlan.tiles[1]!;
    download.mockImplementation(async (_url, name) => {
      if (name === `map-${dead.z}-${dead.x}-${dead.y}.png`) {
        throw new Error('Unable to download a file: HTTP 503');
      }
      return RED;
    });
    const { texture, failures } = await fetchPrintBasemap(smallPlan, 'map', noSleep);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ tile: dead, attempts: 3 });
    expect(cellPixel(texture, dead.col, dead.row)).toEqual([0xe6, 0xdf, 0xcf, 255]);
    const alive = smallPlan.tiles[0]!;
    expect(cellPixel(texture, alive.col, alive.row)).toEqual([200, 10, 10, 255]);
  });

  it('offline-only cache misses fail fast (one attempt each), not after retries', async () => {
    download.mockImplementation(async (_url, name) => {
      throw offlineError(name);
    });
    const { failures } = await fetchPrintBasemap(smallPlan, 'map', noSleep);
    expect(failures).toHaveLength(smallPlan.tiles.length);
    expect(download).toHaveBeenCalledTimes(smallPlan.tiles.length);
  });

  it('keeps no more than six downloads in flight on a full A4 1:25 000 sheet', async () => {
    const layout = layoutMadeMap(
      { minLng: -70.906, maxLng: -70.904, minLat: 47.0753, maxLat: 47.0767 },
      'a4',
      { scaleDenom: 25000 },
    );
    const plan = planTiles(
      layout.drawBbox,
      layout.rasterZoom,
      { minZoom: 0, maxZoom: 19 },
      maxTilesPerSideFor(RASTER_LONG_EDGE_PX),
    );
    let inFlight = 0;
    let peak = 0;
    download.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight--;
      return RED;
    });
    const { failures } = await fetchPrintBasemap(plan, 'map', noSleep);
    expect(failures).toEqual([]);
    expect(download).toHaveBeenCalledTimes(plan.tiles.length);
    expect(plan.tiles.length).toBe(12 * 17);
    expect(peak).toBeLessThanOrEqual(6);
  }, 20000);

  it('requests wrapped columns across the antimeridian', async () => {
    download.mockResolvedValue(RED);
    const plan = planTiles(
      { minLng: 179.9, maxLng: 180.1, minLat: -16.8, maxLat: -16.7 },
      10,
      { minZoom: 0, maxZoom: 19 },
      17,
    );
    await fetchPrintBasemap(plan, 'map', noSleep);
    const xs = download.mock.calls.map(([url]) => Number(url.split('/').at(-1)));
    expect(new Set(xs)).toEqual(new Set([1023, 0]));
  });
});

describe('fetchHeightmap', () => {
  it('names the elevation tiles when they cannot be downloaded (after retrying)', async () => {
    download.mockRejectedValue(new Error('Unable to download a file: timeout'));
    const run = fetchHeightmap({ minLng: -71.21, maxLng: -71.2, minLat: 46.81, maxLat: 46.815 });
    await expect(run).rejects.toBeInstanceOf(TileFetchError);
    await expect(run).rejects.toThrow(/couldn't download \d+ of \d+ elevation tiles/);
    // Each tile got its three attempts.
    const names = download.mock.calls.map(([, name]) => name);
    const unique = new Set(names);
    expect(names.length).toBe(unique.size * 3);
  }, 20000);
});
