import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFloat32Grid } from './floatTiff';

/** Load a live-captured NONNA WCS GetCoverage response (2026-08-09). */
function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(__dirname, '__fixtures__', name)));
}

/**
 * Build a tiny tiled big-endian float32 GeoTIFF in memory (the NONNA shape:
 * tiles + ModelTransformation), with override hooks for the shape gates.
 */
function syntheticTiled(opts: {
  width?: number;
  height?: number;
  tileW?: number;
  tileH?: number;
  rotation?: number;
  dxSign?: 1 | -1;
  badTileBytes?: boolean;
  values?: number[];
}): Uint8Array {
  const {
    width = 3,
    height = 3,
    tileW = 4,
    tileH = 4,
    rotation = 0,
    dxSign = 1,
    badTileBytes = false,
    values = [1, 2, 3, 4, 5, 6, 7, 8, 9],
  } = opts;
  const across = Math.ceil(width / tileW);
  const down = Math.ceil(height / tileH);
  const tiles = across * down;
  const tileBytes = tileW * tileH * 4;
  const entries: [number, number, number, number][] = [
    [256, 3, 1, width],
    [257, 3, 1, height],
    [258, 3, 1, 32],
    [259, 3, 1, 1],
    [277, 3, 1, 1],
    [322, 3, 1, tileW],
    [323, 3, 1, tileH],
    [339, 3, 1, 3],
  ];
  const n = entries.length + 3; // + tile offsets, tile byte counts, transform
  const ifdSize = 2 + n * 12 + 4;
  const offsetsOffset = 8 + ifdSize;
  const countsOffset = offsetsOffset + tiles * 4;
  const txOffset = countsOffset + tiles * 4;
  const dataOffset = txOffset + 128;
  const total = dataOffset + tiles * tileBytes;
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  view.setUint8(0, 0x4d);
  view.setUint8(1, 0x4d);
  view.setUint16(2, 42, false);
  view.setUint32(4, 8, false);
  const all: [number, number, number, number][] = [
    ...entries,
    [324, 4, tiles, tiles === 1 ? 0 : offsetsOffset],
    [325, 4, tiles, tiles === 1 ? 0 : countsOffset],
    [34264, 12, 16, txOffset],
  ];
  all.sort((a, b) => a[0] - b[0]);
  view.setUint16(8, all.length, false);
  all.forEach(([tag, type, count, value], i) => {
    const e = 10 + i * 12;
    view.setUint16(e, tag, false);
    view.setUint16(e + 2, type, false);
    view.setUint32(e + 4, count, false);
    if (tag === 324 && tiles === 1) view.setUint32(e + 8, dataOffset, false);
    else if (tag === 325 && tiles === 1)
      view.setUint32(e + 8, badTileBytes ? tileBytes - 4 : tileBytes, false);
    else if (type === 3) view.setUint16(e + 8, value, false);
    else view.setUint32(e + 8, value, false);
  });
  view.setUint32(8 + ifdSize - 4, 0, false); // next-IFD terminator
  for (let t = 0; t < tiles; t++) {
    view.setUint32(offsetsOffset + t * 4, dataOffset + t * tileBytes, false);
    view.setUint32(countsOffset + t * 4, badTileBytes ? tileBytes - 4 : tileBytes, false);
  }
  // Transformation matrix: dx 10, dy −20, origin (1000, 2000).
  const m = [10 * dxSign, rotation, 0, 1000, rotation, -20, 0, 2000, 0, 0, 0, 0, 0, 0, 0, 1];
  m.forEach((v, i) => view.setFloat64(txOffset + i * 8, v, false));
  // Pixel data: values laid into the first tile's padded block, row-major.
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const tileCol = Math.floor(c / tileW);
      const tileRow = Math.floor(r / tileH);
      const t = tileRow * across + tileCol;
      const local = (r % tileH) * tileW + (c % tileW);
      view.setFloat32(dataOffset + t * tileBytes + local * 4, values[r * width + c] ?? 0, false);
    }
  }
  return new Uint8Array(buf);
}

describe('parseFloat32Grid on live NONNA fixtures', () => {
  it('decodes the 3×3 tap-probe subset (16×16 tile, padding dropped)', () => {
    const grid = parseFloat32Grid(fixture('nonna-pin.tif'));
    expect(grid).not.toBeNull();
    expect(grid?.width).toBe(3);
    expect(grid?.height).toBe(3);
    // Centre cell is the plan's verified reference depth: −26.47 m at
    // 46.78502°N 71.21338°W (chart datum, NONNA 10).
    expect(grid?.data[4]).toBeCloseTo(-26.4694, 3);
    // ModelTransformation georef, EPSG:3857 (from the live DescribeCoverage:
    // 19.0986 m cells in x, 19.1202 m in y).
    expect(grid?.dx).toBeCloseTo(19.0986, 3);
    expect(grid?.dy).toBeCloseTo(19.1202, 3);
    expect(grid?.x0).toBeCloseTo(-7927458.06, 1);
    expect(grid?.y0).toBeCloseTo(5907078.51, 1);
  });

  it('decodes a scalesize-reduced viewport subset (multi-tile)', () => {
    const grid = parseFloat32Grid(fixture('nonna-small.tif'));
    expect(grid).not.toBeNull();
    expect(grid?.width).toBe(52);
    expect(grid?.height).toBe(52);
    // A scaled 2 km × 2 km subset: cells ≈ 2000 m / 52.
    expect(grid?.dx).toBeCloseTo(2000 / 52, 0);
    // The ship-channel subset must contain real depths (negative metres)
    // among the nodata fill (float32-max nilValue).
    const vals = Array.from(grid?.data ?? []);
    expect(vals.some((v) => v < -5 && v > -60)).toBe(true);
    expect(vals.some((v) => v > 3e38)).toBe(true);
  });
});

describe('parseFloat32Grid tiled-shape gates', () => {
  it('decodes a synthetic tiled grid with edge-tile padding', () => {
    const grid = parseFloat32Grid(syntheticTiled({}));
    expect(grid).not.toBeNull();
    expect(Array.from(grid?.data ?? [])).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(grid?.x0).toBe(1000);
    expect(grid?.y0).toBe(2000);
    expect(grid?.dx).toBe(10);
    expect(grid?.dy).toBe(20);
  });

  it('decodes a grid spanning multiple tiles', () => {
    const values = Array.from({ length: 36 }, (_, i) => i + 1);
    const grid = parseFloat32Grid(
      syntheticTiled({ width: 6, height: 6, tileW: 4, tileH: 4, values }),
    );
    expect(grid).not.toBeNull();
    expect(Array.from(grid?.data ?? [])).toEqual(values);
  });

  it('rejects a rotated ModelTransformation', () => {
    expect(parseFloat32Grid(syntheticTiled({ rotation: 0.5 }))).toBeNull();
  });

  it('rejects a non-positive x scale', () => {
    expect(parseFloat32Grid(syntheticTiled({ dxSign: -1 }))).toBeNull();
  });

  it('rejects tile byte counts that disagree with the tile size', () => {
    expect(parseFloat32Grid(syntheticTiled({ badTileBytes: true }))).toBeNull();
  });

  it('rejects XML/HTML bodies (WCS ServiceException path)', () => {
    expect(parseFloat32Grid(new TextEncoder().encode('<?xml version="1.0"?><e/>'))).toBeNull();
  });
});
