import {
  decodeTerrarium,
  DEM_SIZE,
  demBytes,
  demStats,
  encodeTerrarium,
  MAX_VALID_ELEVATION,
  MIN_VALID_ELEVATION,
  mosaicPixel,
  sampleDem,
  sampleMosaic,
  terrariumHeight,
  terrariumRaw,
  type DemNeighborhood,
} from './dem';

describe('Terrarium decoding', () => {
  it('sea level is (128, 0, 0)', () => {
    expect(terrariumRaw(128, 0, 0)).toBe(0);
    expect(encodeTerrarium(0)).toEqual([128, 0, 0]);
  });

  it.each([
    [0, 0, 0, -32768],
    [255, 255, 255, 32767 + 255 / 256],
    [133, 128, 0, 1408],
    [145, 125, 128, 4477.5],
  ])('raw (%p, %p, %p) = %p m', (r, g, b, h) => {
    expect(terrariumRaw(r, g, b)).toBeCloseTo(h, 9);
  });

  it('no-data (black, white, out of range) reads as sea level', () => {
    expect(terrariumHeight(0, 0, 0)).toBe(0);
    expect(terrariumHeight(255, 255, 255)).toBe(0);
    const [r, g, b] = encodeTerrarium(MAX_VALID_ELEVATION + 10);
    expect(terrariumHeight(r, g, b)).toBe(0);
    const [r2, g2, b2] = encodeTerrarium(MIN_VALID_ELEVATION - 10);
    expect(terrariumHeight(r2, g2, b2, { clampSeaLevel: false })).toBe(0);
  });

  it('bathymetry is clamped to sea level unless asked not to', () => {
    const [r, g, b] = encodeTerrarium(-420.5);
    expect(terrariumHeight(r, g, b)).toBe(0);
    expect(terrariumHeight(r, g, b, { clampSeaLevel: false })).toBeCloseTo(-420.5, 6);
  });

  it('the valid range edges are kept', () => {
    const [r, g, b] = encodeTerrarium(MAX_VALID_ELEVATION);
    expect(terrariumHeight(r, g, b)).toBeCloseTo(MAX_VALID_ELEVATION, 6);
    const [r2, g2, b2] = encodeTerrarium(MIN_VALID_ELEVATION);
    expect(terrariumHeight(r2, g2, b2, { clampSeaLevel: false })).toBeCloseTo(
      MIN_VALID_ELEVATION,
      6,
    );
  });

  const heights = [
    0, 0.00390625, 1, 12.5, 86, 255.99, 256, 1000, 1408.25, 1623.7, 2412, 3842.6, 4477.98, 4808.7,
    6190, 8848.86, -1, -86, -430.5, -10994,
  ];
  it.each(heights)('%p m survives encode → decode within 1/256 m', (h) => {
    const [r, g, b] = encodeTerrarium(h);
    for (const c of [r, g, b]) {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(255);
    }
    expect(Math.abs(terrariumRaw(r, g, b) - h)).toBeLessThanOrEqual(1 / 512 + 1e-9);
  });

  it('decodes RGB and RGBA buffers alike', () => {
    const hs = [0, 1408, 4478, -20];
    const rgba = new Uint8Array(hs.length * 4);
    const rgb = new Uint8Array(hs.length * 3);
    hs.forEach((h, i) => {
      const [r, g, b] = encodeTerrarium(h);
      rgba.set([r, g, b, 255], i * 4);
      rgb.set([r, g, b], i * 3);
    });
    const a = decodeTerrarium(rgba, 2, 2, 4);
    const b = decodeTerrarium(rgb, 2, 2, 3);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(a)).toEqual([0, 1408, 4478, 0]);
  });

  it('rejects a short buffer', () => {
    expect(() => decodeTerrarium(new Uint8Array(10), 2, 2, 4)).toThrow(/bytes/);
  });

  it('stats of an empty tile are zero; otherwise min/max', () => {
    expect(demStats(new Float32Array(0))).toEqual({ min: 0, max: 0 });
    expect(demStats(Float32Array.from([5, -2, 9, 3]))).toEqual({ min: -2, max: 9 });
  });

  it('a decoded tile costs 256 KB in the cache', () => {
    expect(demBytes()).toBe(DEM_SIZE * DEM_SIZE * 4);
  });
});

