/**
 * Uncompressed raster GeoTIFF — header, layout and a row-at-a-time decoder.
 *
 * Built for NRCan's **CanMatrix** 1:50k scans, the only source of 1:50k
 * coverage for eastern Québec, the north and much of BC (CanTopo's modern
 * GeoPDFs simply do not exist there). Every sheet inspected is the same shape,
 * and that shape is what this module supports:
 *
 * ```
 * 11289 x 8183, 8 bit, 1 sample/pixel, palette colour (photometric 3)
 * Compression: none      RowsPerStrip: 1      300 dpi
 * ModelPixelScale 4.2334 m, ModelTiepoint at the top-left corner
 * ProjectedCSTypeGeoKey 269xx = NAD83 / UTM zone N
 * ```
 *
 * **Why "uncompressed only" is not a limitation here.** With no compression
 * and one row per strip, any single row of the image is a contiguous byte
 * range whose file offset is arithmetic — {@link rasterRowByteRange}. That is
 * what makes these sheets tractable on a phone: a 92 MB scan is never decoded,
 * or even read, whole. The overlay wants ~2048 px across, so the caller reads
 * roughly 1 row in 5 and 1 column in 5 and touches ~17 MB of the file in
 * ~1 500 small reads, holding only the output RGBA buffer (~12 MB).
 *
 * Nothing here throws on arbitrary bytes; an unsupported shape comes back as
 * `{ raster: null, warnings: [...] }` naming exactly what was wrong.
 */
import {
  readTiffIfd,
  readTiffScalar,
  readTiffValues,
  type TiffEntry,
  type TiffWindow,
} from '@core/geo/tiff/container';
import { epsgFromGeoKeys, readGeoKeys, type GeoKeys } from './geoKeys';

/* --------------------------------------------------------------- tags --- */

const TAG_WIDTH = 256;
const TAG_HEIGHT = 257;
const TAG_BITS_PER_SAMPLE = 258;
const TAG_COMPRESSION = 259;
const TAG_PHOTOMETRIC = 262;
const TAG_STRIP_OFFSETS = 273;
const TAG_SAMPLES_PER_PIXEL = 277;
const TAG_ROWS_PER_STRIP = 278;
const TAG_STRIP_BYTE_COUNTS = 279;
const TAG_PLANAR_CONFIG = 284;
const TAG_COLOR_MAP = 320;
const TAG_TILE_WIDTH = 322;
const TAG_MODEL_PIXEL_SCALE = 33550;
const TAG_MODEL_TIEPOINT = 33922;
const TAG_MODEL_TRANSFORMATION = 34264;

/** PhotometricInterpretation values this decoder understands. */
export const PHOTOMETRIC_WHITE_IS_ZERO = 0;
export const PHOTOMETRIC_BLACK_IS_ZERO = 1;
export const PHOTOMETRIC_RGB = 2;
export const PHOTOMETRIC_PALETTE = 3;

/** Refuse absurd dimensions long before allocating anything. */
const MAX_DIM = 100_000;

/* -------------------------------------------------------------- types --- */

/** An 8-bit RGB colour table, expanded from the TIFF's 16-bit ColorMap. */
export interface RasterPalette {
  r: Uint8Array;
  g: Uint8Array;
  b: Uint8Array;
}

/** North-up affine model of the raster, pixel-CORNER anchored at the top-left. */
export interface RasterModel {
  /** CRS x of the left edge of column 0. */
  x0: number;
  /** CRS y of the top edge of row 0. */
  y0: number;
  /** Pixel width in CRS units (positive). */
  dx: number;
  /** Pixel height in CRS units (positive; rows step −y). */
  dy: number;
}

/** Everything the decoder and the platform reader need about one sheet. */
export interface RasterGeoTiff {
  width: number;
  height: number;
  bitsPerSample: number;
  samplesPerPixel: number;
  photometric: number;
  /** Rows in each strip (the last strip may hold fewer). */
  rowsPerStrip: number;
  /** Absolute file offset of each strip's first byte. */
  stripOffsets: number[];
  /** Byte length of each strip. */
  stripByteCounts: number[];
  /** Present only for `photometric === PHOTOMETRIC_PALETTE`. */
  palette?: RasterPalette;
  model: RasterModel;
  /** EPSG of the raster's own CRS, when the GeoTIFF keys name one. */
  epsg?: number;
  geoKeys: GeoKeys;
}

export interface RasterGeoTiffParseResult {
  raster: RasterGeoTiff | null;
  warnings: string[];
}

/* ------------------------------------------------------------ georef ---- */

