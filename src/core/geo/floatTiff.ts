/**
 * Shared single-band float32 GeoTIFF parser (marine wave D groundwork): the
 * weather M3 `windTiff` decoder promoted to a general core module so the
 * NONNA bathymetry pipeline can reuse it. Handles exactly the two shapes our
 * WCS sources emit (both verified live 2026-08-09):
 *
 * - GeoMet weather grids: little-endian, strip-organized, georeferenced by
 *   `ModelPixelScale` (33550) + a single `ModelTiepoint` (33922), EPSG:4326;
 * - CHS NONNA depth grids: big-endian, TILED (tags 322–325; tile size varies
 *   per response — 16×16, 112×16 and 512×16 all observed), georeferenced by
 *   `ModelTransformation` (34264) with zero rotation terms, EPSG:3857.
 *
 * The grid's georeference is returned in raw CRS units (degrees for 4326,
 * mercator metres for 3857) — callers own the interpretation. Anything
 * outside the documented shape returns null; this never throws on arbitrary
 * bytes (WCS errors arrive as XML bodies, which fail the magic check).
 */

export interface FloatGrid {
  /** Grid width in pixels (columns, +x). */
  width: number;
  /** Grid height in pixels (rows, top to bottom, −y). */
  height: number;
  /** Row-major samples; row 0 is the top (max-y) edge. */
  data: Float32Array;
  /** CRS x of the grid's LEFT edge (pixel-corner anchored). */
  x0: number;
  /** CRS y of the grid's TOP edge (pixel-corner anchored). */
  y0: number;
  /** Pixel width in CRS units (positive). */
  dx: number;
  /** Pixel height in CRS units (positive; rows step −y). */
  dy: number;
}

/** Upper bound on grid pixels — viewport subsets, never full mosaics. */
const MAX_PIXELS = 1 << 21;
const MAX_DIM = 4096;

// TIFF tag ids (only what the two documented shapes need).
const TAG_WIDTH = 256;
const TAG_HEIGHT = 257;
const TAG_BITS_PER_SAMPLE = 258;
const TAG_COMPRESSION = 259;
const TAG_STRIP_OFFSETS = 273;
const TAG_SAMPLES_PER_PIXEL = 277;
const TAG_ROWS_PER_STRIP = 278;
const TAG_STRIP_BYTE_COUNTS = 279;
const TAG_TILE_WIDTH = 322;
const TAG_TILE_HEIGHT = 323;
const TAG_TILE_OFFSETS = 324;
const TAG_TILE_BYTE_COUNTS = 325;
const TAG_SAMPLE_FORMAT = 339;
const TAG_MODEL_PIXEL_SCALE = 33550;
const TAG_MODEL_TIEPOINT = 33922;
const TAG_MODEL_TRANSFORMATION = 34264;

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

interface Georef {
  x0: number;
  y0: number;
  dx: number;
  dy: number;
}

/**
 * Georeference from either PixelScale+Tiepoint (GeoMet) or a rotation-free
 * ModelTransformation matrix (NONNA). Null when neither is present/sane.
 */
function readGeoref(view: DataView, entries: Map<number, TiffEntry>, le: boolean): Georef | null {
  const scaleEntry = entries.get(TAG_MODEL_PIXEL_SCALE);
  const tieEntry = entries.get(TAG_MODEL_TIEPOINT);
  if (scaleEntry !== undefined && tieEntry !== undefined) {
    const scale = readValues(view, scaleEntry, le);
    const tie = readValues(view, tieEntry, le);
    if (scale === null || scale.length < 2 || tie === null || tie.length < 6) return null;
    const [dx, dy] = scale;
    const [rasterI, rasterJ, , tieX, tieY] = tie;
    if (
      dx === undefined ||
      dy === undefined ||
      rasterI === undefined ||
      rasterJ === undefined ||
      tieX === undefined ||
      tieY === undefined
    ) {
      return null;
    }
    if (!(dx > 0) || !(dy > 0)) return null;
    // The tiepoint anchors raster (i,j) at (tieX, tieY); normalize to (0,0).
    return { x0: tieX - rasterI * dx, y0: tieY + rasterJ * dy, dx, dy };
  }
  const txEntry = entries.get(TAG_MODEL_TRANSFORMATION);
  if (txEntry !== undefined) {
    const m = readValues(view, txEntry, le);
    if (m === null || m.length < 16) return null;
    const [a, b, , x0, c, e, , y0] = m;
    if (a === undefined || b === undefined || x0 === undefined) return null;
    if (c === undefined || e === undefined || y0 === undefined) return null;
    // Rotation-free north-up rasters only (b/c are the rotation terms; e is
    // negative because rows step −y). NONNA emits exactly this shape.
    if (b !== 0 || c !== 0) return null;
    if (!(a > 0) || !(e < 0)) return null;
    return { x0, y0, dx: a, dy: -e };
  }
  return null;
}

/**
 * Parse a single-band uncompressed float32 GeoTIFF (strip- or tile-
 * organized) into a row-major grid. Null on anything outside the documented
 * shape — never throws on arbitrary bytes.
 */
export function parseFloat32Grid(bytes: Uint8Array): FloatGrid | null {
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
    // Inline values are left-justified in the 4-byte field for both endians,
    // so reading the value's own type at e+8 is correct either way.
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

  const georef = readGeoref(view, entries, le);
  if (georef === null) return null;
  const { x0, y0, dx, dy } = georef;
  if (!Number.isFinite(x0) || !Number.isFinite(y0)) return null;

  const data = new Float32Array(width * height);

  const tileW = scalar(TAG_TILE_WIDTH);
  const tileH = scalar(TAG_TILE_HEIGHT);
  if (tileW !== null && tileH !== null) {
    // Tiled layout (NONNA): tiles run left→right, top→bottom; every tile is
    // a full tileW×tileH block — edge tiles carry padding that is dropped.
    if (tileW < 1 || tileH < 1) return null;
    const offsetsEntry = entries.get(TAG_TILE_OFFSETS);
    const countsEntry = entries.get(TAG_TILE_BYTE_COUNTS);
    if (offsetsEntry === undefined || countsEntry === undefined) return null;
    const tileOffsets = readValues(view, offsetsEntry, le);
    const tileCounts = readValues(view, countsEntry, le);
    if (tileOffsets === null || tileCounts === null) return null;
    const across = Math.ceil(width / tileW);
    const down = Math.ceil(height / tileH);
    if (tileOffsets.length !== across * down || tileCounts.length !== across * down) return null;
    const tileBytes = tileW * tileH * 4;
    for (let t = 0; t < tileOffsets.length; t++) {
      const offset = tileOffsets[t];
      const count = tileCounts[t];
      if (offset === undefined || count === undefined) return null;
      if (count !== tileBytes) return null;
      if (offset + count > view.byteLength) return null;
      const tx = (t % across) * tileW;
      const ty = Math.floor(t / across) * tileH;
      const rows = Math.min(tileH, height - ty);
      const cols = Math.min(tileW, width - tx);
      for (let r = 0; r < rows; r++) {
        const rowBase = (ty + r) * width + tx;
        const srcBase = offset + r * tileW * 4;
        for (let c = 0; c < cols; c++) {
          data[rowBase + c] = view.getFloat32(srcBase + c * 4, le);
        }
      }
    }
    return { width, height, data, x0, y0, dx, dy };
  }

  // Strip layout (GeoMet).
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

  return { width, height, data, x0, y0, dx, dy };
}
