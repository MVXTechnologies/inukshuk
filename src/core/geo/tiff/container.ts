/**
 * The TIFF container — byte order, IFD entries, tag values.
 *
 * Factored out of `@core/geo/floatTiff` (the single-band float32 decoder built
 * for weather/bathymetry grids) so the CanMatrix palette-raster decoder in
 * `@core/geo/geotiff` reads the same structure through the same code. There is
 * one TIFF parser in this repo, and this is it; the decoders above it differ
 * only in how they interpret the pixel data.
 *
 * **Windowed on purpose.** A 1:50k CanMatrix scan is ~92 MB of uncompressed
 * palette bytes with its IFD at the *end* of the file, so a phone must never
 * hold the whole thing to read the header. Every function here works on a
 * {@link TiffWindow}: a slice of the file plus the absolute offset that slice
 * starts at. Callers that do have the whole file pass `base: 0`; the on-device
 * path reads the first 8 bytes, follows the IFD pointer, and then reads only
 * the tail — a few tens of KB — as its window.
 *
 * Nothing here throws on arbitrary bytes: a value that would read outside the
 * window returns null and the caller decides.
 */

/** TIFF field types, by their on-disk code. */
export const TIFF_TYPE_BYTE = 1;
export const TIFF_TYPE_ASCII = 2;
export const TIFF_TYPE_SHORT = 3;
export const TIFF_TYPE_LONG = 4;
export const TIFF_TYPE_RATIONAL = 5;
export const TIFF_TYPE_DOUBLE = 12;

/** Byte width of each field type we can read. Unlisted types are skipped. */
const TYPE_SIZE: Record<number, number> = {
  [TIFF_TYPE_BYTE]: 1,
  [TIFF_TYPE_ASCII]: 1,
  [TIFF_TYPE_SHORT]: 2,
  [TIFF_TYPE_LONG]: 4,
  [TIFF_TYPE_RATIONAL]: 8,
  6: 1, // SBYTE
  7: 1, // UNDEFINED
  8: 2, // SSHORT
  9: 4, // SLONG
  10: 8, // SRATIONAL
  11: 4, // FLOAT
  [TIFF_TYPE_DOUBLE]: 8,
};

/** Byte width of a TIFF field type, or null when we cannot read it. */
export function tiffTypeSize(type: number): number | null {
  return TYPE_SIZE[type] ?? null;
}

/** One IFD entry. `valueOffset` is ABSOLUTE (file-relative), never window-relative. */
export interface TiffEntry {
  tag: number;
  type: number;
  count: number;
  valueOffset: number;
}

/**
 * A readable slice of a TIFF. `base` is the absolute file offset of `view`
 * byte 0, so an absolute offset `o` reads at `view` byte `o - base`.
 */
export interface TiffWindow {
  view: DataView;
  base: number;
  le: boolean;
}

/** Byte order + first-IFD pointer from a TIFF's 8-byte header. Null if not a TIFF. */
export function readTiffHeader(bytes: Uint8Array): { le: boolean; ifdOffset: number } | null {
  if (bytes.byteLength < 8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const b0 = view.getUint8(0);
  const b1 = view.getUint8(1);
  let le: boolean;
  if (b0 === 0x49 && b1 === 0x49) le = true;
  else if (b0 === 0x4d && b1 === 0x4d) le = false;
  else return null;
  // 42 is classic TIFF. BigTIFF (43) uses 8-byte offsets and is not supported.
  if (view.getUint16(2, le) !== 42) return null;
  const ifdOffset = view.getUint32(4, le);
  if (ifdOffset < 8) return null;
  return { le, ifdOffset };
}

/** Wrap a byte slice as a window starting at absolute offset `base`. */
export function tiffWindow(bytes: Uint8Array, base: number, le: boolean): TiffWindow {
  return { view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), base, le };
}

/** Can `count` bytes at absolute offset `at` be read from this window? */
function inWindow(win: TiffWindow, at: number, count: number): boolean {
  const start = at - win.base;
  return start >= 0 && count >= 0 && start + count <= win.view.byteLength;
}

