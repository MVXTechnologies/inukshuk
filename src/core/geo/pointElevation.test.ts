import type { DemTile, TileKey } from '@core/trails/climb';

import {
  createPointElevationReader,
  demTileForPoint,
  FAILURE_TTL_MS,
  LruCache,
  POINT_ELEVATION_ZOOM,
} from './pointElevation';

const QC = { lat: 46.81394, lon: -71.20761 };

/** A tile whose every pixel is `h` metres, or a west→east ramp `h + column`. */
const flat = (h: number): DemTile => ({ size: 256, data: new Float32Array(256 * 256).fill(h) });
const ramp = (h: number): DemTile => ({
  size: 256,
  data: Float32Array.from({ length: 256 * 256 }, (_, i) => h + (i % 256)),
});

/** A loader that counts its calls and resolves when told to. */
function controlledLoader(tile: (k: TileKey) => DemTile = () => flat(412)) {
  const calls: TileKey[] = [];
  const pending: (() => void)[] = [];
  let fail = false;
  const load = (key: TileKey) =>
    new Promise<DemTile>((resolve, reject) => {
      calls.push(key);
      pending.push(() => (fail ? reject(new Error('offline')) : resolve(tile(key))));
    });
  return {
    load,
    calls,
    setFail: (f: boolean) => {
      fail = f;
    },
    flush: async () => {
      while (pending.length > 0) pending.shift()?.();
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

describe('demTileForPoint', () => {
  it('picks the z12 tile and pixel under Québec City', () => {
    // x = (lon + 180) / 360 × 4096 = 1237.816; Web Mercator y = 1443.769.
    expect(demTileForPoint(QC.lat, QC.lon)).toEqual({
      key: { z: POINT_ELEVATION_ZOOM, x: 1237, y: 1443 },
      px: 208,
      py: 196,
    });
  });

  it('puts 0°, 0° at the corner of the four central tiles', () => {
    expect(demTileForPoint(0, 0, 1)).toEqual({ key: { z: 1, x: 1, y: 1 }, px: 0, py: 0 });
    expect(demTileForPoint(-0.0001, -0.0001, 1)?.key).toEqual({ z: 1, x: 0, y: 1 });
  });

  it('wraps the longitude and clamps to the grid', () => {
    expect(demTileForPoint(10, 200)?.key).toEqual(demTileForPoint(10, -160)?.key);
    expect(demTileForPoint(10, 180)?.key.x).toBe(0);
    expect(demTileForPoint(10, 179.99999)?.key.x).toBe(4095);
  });

  it('has no tile beyond Web Mercator, or for junk', () => {
    expect(demTileForPoint(86, 0)).toBeNull();
    expect(demTileForPoint(-89, 0)).toBeNull();
    expect(demTileForPoint(Number.NaN, 0)).toBeNull();
    expect(demTileForPoint(10, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('LruCache', () => {
  it('drops the least recently used past its size; get refreshes', () => {
    const c = new LruCache<string, number>(2);
    c.set('a', 1);
    c.set('b', 2);
    expect(c.get('a')).toBe(1); // a is now the most recent
    c.set('c', 3); // evicts b
    expect(c.has('b')).toBe(false);
    expect(c.get('a')).toBe(1);
    expect(c.get('c')).toBe(3);
    expect(c.size).toBe(2);
    c.set('a', 10); // re-set refreshes without growing
    expect(c.size).toBe(2);
    expect(c.get('missing')).toBeUndefined();
  });
});

describe('createPointElevationReader', () => {
  it('a miss loads the tile once; then every read in it is a synchronous hit', async () => {
    const l = controlledLoader();
    const r = createPointElevationReader(l.load);
    expect(r.peek(QC.lat, QC.lon)).toBeUndefined(); // miss: not read yet
    const v = r.load(QC.lat, QC.lon);
    await l.flush();
    await expect(v).resolves.toBeCloseTo(412, 6);
    expect(r.peek(QC.lat, QC.lon)).toBeCloseTo(412, 6);
    // 50 idles a few metres apart, same tile: no further load.
    for (let i = 0; i < 50; i++) {
      expect(r.peek(QC.lat + i * 1e-5, QC.lon)).toBeCloseTo(412, 6);
      await r.load(QC.lat + i * 1e-5, QC.lon);
    }
    expect(l.calls).toHaveLength(1);
    expect(r.loads).toBe(1);
  });

  it('shares one load between concurrent reads of a tile', async () => {
    const l = controlledLoader();
    const r = createPointElevationReader(l.load);
    const reads = Array.from({ length: 10 }, (_, i) => r.load(QC.lat, QC.lon + i * 1e-5));
    await l.flush();
    expect((await Promise.all(reads)).every((v) => v !== null)).toBe(true);
    expect(l.calls).toHaveLength(1);
  });

  it('samples the pixel under the point (bilinear between pixel centres)', async () => {
    const l = controlledLoader(() => ramp(100));
    const r = createPointElevationReader(l.load);
    void r.load(QC.lat, QC.lon);
    await l.flush();
    // Column 208 at x-fraction .8156 × 256 = 208.8 → between centres 208 and 209.
    expect(r.peek(QC.lat, QC.lon)).toBeCloseTo(100 + 208.8 - 0.5, 0);
  });

  it('keeps only maxTiles decoded tiles', async () => {
    const l = controlledLoader();
    const r = createPointElevationReader(l.load, { maxTiles: 2 });
    for (const lon of [-71.2, -71.1, -71.0]) {
      void r.load(QC.lat, lon); // three different z12 tiles (~0.088° wide)
      await l.flush();
    }
    expect(r.peek(QC.lat, -71.0)).not.toBeUndefined();
    expect(r.peek(QC.lat, -71.2)).toBeUndefined(); // evicted
    expect(l.calls).toHaveLength(3);
  });

  it('a failed tile reads as unavailable and is not retried until the TTL passes', async () => {
    let t = 1_000;
    const l = controlledLoader();
    l.setFail(true);
    const r = createPointElevationReader(l.load, { now: () => t });
    const v = r.load(QC.lat, QC.lon);
    await l.flush();
    await expect(v).resolves.toBeNull();
    expect(r.peek(QC.lat, QC.lon)).toBeNull();
    await expect(r.load(QC.lat, QC.lon)).resolves.toBeNull();
    expect(l.calls).toHaveLength(1);
    t += FAILURE_TTL_MS;
    l.setFail(false);
    expect(r.peek(QC.lat, QC.lon)).toBeUndefined(); // may try again
    const again = r.load(QC.lat, QC.lon);
    await l.flush();
    await expect(again).resolves.toBeCloseTo(412, 6);
    expect(l.calls).toHaveLength(2);
  });

  it('outside the DEM is unavailable without a load', async () => {
    const l = controlledLoader();
    const r = createPointElevationReader(l.load);
    expect(r.peek(88, 0)).toBeNull();
    await expect(r.load(88, 0)).resolves.toBeNull();
    expect(l.calls).toHaveLength(0);
  });

  it('a no-data pixel is unavailable, not a number', async () => {
    const l = controlledLoader(() => flat(Number.NaN));
    const r = createPointElevationReader(l.load);
    const v = r.load(QC.lat, QC.lon);
    await l.flush();
    await expect(v).resolves.toBeNull();
  });
});
