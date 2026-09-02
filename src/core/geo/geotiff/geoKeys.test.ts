import {
  readTiffHeader,
  readTiffIfd,
  TIFF_TYPE_ASCII,
  TIFF_TYPE_SHORT,
  tiffWindow,
  type TiffEntry,
  type TiffWindow,
} from '@core/geo/tiff/container';
import {
  epsgFromGeoKeys,
  KEY_GEOGRAPHIC_TYPE,
  KEY_GT_MODEL_TYPE,
  KEY_PROJECTED_CS_TYPE,
  readGeoKeys,
  TAG_GEO_ASCII_PARAMS,
  TAG_GEO_KEY_DIRECTORY,
} from './geoKeys';
import { buildPaletteGeoTiff } from './testUtils';

/** A window + entries holding just a hand-built key directory (and citations). */
function keysFrom(
  directory: number[],
  ascii?: string,
): { win: TiffWindow; entries: Map<number, TiffEntry> } {
  const asciiBytes = ascii === undefined ? [] : [...ascii].map((c) => c.charCodeAt(0));
  const dirBytes = directory.length * 2;
  const bytes = new Uint8Array(dirBytes + asciiBytes.length);
  const view = new DataView(bytes.buffer);
  directory.forEach((v, i) => view.setUint16(i * 2, v, true));
  asciiBytes.forEach((v, i) => view.setUint8(dirBytes + i, v));
  const win = tiffWindow(bytes, 0, true);
  const entries = new Map<number, TiffEntry>([
    [
      TAG_GEO_KEY_DIRECTORY,
      {
        tag: TAG_GEO_KEY_DIRECTORY,
        type: TIFF_TYPE_SHORT,
        count: directory.length,
        valueOffset: 0,
      },
    ],
  ]);
  if (ascii !== undefined) {
    entries.set(TAG_GEO_ASCII_PARAMS, {
      tag: TAG_GEO_ASCII_PARAMS,
      type: TIFF_TYPE_ASCII,
      count: asciiBytes.length,
      valueOffset: dirBytes,
    });
  }
  return { win, entries };
}

describe('readGeoKeys', () => {
  it('reads the keys a CanMatrix scan carries', () => {
    const bytes = buildPaletteGeoTiff({ projectedEpsg: 26919 });
    const header = readTiffHeader(bytes)!;
    const win = tiffWindow(bytes, 0, header.le);
    const keys = readGeoKeys(win, readTiffIfd(win, header.ifdOffset)!);
    expect(keys.modelType).toBe(1); // projected
    expect(keys.projectedEpsg).toBe(26919);
    expect(epsgFromGeoKeys(keys)).toBe(26919);
  });

  it('falls back to the geographic CRS when there is no projected one', () => {
    const { win, entries } = keysFrom([1, 1, 0, 1, KEY_GEOGRAPHIC_TYPE, 0, 1, 4269]);
    expect(epsgFromGeoKeys(readGeoKeys(win, entries))).toBe(4269);
  });

  it('treats "user-defined" (32767) and 0 as no CRS at all', () => {
    const userDefined = keysFrom([1, 1, 0, 1, KEY_PROJECTED_CS_TYPE, 0, 1, 32767]);
    expect(epsgFromGeoKeys(readGeoKeys(userDefined.win, userDefined.entries))).toBeUndefined();
    const undef = keysFrom([1, 1, 0, 1, KEY_PROJECTED_CS_TYPE, 0, 1, 0]);
    expect(epsgFromGeoKeys(readGeoKeys(undef.win, undef.entries))).toBeUndefined();
  });

  it('slices citations out of the ASCII parameter blob, trimming the separator', () => {
    const { win, entries } = keysFrom(
      [1, 1, 0, 2, 1026, TAG_GEO_ASCII_PARAMS, 8, 0, 2049, TAG_GEO_ASCII_PARAMS, 6, 8],
      'unnamed|NAD83|',
    );
    expect(readGeoKeys(win, entries).citation).toBe('unnamed | NAD83');
  });

  it('returns nothing rather than throwing on a malformed directory', () => {
    const truncated = keysFrom([1, 1]);
    expect(readGeoKeys(truncated.win, truncated.entries)).toEqual({});
    // keyCount claims more keys than the array holds.
    const short = keysFrom([1, 1, 0, 9, KEY_GT_MODEL_TYPE, 0, 1, 1]);
    expect(readGeoKeys(short.win, short.entries)).toEqual({});
  });

  it('is empty for a TIFF with no key directory', () => {
    const { win } = keysFrom([1, 1, 0, 0]);
    expect(readGeoKeys(win, new Map())).toEqual({});
  });
});
