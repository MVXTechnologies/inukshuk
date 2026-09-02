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
 *
 * The TIFF *container* — byte order, IFD entries, tag values — is read by
 * `@core/geo/tiff/container`, shared with the palette-raster decoder in
 * `@core/geo/geotiff`. This module owns only the float32 pixel interpretation.
 */
import {
  readTiffHeader,
  readTiffIfd,
  readTiffScalar,
  readTiffValues,
  tiffWindow,
  type TiffEntry,
  type TiffWindow,
} from './tiff/container';

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
function readGeoref(win: TiffWindow, entries: ReadonlyMap<number, TiffEntry>): Georef | null {
  const scaleEntry = entries.get(TAG_MODEL_PIXEL_SCALE);
  const tieEntry = entries.get(TAG_MODEL_TIEPOINT);
  if (scaleEntry !== undefined && tieEntry !== undefined) {
    const scale = readTiffValues(win, scaleEntry);
    const tie = readTiffValues(win, tieEntry);
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
    const m = readTiffValues(win, txEntry);
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
  const header = readTiffHeader(bytes);
  if (header === null) return null;
  const { le, ifdOffset } = header;
  const win = tiffWindow(bytes, 0, le);
  const { view } = win;
  const entries = readTiffIfd(win, ifdOffset);
  if (entries === null) return null;

  const scalar = (tag: number): number | null => readTiffScalar(win, entries, tag);

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

  const georef = readGeoref(win, entries);
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
    const tileOffsets = readTiffValues(win, offsetsEntry);
    const tileCounts = readTiffValues(win, countsEntry);
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
  const stripOffsets = readTiffValues(win, offsetsEntry);
  const stripCounts = readTiffValues(win, countsEntry);
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
