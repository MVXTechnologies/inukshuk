/**
 * Reading a huge GeoTIFF out of a forward-only byte stream.
 *
 * A CanMatrix sheet arrives as a ~30 MB zip that inflates to ~92 MB of
 * uncompressed palette bytes. Neither number may ever exist as a single buffer
 * on a phone, and the zip is a stream — you cannot seek inside it. So the
 * import inflates the entry **twice**, keeping only what it needs each time:
 *
 * 1. {@link createTiffHeaderCollector} — the first 8 bytes give the byte order
 *    and the offset of the image file directory; from there it keeps only the
 *    bytes at or after that offset (capped), which is where the IFD, the strip
 *    table, the colour map and the GeoTIFF keys live. For these sheets that is
 *    ~67 KB out of 92 MB.
 * 2. {@link createStreamRangeExtractor} — with the strip table in hand, the
 *    second pass knows the exact byte range of every image row the downscale
 *    plan asks for, and hands each one to a callback the moment it completes.
 *    One row (~11 KB) is buffered at a time.
 *
 * Peak cost of the pair: the header window plus one row plus the caller's
 * output bitmap. Nothing here allocates in proportion to the file.
 */
import { readTiffHeader, tiffWindow, type TiffWindow } from '@core/geo/tiff/container';
import { parseRasterGeoTiff, type RasterGeoTiffParseResult } from './rasterTiff';

/**
 * How much of the file, starting at the IFD, the header pass keeps.
 *
 * Every CanMatrix sheet puts its IFD last, so the window is the file's tail and
 * this cap is never reached (021L14: 67 445 bytes). It exists for a writer that
 * puts the directory first: then the window is the IFD plus whatever follows,
 * and 4 MB is far more than any strip table plus colour map needs while still
 * being a bounded allocation.
 */
export const TIFF_HEADER_WINDOW_BYTES = 4 * 1024 * 1024;

/** Collects the bytes a raster GeoTIFF's header needs out of a byte stream. */
export interface TiffHeaderCollector {
  /** Feed the next chunk of the file, in file order. */
  push(chunk: Uint8Array): void;
  /** Parse what was collected. Call once the stream has ended. */
  finish(): TiffHeaderResult;
}

export interface TiffHeaderResult extends RasterGeoTiffParseResult {
  /** Total bytes seen — the inflated size of the TIFF. */
  totalBytes: number;
  /** The window the header was parsed from, for callers that need more tags. */
  window: TiffWindow | null;
}

/**
 * Collect and parse a raster GeoTIFF's header from a forward-only stream.
 * `maxWindowBytes` bounds the allocation; see {@link TIFF_HEADER_WINDOW_BYTES}.
 */
export function createTiffHeaderCollector(
  maxWindowBytes: number = TIFF_HEADER_WINDOW_BYTES,
): TiffHeaderCollector {
  const head = new Uint8Array(8);
  let headFilled = 0;
  let le = true;
  let ifdOffset = -1;
  let position = 0;
  const parts: Uint8Array[] = [];
  let windowBytes = 0;

  return {
    push(chunk: Uint8Array): void {
      if (headFilled < 8) {
        const take = Math.min(8 - headFilled, chunk.length);
        head.set(chunk.subarray(0, take), headFilled);
        headFilled += take;
        if (headFilled === 8) {
          const header = readTiffHeader(head);
          if (header !== null) {
            le = header.le;
            ifdOffset = header.ifdOffset;
          }
        }
      }
      const chunkStart = position;
      position += chunk.length;
      if (ifdOffset < 0 || windowBytes >= maxWindowBytes) return;
      const from = Math.max(ifdOffset, chunkStart);
      const to = Math.min(position, ifdOffset + maxWindowBytes);
      if (to <= from) return;
      // Copy: the caller's chunk may be a view into a buffer it reuses.
      const slice = chunk.slice(from - chunkStart, to - chunkStart);
      parts.push(slice);
      windowBytes += slice.length;
    },

    finish(): TiffHeaderResult {
      if (ifdOffset < 0) {
        return {
          raster: null,
          warnings: ['not a TIFF (bad byte-order mark or version)'],
          totalBytes: position,
          window: null,
        };
      }
      const bytes = new Uint8Array(windowBytes);
      let at = 0;
      for (const part of parts) {
        bytes.set(part, at);
        at += part.length;
      }
      const window = tiffWindow(bytes, ifdOffset, le);
      const parsed = parseRasterGeoTiff(window, ifdOffset);
      return { ...parsed, totalBytes: position, window };
    },
  };
}

/* ------------------------------------------------------------- ranges --- */

/** One byte range to lift out of the stream. */
export interface StreamRange {
  offset: number;
  length: number;
}

export interface StreamRangeExtractor {
  /** Feed the next chunk of the file, in file order. */
  push(chunk: Uint8Array): void;
  /** True once every requested range has been delivered. */
  readonly done: boolean;
}

/**
 * Lift a list of byte ranges out of a forward-only stream, calling `onRange`
 * with each one as it completes. Ranges MUST be sorted by ascending offset and
 * must not overlap — which is exactly what a raster downscale plan produces,
 * since it samples ascending rows of a strip-ordered image.
 *
 * A range the stream has already passed (because the caller sorted badly, or
 * the stream is short) is skipped silently: a missing row is a blank line in
 * the overlay, never a thrown error mid-download.
 */
export function createStreamRangeExtractor(
  ranges: readonly StreamRange[],
  onRange: (index: number, bytes: Uint8Array) => void,
): StreamRangeExtractor {
  let position = 0;
  let next = 0;
  let buffer: Uint8Array | null = null;
  let filled = 0;

  return {
    push(chunk: Uint8Array): void {
      const chunkStart = position;
      position += chunk.length;
      for (;;) {
        const range = ranges[next];
        if (range === undefined) return;
        if (buffer === null) {
          // Nothing of this range has arrived yet.
          if (range.offset >= position) return;
          // The stream is already past this range's start — unfillable.
          if (range.offset < chunkStart) {
            next++;
            continue;
          }
          if (range.length <= 0) {
            onRange(next, new Uint8Array(0));
            next++;
            continue;
          }
          buffer = new Uint8Array(range.length);
          filled = 0;
        }
        const from = range.offset + filled;
        if (from >= position) return;
        const take = Math.min(range.length - filled, position - from);
        buffer.set(chunk.subarray(from - chunkStart, from - chunkStart + take), filled);
        filled += take;
        if (filled < range.length) return;
        onRange(next, buffer);
        buffer = null;
        filled = 0;
        next++;
      }
    },

    get done(): boolean {
      return next >= ranges.length;
    },
  };
}