/** The affine model, from PixelScale+Tiepoint or a rotation-free matrix. */
function readModel(win: TiffWindow, entries: ReadonlyMap<number, TiffEntry>): RasterModel | null {
  const scaleEntry = entries.get(TAG_MODEL_PIXEL_SCALE);
  const tieEntry = entries.get(TAG_MODEL_TIEPOINT);
  if (scaleEntry !== undefined && tieEntry !== undefined) {
    const scale = readTiffValues(win, scaleEntry);
    const tie = readTiffValues(win, tieEntry);
    if (scale === null || tie === null || scale.length < 2 || tie.length < 6) return null;
    const [dx, dy] = scale;
    const [rasterI, rasterJ, , tieX, tieY] = tie;
    if (dx === undefined || dy === undefined) return null;
    if (rasterI === undefined || rasterJ === undefined) return null;
    if (tieX === undefined || tieY === undefined) return null;
    if (!(dx > 0) || !(dy > 0)) return null;
    return { x0: tieX - rasterI * dx, y0: tieY + rasterJ * dy, dx, dy };
  }
  const txEntry = entries.get(TAG_MODEL_TRANSFORMATION);
  if (txEntry !== undefined) {
    const m = readTiffValues(win, txEntry);
    if (m === null || m.length < 16) return null;
    const [a, b, , x0, c, e, , y0] = m;
    if (a === undefined || b === undefined || x0 === undefined) return null;
    if (c === undefined || e === undefined || y0 === undefined) return null;
    // North-up only: b and c are the rotation terms. A rotated scan would need
    // a full warp, not this affine row walk, so it is refused rather than
    // silently drawn crooked.
    if (b !== 0 || c !== 0) return null;
    if (!(a > 0) || !(e < 0)) return null;
    return { x0, y0, dx: a, dy: -e };
  }
  return null;
}

/** Expand the 16-bit ColorMap tag into three 8-bit channel tables. */
function readPalette(
  win: TiffWindow,
  entries: ReadonlyMap<number, TiffEntry>,
  bitsPerSample: number,
): RasterPalette | null {
  const entry = entries.get(TAG_COLOR_MAP);
  if (entry === undefined) return null;
  const values = readTiffValues(win, entry);
  if (values === null) return null;
  const levels = 1 << bitsPerSample;
  if (values.length < levels * 3) return null;
  const r = new Uint8Array(levels);
  const g = new Uint8Array(levels);
  const b = new Uint8Array(levels);
  // TIFF stores all reds, then all greens, then all blues, each 0..65535.
  for (let i = 0; i < levels; i++) {
    r[i] = (values[i] ?? 0) >> 8;
    g[i] = (values[levels + i] ?? 0) >> 8;
    b[i] = (values[levels * 2 + i] ?? 0) >> 8;
  }
  return { r, g, b };
}

/* --------------------------------------------------------------- parse --- */

/**
 * Parse a raster GeoTIFF's header from a window that covers its IFD (and the
 * out-of-line values the IFD points at — in practice the file's tail).
 *
 * Deliberately narrow: uncompressed, single-plane, 8-bit, strip-organized.
 * Everything else returns null with a warning naming the unsupported feature,
 * so the import surface can say *why* a file was refused instead of drawing
 * garbage.
 */
