/**
 * A tiny TIFF writer, for tests only.
 *
 * Builds files in the shape NRCan's CanMatrix scans actually have — classic
 * little-endian, uncompressed, one row per strip, the image data first and the
 * IFD **last** — so the decoder is exercised against the layout it will meet,
 * including the "IFD at the far end of the file" that forces the windowed
 * reader in `@core/geo/tiff/container`.
 */
import {
  TIFF_TYPE_ASCII,
  TIFF_TYPE_DOUBLE,
  TIFF_TYPE_LONG,
  TIFF_TYPE_SHORT,
  tiffTypeSize,
} from '@core/geo/tiff/container';

interface TiffTag {
  tag: number;
  type: number;
  values: number[];
}

/** Serialize tags + pixel data into a classic TIFF with the IFD at the end. */
function writeTiff(
  tags: TiffTag[],
  data: Uint8Array,
  /** Called with the absolute offset the pixel data landed at. */
  patchOffsets: (dataOffset: number) => void,
  le: boolean,
): Uint8Array {
  const dataOffset = 8;
  const sorted = [...tags].sort((a, b) => a.tag - b.tag);
  patchOffsets(dataOffset);

  // Pixel data, then the directory, then the values it points at — the layout
  // libtiff writes and the one every CanMatrix sheet has. It is what makes the
  // header readable from the file's tail alone.
  const rawIfd = dataOffset + data.length;
  const ifdOffset = rawIfd % 2 === 1 ? rawIfd + 1 : rawIfd;
  let cursor = ifdOffset + 2 + sorted.length * 12 + 4;
  const outOfLine = new Map<number, number>();
  for (const t of sorted) {
    const size = tiffTypeSize(t.type) ?? 1;
    if (size * t.values.length <= 4) continue;
    if (cursor % 2 === 1) cursor += 1;
    outOfLine.set(t.tag, cursor);
    cursor += size * t.values.length;
  }
  const total = cursor;

  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, le ? 0x49 : 0x4d);
  view.setUint8(1, le ? 0x49 : 0x4d);
  view.setUint16(2, 42, le);
  view.setUint32(4, ifdOffset, le);
  bytes.set(data, dataOffset);

  const writeValues = (at: number, t: TiffTag): void => {
    const size = tiffTypeSize(t.type) ?? 1;
    t.values.forEach((v, i) => {
      const o = at + i * size;
      if (t.type === TIFF_TYPE_SHORT) view.setUint16(o, v, le);
      else if (t.type === TIFF_TYPE_LONG) view.setUint32(o, v, le);
      else if (t.type === TIFF_TYPE_DOUBLE) view.setFloat64(o, v, le);
      else view.setUint8(o, v);
    });
  };

  for (const t of sorted) {
    const at = outOfLine.get(t.tag);
    if (at !== undefined) writeValues(at, t);
  }

  view.setUint16(ifdOffset, sorted.length, le);
  sorted.forEach((t, i) => {
    const e = ifdOffset + 2 + i * 12;
    view.setUint16(e, t.tag, le);
    view.setUint16(e + 2, t.type, le);
    view.setUint32(e + 4, t.values.length, le);
    const at = outOfLine.get(t.tag);
    if (at !== undefined) view.setUint32(e + 8, at, le);
    else writeValues(e + 8, t);
  });
  view.setUint32(ifdOffset + 2 + sorted.length * 12, 0, le);
  return bytes;
}

export interface PaletteTiffOptions {
  width?: number;
  height?: number;
  /** Palette indexes, row-major, `width * height` of them. */
  pixels?: number[];
  /** 256 RGB triples, 8-bit each; defaults to a greyscale ramp. */
  palette?: [number, number, number][];
  /** ModelPixelScale x/y and the top-left ModelTiepoint. */
  pixelScale?: number;
  tiePoint?: [number, number];
  /** ProjectedCSTypeGeoKey; omit for a file with no GeoTIFF keys. */
  projectedEpsg?: number | null;
  compression?: number;
  photometric?: number;
  samplesPerPixel?: number;
  bitsPerSample?: number;
  rowsPerStrip?: number;
  littleEndian?: boolean;
}

