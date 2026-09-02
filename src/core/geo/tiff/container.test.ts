import { buildPaletteGeoTiff } from '../geotiff/testUtils';
import {
  readTiffAscii,
  readTiffHeader,
  readTiffIfd,
  readTiffScalar,
  readTiffValues,
  tiffTypeSize,
  tiffWindow,
} from './container';

const bytes = buildPaletteGeoTiff();

describe('readTiffHeader', () => {
  it('reads a little-endian classic TIFF', () => {
    expect(readTiffHeader(bytes)).toEqual({ le: true, ifdOffset: expect.any(Number) });
  });

  it('reads big-endian too', () => {
    const be = buildPaletteGeoTiff({ littleEndian: false });
    expect(readTiffHeader(be)?.le).toBe(false);
  });

  it('rejects non-TIFF bytes rather than throwing', () => {
    expect(readTiffHeader(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 0, 0, 0]))).toBeNull();
    expect(readTiffHeader(new Uint8Array(3))).toBeNull();
  });

  it('rejects BigTIFF (version 43), whose offsets are 64-bit', () => {
    const big = new Uint8Array(8);
    big.set([0x49, 0x49, 43, 0, 8, 0, 0, 0]);
    expect(readTiffHeader(big)).toBeNull();
  });
});

describe('tiffTypeSize', () => {
  it('sizes the types a GeoTIFF uses', () => {
    expect(tiffTypeSize(1)).toBe(1);
    expect(tiffTypeSize(3)).toBe(2);
    expect(tiffTypeSize(4)).toBe(4);
    expect(tiffTypeSize(12)).toBe(8);
    expect(tiffTypeSize(999)).toBeNull();
  });
});

describe('readTiffIfd over a WINDOW', () => {
  // The point of the windowed API: these files put the IFD at the very end, so
  // a phone reads the first 8 bytes and then only the tail.
  const header = readTiffHeader(bytes)!;
  const tail = bytes.slice(header.ifdOffset);
  const win = tiffWindow(tail, header.ifdOffset, header.le);

  it('reads every tag from the tail alone', () => {
    const entries = readTiffIfd(win, header.ifdOffset)!;
    expect(entries.get(256)?.count).toBe(1);
    expect(readTiffScalar(win, entries, 256)).toBe(4); // width
    expect(readTiffScalar(win, entries, 257)).toBe(3); // height
    expect(readTiffScalar(win, entries, 262)).toBe(3); // palette
  });

  it('reads DOUBLE arrays that live outside the directory', () => {
    const entries = readTiffIfd(win, header.ifdOffset)!;
    expect(readTiffValues(win, entries.get(33550)!)).toEqual([10, 10, 0]);
    expect(readTiffValues(win, entries.get(33922)!)).toEqual([0, 0, 0, 300000, 5200000, 0]);
  });

  it('reads ASCII citations with the NULs stripped', () => {
    const entries = readTiffIfd(win, header.ifdOffset)!;
    expect(readTiffAscii(win, entries.get(34737)!)).toBe('unnamed|NAD83|');
  });

  it('returns null for values the window does not cover', () => {
    // A window that starts AFTER the pixel data still cannot reach into it.
    const entries = readTiffIfd(win, header.ifdOffset)!;
    const stripOffsets = entries.get(273)!;
    const narrow = tiffWindow(tail, header.ifdOffset, header.le);
    expect(readTiffValues(narrow, { ...stripOffsets, valueOffset: 0 })).toBeNull();
  });

  it('returns null when the directory itself is outside the window', () => {
    expect(readTiffIfd(win, header.ifdOffset + 10_000)).toBeNull();
  });
});

describe('readTiffValues', () => {
  const header = readTiffHeader(bytes)!;
  const win = tiffWindow(bytes, 0, header.le);
  const entries = readTiffIfd(win, header.ifdOffset)!;

  it('reads inline SHORT values (4 bytes or fewer live in the entry)', () => {
    expect(readTiffValues(win, entries.get(258)!)).toEqual([8]);
  });

  it('reads out-of-line LONG arrays', () => {
    const offsets = readTiffValues(win, entries.get(273)!)!;
    expect(offsets).toHaveLength(3);
    expect(offsets[1]! - offsets[0]!).toBe(4); // one 4-byte row per strip
  });

  it('refuses a type it cannot size', () => {
    expect(readTiffValues(win, { tag: 1, type: 77, count: 1, valueOffset: 0 })).toBeNull();
  });
});

describe('readTiffValues — every field type a TIFF may use', () => {
  // Tags a scan carries beyond the ones we act on (Resolution is RATIONAL,
  // DateTime is ASCII) must read without throwing, or a stray tag would take
  // the whole directory down.
  const raw = new Uint8Array(64);
  const view = new DataView(raw.buffer);
  const win = tiffWindow(raw, 0, true);

  it('reads signed and unsigned integers of every width', () => {
    view.setInt8(0, -5);
    view.setInt16(2, -300, true);
    view.setInt32(4, -70000, true);
    expect(readTiffValues(win, { tag: 1, type: 6, count: 1, valueOffset: 0 })).toEqual([-5]);
    expect(readTiffValues(win, { tag: 1, type: 8, count: 1, valueOffset: 2 })).toEqual([-300]);
    expect(readTiffValues(win, { tag: 1, type: 9, count: 1, valueOffset: 4 })).toEqual([-70000]);
    view.setUint8(0, 200);
    expect(readTiffValues(win, { tag: 1, type: 1, count: 1, valueOffset: 0 })).toEqual([200]);
    expect(readTiffValues(win, { tag: 1, type: 7, count: 1, valueOffset: 0 })).toEqual([200]);
  });

  it('reads FLOAT', () => {
    view.setFloat32(8, 1.5, true);
    expect(readTiffValues(win, { tag: 1, type: 11, count: 1, valueOffset: 8 })).toEqual([1.5]);
  });

  it('collapses RATIONAL to its quotient, and a zero denominator to 0', () => {
    view.setUint32(16, 300, true);
    view.setUint32(20, 1, true);
    expect(readTiffValues(win, { tag: 282, type: 5, count: 1, valueOffset: 16 })).toEqual([300]);
    view.setUint32(20, 0, true);
    expect(readTiffValues(win, { tag: 282, type: 5, count: 1, valueOffset: 16 })).toEqual([0]);
    view.setInt32(24, -7, true);
    view.setInt32(28, 2, true);
    expect(readTiffValues(win, { tag: 1, type: 10, count: 1, valueOffset: 24 })).toEqual([-3.5]);
    view.setInt32(28, 0, true);
    expect(readTiffValues(win, { tag: 1, type: 10, count: 1, valueOffset: 24 })).toEqual([0]);
  });

  it('returns null when the values would run off the end of the window', () => {
    expect(readTiffValues(win, { tag: 1, type: 12, count: 100, valueOffset: 0 })).toBeNull();
  });
});