export function parseRasterGeoTiff(win: TiffWindow, ifdOffset: number): RasterGeoTiffParseResult {
  const warnings: string[] = [];
  const entries = readTiffIfd(win, ifdOffset);
  if (entries === null) return { raster: null, warnings: ['TIFF directory is unreadable'] };

  const width = readTiffScalar(win, entries, TAG_WIDTH);
  const height = readTiffScalar(win, entries, TAG_HEIGHT);
  if (width === null || height === null) {
    return { raster: null, warnings: ['TIFF has no image dimensions'] };
  }
  if (width < 1 || height < 1 || width > MAX_DIM || height > MAX_DIM) {
    return { raster: null, warnings: [`unusable image size ${width}x${height}`] };
  }

  const compression = readTiffScalar(win, entries, TAG_COMPRESSION) ?? 1;
  if (compression !== 1) {
    return {
      raster: null,
      warnings: [`compressed TIFF (compression ${compression}) is not supported`],
    };
  }
  if (entries.has(TAG_TILE_WIDTH)) {
    return { raster: null, warnings: ['tiled TIFFs are not supported'] };
  }
  const planar = readTiffScalar(win, entries, TAG_PLANAR_CONFIG) ?? 1;
  if (planar !== 1) {
    return { raster: null, warnings: [`planar configuration ${planar} is not supported`] };
  }

  // BitsPerSample is one value per sample; all samples must share a width.
  const bitsEntry = entries.get(TAG_BITS_PER_SAMPLE);
  const bitsValues = bitsEntry !== undefined ? readTiffValues(win, bitsEntry) : null;
  const bitsPerSample = bitsValues !== null && bitsValues.length > 0 ? (bitsValues[0] ?? 1) : 1;
  if (bitsValues !== null && bitsValues.some((b) => b !== bitsPerSample)) {
    return { raster: null, warnings: ['mixed sample widths are not supported'] };
  }
  if (bitsPerSample !== 8) {
    return { raster: null, warnings: [`${bitsPerSample}-bit samples are not supported`] };
  }

  const samplesPerPixel = readTiffScalar(win, entries, TAG_SAMPLES_PER_PIXEL) ?? 1;
  if (samplesPerPixel < 1 || samplesPerPixel > 4) {
    return { raster: null, warnings: [`${samplesPerPixel} samples per pixel is not supported`] };
  }

  const photometric = readTiffScalar(win, entries, TAG_PHOTOMETRIC) ?? PHOTOMETRIC_BLACK_IS_ZERO;
  let palette: RasterPalette | undefined;
  if (photometric === PHOTOMETRIC_PALETTE) {
    if (samplesPerPixel !== 1) {
      return { raster: null, warnings: ['palette TIFF with more than one sample per pixel'] };
    }
    const table = readPalette(win, entries, bitsPerSample);
    if (table === null)
      return { raster: null, warnings: ['palette TIFF without a usable ColorMap'] };
    palette = table;
  } else if (photometric === PHOTOMETRIC_RGB) {
    if (samplesPerPixel < 3) {
      return { raster: null, warnings: ['RGB TIFF with fewer than three samples per pixel'] };
    }
  } else if (
    photometric !== PHOTOMETRIC_BLACK_IS_ZERO &&
    photometric !== PHOTOMETRIC_WHITE_IS_ZERO
  ) {
    return {
      raster: null,
      warnings: [`photometric interpretation ${photometric} is not supported`],
    };
  }

  const rowsPerStrip = readTiffScalar(win, entries, TAG_ROWS_PER_STRIP) ?? height;
  if (rowsPerStrip < 1) return { raster: null, warnings: ['RowsPerStrip is not positive'] };

  const offsetsEntry = entries.get(TAG_STRIP_OFFSETS);
  const countsEntry = entries.get(TAG_STRIP_BYTE_COUNTS);
  if (offsetsEntry === undefined || countsEntry === undefined) {
    return { raster: null, warnings: ['TIFF has no strip offsets'] };
  }
  const stripOffsets = readTiffValues(win, offsetsEntry);
  const stripByteCounts = readTiffValues(win, countsEntry);
  if (stripOffsets === null || stripByteCounts === null) {
    return { raster: null, warnings: ['strip offsets are unreadable'] };
  }
  const stripCount = Math.ceil(height / rowsPerStrip);
  if (stripOffsets.length !== stripCount || stripByteCounts.length !== stripCount) {
    return { raster: null, warnings: ['strip offset table does not match the image height'] };
  }

  const model = readModel(win, entries);
  if (model === null) {
    return { raster: null, warnings: ['TIFF carries no usable north-up georeferencing'] };
  }
  if (!Number.isFinite(model.x0) || !Number.isFinite(model.y0)) {
    return { raster: null, warnings: ['TIFF tiepoint is not finite'] };
  }

  const geoKeys = readGeoKeys(win, entries);
  const epsg = epsgFromGeoKeys(geoKeys);
  if (epsg === undefined) warnings.push('TIFF names no EPSG code — assuming lon/lat');

  return {
    raster: {
      width,
      height,
      bitsPerSample,
      samplesPerPixel,
      photometric,
      rowsPerStrip,
      stripOffsets,
      stripByteCounts,
      ...(palette !== undefined ? { palette } : {}),
      model,
      ...(epsg !== undefined ? { epsg } : {}),
      geoKeys,
    },
    warnings,
  };
}

/* ---------------------------------------------------------- byte ranges --- */

/** Bytes one image row occupies. */
export function rasterRowBytes(raster: RasterGeoTiff): number {
  return raster.width * raster.samplesPerPixel * (raster.bitsPerSample / 8);
}

/**
 * Absolute file byte range of one image row — the whole point of the
 * "uncompressed, single-plane" gate above. Null for a row outside the image or
 * whose strip table is inconsistent.
 */
