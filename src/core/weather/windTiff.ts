/**
 * Minimal single-band float32 GeoTIFF parser for GeoMet WCS GetCoverage
 * responses (weather M3 wind fields). NOT a general TIFF reader — it decodes
 * exactly the shape GeoMet serves (verified live 2026-08-09 for all nine
 * HRDPS/RDPS/GDPS speed/direction/gust coverages):
 *
 * - classic TIFF (magic 42), little- or big-endian (GeoMet emits LE);
 * - one image (first IFD only), one sample per pixel;
 * - 32-bit IEEE-float samples (`BitsPerSample` 32, `SampleFormat` 3);
 * - no compression, strip-organized (`RowsPerStrip` + offsets/byte counts,
 *   SHORT or LONG, inline or out-of-line arrays);
 * - georeferencing from `ModelPixelScale` + a single (0,0) `ModelTiepoint`
 *   in EPSG:4326 — row 0 is the NORTH edge, latitude decreases with row.
 *
 * Anything outside those assumptions returns null: callers treat a null as
 * "no wind field" and degrade to the gradient drape (GeoMet answers bad TIME
 * values with an XML ServiceException body, which fails the magic check).
 */

export interface WindGrid {
  /** Grid width in pixels (columns, west → east). */
  width: number;
  /** Grid height in pixels (rows, north → south). */
  height: number;
  /** Row-major samples; row 0 is the northernmost. */
  data: Float32Array;
  /** Longitude of the grid's west edge (tiepoint, degrees). */
  lon0: number;
  /** Latitude of the grid's NORTH edge (tiepoint, degrees). */
  lat0: number;
  /** Pixel width in degrees longitude (positive). */
  dLon: number;
  /** Pixel height in degrees latitude (positive; rows go south). */
  dLat: number;
}

/** Upper bound on grid pixels — a viewport subset is ~45×60, never megapixels. */
const MAX_PIXELS = 1 << 21;
const MAX_DIM = 4096;

// TIFF tag ids (only the ones the GeoMet shape needs).
const TAG_WIDTH = 256;
const TAG_HEIGHT = 257;
const TAG_BITS_PER_SAMPLE = 258;
const TAG_COMPRESSION = 259;
const TAG_STRIP_OFFSETS = 273;
const TAG_SAMPLES_PER_PIXEL = 277;
const TAG_ROWS_PER_STRIP = 278;
const TAG_STRIP_BYTE_COUNTS = 279;
const TAG_SAMPLE_FORMAT = 339;
const TAG_MODEL_PIXEL_SCALE = 33550;
const TAG_MODEL_TIEPOINT = 33922;

// TIFF field types.
const TYPE_SHORT = 3;
const TYPE_LONG = 4;
const TYPE_DOUBLE = 12;

const TYPE_SIZE: Record<number, number> = { [TYPE_SHORT]: 2, [TYPE_LONG]: 4, [TYPE_DOUBLE]: 8 };

interface TiffEntry {
  type: number;
  count: number;
  /** Byte offset of the value data (inline in the IFD or pointed-to). */
  valueOffset: number;
}

/** Read a tag's numeric values (SHORT/LONG/DOUBLE), or null on junk. */
function readValues(view: DataView, entry: TiffEntry, le: boolean): number[] | null {
  const size = TYPE_SIZE[entry.type];
  if (size === undefined) return null;
  const total = size * entry.count;
  if (entry.valueOffset + total > view.byteLength) return null;
  const out: number[] = [];
  for (let i = 0; i < entry.count; i++) {
    const o = entry.valueOffset + i * size;
    if (entry.type === TYPE_SHORT) out.push(view.getUint16(o, le));
    else if (entry.type === TYPE_LONG) out.push(view.getUint32(o, le));
    else out.push(view.getFloat64(o, le));
  }
  return out;
}

/**
 * Parse a GeoMet WCS float32 single-band GeoTIFF. Null on anything that
 * violates the documented shape — never throws on arbitrary bytes.
 */