/** A size×size tile whose pixel (x, y) holds f(x, y). */
function tile(size: number, f: (x: number, y: number) => number): Float32Array {
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) out[y * size + x] = f(x, y);
  return out;
}

describe('sampling one tile', () => {
  const size = 8;
  const plane = tile(size, (x, y) => 10 * x + 100 * y);

  it('pixel centres return the pixel', () => {
    for (const [x, y] of [
      [0, 0],
      [3, 5],
      [7, 7],
    ] as const) {
      expect(sampleDem(plane, size, (x + 0.5) / size, (y + 0.5) / size)).toBeCloseTo(
        10 * x + 100 * y,
        9,
      );
    }
  });

  it('is linear between pixel centres', () => {
    expect(sampleDem(plane, size, 2 / size, 3.5 / size)).toBeCloseTo(10 * 1.5 + 100 * 3, 9);
  });

  it('clamps outside the half-pixel border', () => {
    expect(sampleDem(plane, size, 0, 0)).toBeCloseTo(0, 9);
    expect(sampleDem(plane, size, 1, 1)).toBeCloseTo(10 * 7 + 100 * 7, 9);
    expect(sampleDem(plane, size, -3, 0.5 / size)).toBeCloseTo(0, 9);
  });
});

describe('sampling across tile edges', () => {
  const size = 8;
  // A world-continuous ramp: global pixel gx = tileX·size + x.
  const world = (tx: number, ty: number) =>
    tile(size, (x, y) => (tx * size + x) * 3 + (ty * size + y) * 7);
  const nbhd = (
    tx: number,
    ty: number,
    have: (dx: number, dy: number) => boolean,
  ): DemNeighborhood => ({
    size,
    center: world(tx, ty),
    neighbor: (dx, dy) => (have(dx, dy) ? world(tx + dx, ty + dy) : null),
  });
  const all = () => true;

  it('neighbouring tiles agree exactly on their shared edge', () => {
    const a = nbhd(5, 5, all);
    const b = nbhd(6, 5, all);
    for (const v of [0, 0.13, 0.5, 0.77, 1]) {
      expect(sampleMosaic(a, 1, v)).toBeCloseTo(sampleMosaic(b, 0, v), 9);
    }
    const c = nbhd(5, 6, all);
    for (const u of [0, 0.4, 1])
      expect(sampleMosaic(a, u, 1)).toBeCloseTo(sampleMosaic(c, u, 0), 9);
  });

  it('the shared corner agrees across all four tiles', () => {
    const v = sampleMosaic(nbhd(5, 5, all), 1, 1);
    expect(sampleMosaic(nbhd(6, 5, all), 0, 1)).toBeCloseTo(v, 9);
    expect(sampleMosaic(nbhd(5, 6, all), 1, 0)).toBeCloseTo(v, 9);
    expect(sampleMosaic(nbhd(6, 6, all), 0, 0)).toBeCloseTo(v, 9);
  });

  it('on a continuous ramp the mosaic is exact everywhere, even outside', () => {
    const a = nbhd(2, 3, all);
    for (const [u, v] of [
      [-0.05, 0.5],
      [1.05, 0.5],
      [0.5, -0.05],
      [1.03, 1.04],
    ] as const) {
      const gx = (2 + u) * size - 0.5;
      const gy = (3 + v) * size - 0.5;
      expect(sampleMosaic(a, u, v)).toBeCloseTo(gx * 3 + gy * 7, 9);
    }
  });

  it('a missing neighbour clamps to the centre tile', () => {
    const a = nbhd(2, 3, (dx) => dx !== 1);
    expect(mosaicPixel(a, size, 4)).toBe(world(2, 3)[4 * size + size - 1]);
    expect(sampleMosaic(a, 1, 0.5)).toBeCloseTo(sampleDem(world(2, 3), size, 1, 0.5), 9);
  });

  it('reads the right pixel of each neighbour', () => {
    const a = nbhd(2, 3, all);
    expect(mosaicPixel(a, -1, -1)).toBe(world(1, 2)[(size - 1) * size + size - 1]);
    expect(mosaicPixel(a, size, size)).toBe(world(3, 4)[0]);
    expect(mosaicPixel(a, 3, -1)).toBe(world(2, 2)[(size - 1) * size + 3]);
  });
});