export function rasterRowByteRange(
  raster: RasterGeoTiff,
  row: number,
): { offset: number; length: number } | null {
  if (!Number.isInteger(row) || row < 0 || row >= raster.height) return null;
  const strip = Math.floor(row / raster.rowsPerStrip);
  const stripOffset = raster.stripOffsets[strip];
  const stripBytes = raster.stripByteCounts[strip];
  if (stripOffset === undefined || stripBytes === undefined) return null;
  const rowBytes = rasterRowBytes(raster);
  const within = (row % raster.rowsPerStrip) * rowBytes;
  if (within + rowBytes > stripBytes) return null;
  return { offset: stripOffset + within, length: rowBytes };
}

/* ------------------------------------------------------------- sampling --- */

/** A pixel rectangle of the source image: `[x, y]` inclusive, size in pixels. */
export interface RasterCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The whole image as a crop. */
export function fullRasterCrop(raster: { width: number; height: number }): RasterCrop {
  return { x: 0, y: 0, width: raster.width, height: raster.height };
}

/**
 * A nearest-neighbour downscale plan: which source row feeds each output row,
 * and which source column feeds each output column. Precomputed so the decode
 * loop is a table lookup per pixel and the reader knows the exact set of rows
 * it must fetch (in ascending order — one forward pass over the file).
 *
 * `srcRows`/`srcCols` are ABSOLUTE source coordinates, crop offset included,
 * so a caller reading rows and a caller masking against a projected polygon
 * both speak the same coordinate system.
 */
export interface RasterSamplePlan {
  outWidth: number;
  outHeight: number;
  /** Source row for each output row, ascending. */
  srcRows: Int32Array;
  /** Source column for each output column, ascending. */
  srcCols: Int32Array;
}

/**
 * Plan a downscale of `crop` to at most `targetWidthPx` across, preserving
 * aspect. The source is never upscaled: a crop narrower than the target
 * renders 1:1.
 */
export function planRasterDownscale(
  crop: RasterCrop,
  targetWidthPx: number,
): RasterSamplePlan | null {
  const { x, y, width, height } = crop;
  if (![x, y, width, height, targetWidthPx].every((v) => Number.isFinite(v))) return null;
  if (width < 1 || height < 1 || targetWidthPx < 1) return null;
  const outWidth = Math.max(1, Math.min(Math.floor(targetWidthPx), Math.floor(width)));
  const outHeight = Math.max(1, Math.round((outWidth * height) / width));
  const srcCols = new Int32Array(outWidth);
  for (let i = 0; i < outWidth; i++) {
    // Sample the CENTRE of the output pixel's footprint, so the plan is
    // symmetric and the last column is not clipped off the right edge.
    srcCols[i] = x + Math.min(width - 1, Math.floor(((i + 0.5) * width) / outWidth));
  }
  const srcRows = new Int32Array(outHeight);
  for (let j = 0; j < outHeight; j++) {
    srcRows[j] = y + Math.min(height - 1, Math.floor(((j + 0.5) * height) / outHeight));
  }
  return { outWidth, outHeight, srcRows, srcCols };
}

/**
 * Decode one source row's bytes into one output row of RGBA, sampling the
 * columns the plan asks for. `out` is the whole `outWidth * outHeight * 4`
 * buffer; only row `outRow` is written. Pixels are fully opaque — masking is
 * the caller's job (see {@link maskRgbaOutsidePolygon}).
 */
export function decodeRasterRowToRgba(
  raster: RasterGeoTiff,
  plan: RasterSamplePlan,
  rowBytes: Uint8Array,
  outRow: number,
  out: Uint8Array,
): void {
  if (outRow < 0 || outRow >= plan.outHeight) return;
  const spp = raster.samplesPerPixel;
  const { palette, photometric } = raster;
  let o = outRow * plan.outWidth * 4;
  for (let x = 0; x < plan.outWidth; x++) {
    const col = plan.srcCols[x] ?? 0;
    const at = col * spp;
    let r = 0;
    let g = 0;
    let b = 0;
    if (photometric === PHOTOMETRIC_PALETTE && palette !== undefined) {
      const index = rowBytes[at] ?? 0;
      r = palette.r[index] ?? 0;
      g = palette.g[index] ?? 0;
      b = palette.b[index] ?? 0;
    } else if (photometric === PHOTOMETRIC_RGB) {
      r = rowBytes[at] ?? 0;
      g = rowBytes[at + 1] ?? 0;
      b = rowBytes[at + 2] ?? 0;
    } else {
      const v = rowBytes[at] ?? 0;
      const grey = photometric === PHOTOMETRIC_WHITE_IS_ZERO ? 255 - v : v;
      r = grey;
      g = grey;
      b = grey;
    }
    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
    out[o + 3] = 255;
    o += 4;
  }
}
