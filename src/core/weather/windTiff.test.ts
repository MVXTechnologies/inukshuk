import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFloat32Tiff } from './windTiff';

/** Load a live-captured GeoMet WCS GetCoverage response (2026-08-09). */
function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(__dirname, '__fixtures__', name)));
}

/**
 * Build a tiny valid single-strip LE float32 GeoTIFF in memory, with
 * override hooks for the shape gates. Layout: header(8) + IFD + out-of-line
 * doubles + pixel data.
 */
function syntheticTiff(opts: {
  width?: number;
  height?: number;
  bits?: number;
  compression?: number;
  samplesPerPixel?: number;
  sampleFormat?: number;
  bigEndian?: boolean;
  omitGeo?: boolean;
  dLon?: number;
  values?: number[];
  truncateData?: boolean;
  tiePoint?: number[];
}): Uint8Array {
  const {
    width = 2,
    height = 2,
    bits = 32,
    compression = 1,
    samplesPerPixel = 1,
    sampleFormat = 3,
    bigEndian = false,
    omitGeo = false,
    dLon = 0.5,
    values = [1, 2, 3, 4],
    truncateData = false,
    tiePoint = [0, 0, 0, -72, 48, 0],
  } = opts;
  const le = !bigEndian;
  const entries: [number, number, number, number][] = [
    [256, 3, 1, width],
    [257, 3, 1, height],
    [258, 3, 1, bits],
    [259, 3, 1, compression],
    [277, 3, 1, samplesPerPixel],
    [278, 3, 1, height],
    [339, 3, 1, sampleFormat],
  ];
  const n = omitGeo ? entries.length + 2 : entries.length + 4;
  const ifdSize = 2 + n * 12 + 4;
  const scaleOffset = 8 + ifdSize;
  const tieOffset = scaleOffset + 24;
  const dataOffset = omitGeo ? scaleOffset : tieOffset + 48;
  const dataBytes = width * height * 4;
  const total = dataOffset + (truncateData ? dataBytes - 4 : dataBytes);
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  view.setUint8(0, le ? 0x49 : 0x4d);
  view.setUint8(1, le ? 0x49 : 0x4d);
  view.setUint16(2, 42, le);
  view.setUint32(4, 8, le);
  const all: [number, number, number, number][] = [
    ...entries,
    [273, 4, 1, dataOffset],
    [279, 4, 1, dataBytes],
  ];
  if (!omitGeo) all.push([33550, 12, 3, scaleOffset], [33922, 12, 6, tieOffset]);
  all.sort((a, b) => a[0] - b[0]);
  view.setUint16(8, all.length, le);
  all.forEach(([tag, type, count, value], i) => {
    const e = 10 + i * 12;
    view.setUint16(e, tag, le);
    view.setUint16(e + 2, type, le);
    view.setUint32(e + 4, count, le);
    if (type === 3) view.setUint16(e + 8, value, le);
    else view.setUint32(e + 8, value, le);
  });
  if (!omitGeo) {
    [dLon, 0.5, 0].forEach((v, i) => view.setFloat64(scaleOffset + i * 8, v, le));
    tiePoint.forEach((v, i) => view.setFloat64(tieOffset + i * 8, v, le));
  }
  values.slice(0, width * height).forEach((v, i) => {
    const o = dataOffset + i * 4;
    if (o + 4 <= total) view.setFloat32(o, v, le);
  });
  return new Uint8Array(buf);
}