/**
 * A CanMatrix-shaped palette GeoTIFF: 8-bit, uncompressed, one row per strip,
 * NAD83 / UTM zone 19N by default (the Québec City sheet's CRS).
 */
export function buildPaletteGeoTiff(options: PaletteTiffOptions = {}): Uint8Array {
  const {
    width = 4,
    height = 3,
    palette,
    pixelScale = 10,
    tiePoint = [300000, 5200000],
    projectedEpsg = 26919,
    compression = 1,
    photometric = 3,
    samplesPerPixel = 1,
    bitsPerSample = 8,
    rowsPerStrip = 1,
    littleEndian = true,
  } = options;

  const rowBytes = width * samplesPerPixel * (bitsPerSample / 8);
  const pixels =
    options.pixels ?? Array.from({ length: width * height * samplesPerPixel }, (_, i) => i % 256);
  const data = new Uint8Array(rowBytes * height);
  data.set(pixels.slice(0, data.length));

  const stripCount = Math.ceil(height / rowsPerStrip);
  const stripOffsets = new Array<number>(stripCount).fill(0);
  const stripByteCounts = Array.from(
    { length: stripCount },
    (_, s) => Math.min(rowsPerStrip, height - s * rowsPerStrip) * rowBytes,
  );

  const colorMap: number[] = [];
  if (photometric === 3) {
    const table =
      palette ??
      Array.from(
        { length: 1 << bitsPerSample },
        (_, i) => [i, 255 - i, (i * 3) % 256] as [number, number, number],
      );
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < 1 << bitsPerSample; i++) {
        colorMap.push(((table[i]?.[c] ?? 0) << 8) | (table[i]?.[c] ?? 0));
      }
    }
  }

  const tags: TiffTag[] = [
    { tag: 256, type: TIFF_TYPE_SHORT, values: [width] },
    { tag: 257, type: TIFF_TYPE_SHORT, values: [height] },
    { tag: 258, type: TIFF_TYPE_SHORT, values: [bitsPerSample] },
    { tag: 259, type: TIFF_TYPE_SHORT, values: [compression] },
    { tag: 262, type: TIFF_TYPE_SHORT, values: [photometric] },
    { tag: 273, type: TIFF_TYPE_LONG, values: stripOffsets },
    { tag: 277, type: TIFF_TYPE_SHORT, values: [samplesPerPixel] },
    { tag: 278, type: TIFF_TYPE_SHORT, values: [rowsPerStrip] },
    { tag: 279, type: TIFF_TYPE_LONG, values: stripByteCounts },
    { tag: 284, type: TIFF_TYPE_SHORT, values: [1] },
    { tag: 33550, type: TIFF_TYPE_DOUBLE, values: [pixelScale, pixelScale, 0] },
    { tag: 33922, type: TIFF_TYPE_DOUBLE, values: [0, 0, 0, tiePoint[0], tiePoint[1], 0] },
  ];
  if (colorMap.length > 0) tags.push({ tag: 320, type: TIFF_TYPE_SHORT, values: colorMap });
  if (projectedEpsg !== null) {
    const citation = 'unnamed|NAD83|';
    tags.push({
      tag: 34735,
      type: TIFF_TYPE_SHORT,
      // header (1,1,0, keyCount) then 4 values per key
      values: [1, 1, 0, 3, 1024, 0, 1, 1, 1026, 34737, 8, 0, 3072, 0, 1, projectedEpsg],
    });
    tags.push({
      tag: 34737,
      type: TIFF_TYPE_ASCII,
      values: [...citation].map((c) => c.charCodeAt(0)),
    });
  }

  return writeTiff(
    tags,
    data,
    (dataOffset) => {
      for (let s = 0; s < stripCount; s++) {
        stripOffsets[s] = dataOffset + s * rowsPerStrip * rowBytes;
      }
    },
    littleEndian,
  );
}