/**
 * Read one IFD's entries, keyed by tag. Later duplicates of a tag are ignored
 * (the first wins, as every TIFF reader does). Null when the directory itself
 * does not fit in the window.
 */
export function readTiffIfd(win: TiffWindow, ifdOffset: number): Map<number, TiffEntry> | null {
  if (!inWindow(win, ifdOffset, 2)) return null;
  const countAt = ifdOffset - win.base;
  const entryCount = win.view.getUint16(countAt, win.le);
  if (!inWindow(win, ifdOffset + 2, entryCount * 12)) return null;

  const entries = new Map<number, TiffEntry>();
  for (let i = 0; i < entryCount; i++) {
    const at = countAt + 2 + i * 12;
    const tag = win.view.getUint16(at, win.le);
    const type = win.view.getUint16(at + 2, win.le);
    const count = win.view.getUint32(at + 4, win.le);
    const size = tiffTypeSize(type);
    if (size === null) continue;
    // Values of 4 bytes or less live inline in the entry, left-justified in
    // the field for both byte orders — so reading at at+8 is right either way.
    const inline = size * count <= 4;
    const valueOffset = inline ? win.base + at + 8 : win.view.getUint32(at + 8, win.le);
    if (entries.has(tag)) continue;
    entries.set(tag, { tag, type, count, valueOffset });
  }
  return entries;
}

/**
 * Read a tag's values as numbers. RATIONAL/SRATIONAL collapse to the quotient
 * (that is what every consumer of Resolution/Rational tags wants). Null when
 * the type is unreadable or the values fall outside the window.
 */
export function readTiffValues(win: TiffWindow, entry: TiffEntry): number[] | null {
  const size = tiffTypeSize(entry.type);
  if (size === null) return null;
  if (!inWindow(win, entry.valueOffset, size * entry.count)) return null;
  const at = entry.valueOffset - win.base;
  const { view, le } = win;
  const out: number[] = [];
  for (let i = 0; i < entry.count; i++) {
    const o = at + i * size;
    switch (entry.type) {
      case TIFF_TYPE_BYTE:
      case 7:
        out.push(view.getUint8(o));
        break;
      case 6:
        out.push(view.getInt8(o));
        break;
      case TIFF_TYPE_ASCII:
        out.push(view.getUint8(o));
        break;
      case TIFF_TYPE_SHORT:
        out.push(view.getUint16(o, le));
        break;
      case 8:
        out.push(view.getInt16(o, le));
        break;
      case TIFF_TYPE_LONG:
        out.push(view.getUint32(o, le));
        break;
      case 9:
        out.push(view.getInt32(o, le));
        break;
      case 11:
        out.push(view.getFloat32(o, le));
        break;
      case TIFF_TYPE_DOUBLE:
        out.push(view.getFloat64(o, le));
        break;
      case TIFF_TYPE_RATIONAL: {
        const den = view.getUint32(o + 4, le);
        out.push(den === 0 ? 0 : view.getUint32(o, le) / den);
        break;
      }
      case 10: {
        const den = view.getInt32(o + 4, le);
        out.push(den === 0 ? 0 : view.getInt32(o, le) / den);
        break;
      }
      default:
        return null;
    }
  }
  return out;
}

/** First value of a tag, or null when absent/unreadable. */
export function readTiffScalar(
  win: TiffWindow,
  entries: ReadonlyMap<number, TiffEntry>,
  tag: number,
): number | null {
  const entry = entries.get(tag);
  if (entry === undefined) return null;
  const values = readTiffValues(win, entry);
  return values !== null && values.length > 0 ? (values[0] ?? null) : null;
}

/**
 * An ASCII tag as text, with the TIFF NUL terminators stripped. GeoTIFF packs
 * several citation strings into one ASCII tag separated by "|", so the raw
 * string is returned and the caller slices it.
 */
export function readTiffAscii(win: TiffWindow, entry: TiffEntry): string | null {
  const values = readTiffValues(win, entry);
  if (values === null) return null;
  let text = '';
  for (const code of values) {
    if (code === 0) continue;
    text += String.fromCharCode(code);
  }
  return text;
}