describe('parseFloat32Tiff', () => {
  it('decodes the live HRDPS speed grid (45×60, two strips, LE)', () => {
    const grid = parseFloat32Tiff(fixture('wcs-hrdps-wspd.tif'));
    expect(grid).not.toBeNull();
    expect(grid?.width).toBe(45);
    expect(grid?.height).toBe(60);
    expect(grid?.data).toHaveLength(45 * 60);
    // Georeferencing: subset lat(46,48) long(−72,−70) → NW corner (−72, 48).
    expect(grid?.lon0).toBeCloseTo(-72, 5);
    expect(grid?.lat0).toBeCloseTo(48, 5);
    expect((grid?.dLon ?? 0) * 45).toBeCloseTo(2, 3);
    expect((grid?.dLat ?? 0) * 60).toBeCloseTo(2, 3);
    // Values are wind speeds in m/s — sane range, all finite.
    for (const v of grid?.data ?? []) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(100);
    }
  });

  it('decodes the live HRDPS direction grid with degree-ranged values', () => {
    const grid = parseFloat32Tiff(fixture('wcs-hrdps-wd.tif'));
    expect(grid).not.toBeNull();
    for (const v of grid?.data ?? []) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(360);
    }
  });

  it('decodes the live HRDPS WEonG gust grid on the same raster as speed', () => {
    const speed = parseFloat32Tiff(fixture('wcs-hrdps-wspd.tif'));
    const gust = parseFloat32Tiff(fixture('wcs-hrdps-gust.tif'));
    expect(gust?.width).toBe(speed?.width);
    expect(gust?.height).toBe(speed?.height);
    expect(gust?.lon0).toBeCloseTo(speed?.lon0 ?? NaN, 6);
    expect(gust?.dLon).toBeCloseTo(speed?.dLon ?? NaN, 9);
  });

  it('decodes the live RDPS grid (single strip, inline strip tags)', () => {
    const grid = parseFloat32Tiff(fixture('wcs-rdps-wspd.tif'));
    expect(grid).not.toBeNull();
    expect(grid?.width).toBe(6);
    expect(grid?.height).toBe(22);
    expect(grid?.lon0).toBeCloseTo(-72, 5);
    expect(grid?.lat0).toBeCloseTo(48, 5);
  });

  it('decodes a synthetic minimal grid, row-major from the north edge', () => {
    const grid = parseFloat32Tiff(syntheticTiff({ values: [1.5, 2.5, 3.5, 4.5] }));
    expect(grid).not.toBeNull();
    expect(Array.from(grid?.data ?? [])).toEqual([1.5, 2.5, 3.5, 4.5]);
    expect(grid?.lon0).toBe(-72);
    expect(grid?.lat0).toBe(48);
    expect(grid?.dLon).toBe(0.5);
  });

  it('decodes big-endian files (byte order honoured end-to-end)', () => {
    const grid = parseFloat32Tiff(syntheticTiff({ bigEndian: true, values: [9, 8, 7, 6] }));
    expect(Array.from(grid?.data ?? [])).toEqual([9, 8, 7, 6]);
  });

  it('normalizes a non-zero tiepoint raster anchor back to pixel (0,0)', () => {
    const grid = parseFloat32Tiff(syntheticTiff({ tiePoint: [1, 1, 0, -72, 48, 0] }));
    expect(grid?.lon0).toBeCloseTo(-72.5);
    expect(grid?.lat0).toBeCloseTo(48.5);
  });

  it('rejects an XML ServiceException body (bad TIME answers are XML)', () => {
    const xml = new TextEncoder().encode(
      '<?xml version="1.0"?><ServiceExceptionReport>time out of range</ServiceExceptionReport>',
    );
    expect(parseFloat32Tiff(xml)).toBeNull();
  });

  it.each([
    ['empty', new Uint8Array(0)],
    ['tiny junk', new Uint8Array([0x49, 0x49, 42, 0])],
    ['wrong magic', syntheticTiff({}).map((b, i) => (i === 2 ? 43 : b))],
  ])('rejects %s input', (_name, bytes) => {
    expect(parseFloat32Tiff(new Uint8Array(bytes))).toBeNull();
  });

  it.each([
    ['8-bit samples', { bits: 8 }],
    ['compressed data', { compression: 5 }],
    ['multi-band', { samplesPerPixel: 3 }],
    ['integer samples', { sampleFormat: 1 }],
    ['missing georeferencing', { omitGeo: true }],
    ['zero pixel scale', { dLon: 0 }],
    ['truncated pixel data', { truncateData: true }],
    ['zero width', { width: 0 }],
  ])('rejects %s', (_name, opts) => {
    expect(parseFloat32Tiff(syntheticTiff(opts))).toBeNull();
  });

  it('rejects grids larger than the pixel cap', () => {
    // Claimed dims are huge; the strip data doesn't match, but the dimension
    // gate fires first — no allocation happens.
    expect(parseFloat32Tiff(syntheticTiff({ width: 4096, height: 4096 }))).toBeNull();
  });
});