export function parseFloat32Tiff(bytes: Uint8Array): WindGrid | null {
  if (bytes.byteLength < 8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const b0 = view.getUint8(0);
  const b1 = view.getUint8(1);
  let le: boolean;
  if (b0 === 0x49 && b1 === 0x49) le = true;
  else if (b0 === 0x4d && b1 === 0x4d) le = false;
  else return null;
  if (view.getUint16(2, le) !== 42) return null;

  const ifdOffset = view.getUint32(4, le);
  if (ifdOffset + 2 > view.byteLength) return null;
  const entryCount = view.getUint16(ifdOffset, le);
  if (ifdOffset + 2 + entryCount * 12 > view.byteLength) return null;

  const entries = new Map<number, TiffEntry>();
  for (let i = 0; i < entryCount; i++) {
    const e = ifdOffset + 2 + i * 12;
    const tag = view.getUint16(e, le);
    const type = view.getUint16(e + 2, le);
    const count = view.getUint32(e + 4, le);
    const size = TYPE_SIZE[type];
    // Unknown types are skipped (ASCII/RATIONAL tags exist but aren't needed).
    if (size === undefined) continue;
    const inline = size * count <= 4;
    const valueOffset = inline ? e + 8 : view.getUint32(e + 8, le);
    entries.set(tag, { type, count, valueOffset });
  }

  const scalar = (tag: number): number | null => {
    const entry = entries.get(tag);
    if (entry === undefined) return null;
    const vals = readValues(view, entry, le);
    return vals !== null && vals.length >= 1 ? (vals[0] ?? null) : null;
  };

  const width = scalar(TAG_WIDTH);
  const height = scalar(TAG_HEIGHT);
  if (width === null || height === null) return null;
  if (width < 1 || height < 1 || width > MAX_DIM || height > MAX_DIM) return null;
  if (width * height > MAX_PIXELS) return null;

  // Shape gates: single-band uncompressed float32 only.
  if (scalar(TAG_BITS_PER_SAMPLE) !== 32) return null;
  if ((scalar(TAG_COMPRESSION) ?? 1) !== 1) return null;
  if ((scalar(TAG_SAMPLES_PER_PIXEL) ?? 1) !== 1) return null;
  if (scalar(TAG_SAMPLE_FORMAT) !== 3) return null;

  const rowsPerStrip = scalar(TAG_ROWS_PER_STRIP) ?? height;
  if (rowsPerStrip < 1) return null;
  const offsetsEntry = entries.get(TAG_STRIP_OFFSETS);
  const countsEntry = entries.get(TAG_STRIP_BYTE_COUNTS);
  if (offsetsEntry === undefined || countsEntry === undefined) return null;
  const stripOffsets = readValues(view, offsetsEntry, le);
  const stripCounts = readValues(view, countsEntry, le);
  if (stripOffsets === null || stripCounts === null) return null;
  const stripCount = Math.ceil(height / rowsPerStrip);
  if (stripOffsets.length !== stripCount || stripCounts.length !== stripCount) return null;

  // Georeferencing: pixel scale + the single upper-left tiepoint.
  const scaleEntry = entries.get(TAG_MODEL_PIXEL_SCALE);
  const tieEntry = entries.get(TAG_MODEL_TIEPOINT);
  if (scaleEntry === undefined || tieEntry === undefined) return null;
  const scale = readValues(view, scaleEntry, le);
  const tie = readValues(view, tieEntry, le);
  if (scale === null || scale.length < 2 || tie === null || tie.length < 6) return null;
  const [dLon, dLat] = scale;
  const [rasterI, rasterJ, , tieLon, tieLat] = tie;
  if (
    dLon === undefined ||
    dLat === undefined ||
    rasterI === undefined ||
    rasterJ === undefined ||
    tieLon === undefined ||
    tieLat === undefined
  ) {
    return null;
  }
  if (!(dLon > 0) || !(dLat > 0)) return null;
  // The tiepoint anchors raster (i,j) at (tieLon, tieLat); normalize to (0,0).
  const lon0 = tieLon - rasterI * dLon;
  const lat0 = tieLat + rasterJ * dLat;
  if (!Number.isFinite(lon0) || !Number.isFinite(lat0)) return null;
  if (lat0 < -90.01 || lat0 > 90.01) return null;

  // Decode the strips into one row-major float array.
  const data = new Float32Array(width * height);
  let px = 0;
  for (let s = 0; s < stripCount; s++) {
    const rows = Math.min(rowsPerStrip, height - s * rowsPerStrip);
    const expectBytes = rows * width * 4;
    const offset = stripOffsets[s];
    const count = stripCounts[s];
    if (offset === undefined || count === undefined) return null;
    if (count !== expectBytes) return null;
    if (offset + count > view.byteLength) return null;
    for (let i = 0; i < rows * width; i++) {
      data[px++] = view.getFloat32(offset + i * 4, le);
    }
  }

  return { width, height, data, lon0, lat0, dLon, dLat };
}
