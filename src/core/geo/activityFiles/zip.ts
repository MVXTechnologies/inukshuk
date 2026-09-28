import { Inflate, strFromU8 } from 'fflate';

import type { ByteSource } from '@core/geo/geopdf/pdfReader';

/**
 * Random-access ZIP reader over a {@link ByteSource}: the central directory is
 * listed first (metadata only), then entries are decompressed one at a time in
 * bounded slices. Unlike `unzipSync`, the archive is never loaded whole — a
 * multi-GB Strava export (activities + photos) only costs the entries we
 * actually open. ZIP64 archives (> 4 GB or > 65 535 entries) are supported.
 */

export class ZipFormatError extends Error {
  constructor(message: string) {
    super(`ZIP: ${message}`);
    this.name = 'ZipFormatError';
  }
}

export interface ZipEntry {
  name: string;
  /** 0 = stored, 8 = deflate. Anything else is unsupported. */
  method: number;
  flags: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/** Bytes pulled per read — well under `withFileByteSource`'s 8 MB cap. */
export const ZIP_READ_CHUNK = 1024 * 1024;

/** Does `bytes` start with a local-file-header (or empty-archive) signature? */
export function looksLikeZip(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06))
  );
}

const u16 = (b: Uint8Array, o: number): number => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
const u32 = (b: Uint8Array, o: number): number => (u16(b, o) + u16(b, o + 2) * 0x10000) >>> 0;
/** 64-bit little-endian as a JS number (exact below 2^53, which every real archive is). */
const u64 = (b: Uint8Array, o: number): number => u32(b, o) + u32(b, o + 4) * 0x100000000;

function readExact(src: ByteSource, offset: number, length: number): Uint8Array {
  if (offset < 0 || offset + length > src.size) throw new ZipFormatError('read past end');
  const out = src.read(offset, length);
  if (out.length !== length) throw new ZipFormatError('short read');
  return out;
}

/**
 * List every entry in the archive's central directory. Throws
 * {@link ZipFormatError} when the directory can't be found or is corrupt.
 */
export function listZipEntries(src: ByteSource): ZipEntry[] {
  // The end-of-central-directory record sits in the last 22 + 65 535 bytes.
  const tailLen = Math.min(src.size, 22 + 0xffff);
  const tailStart = src.size - tailLen;
  const tail = readExact(src, tailStart, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (u32(tail, i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipFormatError('no end-of-central-directory record');

  let count = u16(tail, eocd + 10);
  let cdSize = u32(tail, eocd + 12);
  let cdOffset = u32(tail, eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const locAt = tailStart + eocd - 20;
    if (locAt < 0) throw new ZipFormatError('ZIP64 locator missing');
    const loc = readExact(src, locAt, 20);
    if (u32(loc, 0) !== SIG_EOCD64_LOCATOR) throw new ZipFormatError('ZIP64 locator missing');
    const rec = readExact(src, u64(loc, 8), 56);
    if (u32(rec, 0) !== SIG_EOCD64) throw new ZipFormatError('ZIP64 record missing');
    count = u64(rec, 32);
    cdSize = u64(rec, 40);
    cdOffset = u64(rec, 48);
  }
  if (cdOffset + cdSize > src.size) throw new ZipFormatError('central directory out of range');

  const entries: ZipEntry[] = [];
  const cdEnd = cdOffset + cdSize;
  // Buffered walk: one ~1 MB read serves hundreds of headers.
  let bufStart = cdOffset;
  let buf: Uint8Array = new Uint8Array(0);
  const ensure = (at: number, len: number): number => {
    if (at + len > cdEnd) throw new ZipFormatError('central directory entry cut off');
    if (at < bufStart || at + len > bufStart + buf.length) {
      bufStart = at;
      buf = readExact(src, at, Math.min(cdEnd - at, Math.max(len, ZIP_READ_CHUNK)));
    }
    return at - bufStart;
  };

  let at = cdOffset;
  for (let i = 0; i < count; i++) {
    let o = ensure(at, 46);
    if (u32(buf, o) !== SIG_CENTRAL) throw new ZipFormatError('bad central directory entry');
    const flags = u16(buf, o + 8);
    const method = u16(buf, o + 10);
    let compressedSize = u32(buf, o + 20);
    let uncompressedSize = u32(buf, o + 24);
    const nameLen = u16(buf, o + 28);
    const extraLen = u16(buf, o + 30);
    const commentLen = u16(buf, o + 32);
    let localHeaderOffset = u32(buf, o + 42);
    const varLen = nameLen + extraLen + commentLen;
    o = ensure(at, 46 + varLen);
    const name = strFromU8(buf.subarray(o + 46, o + 46 + nameLen), (flags & 0x800) === 0);
    // ZIP64 extended information: only the saturated fields are present, in order.
    let e = o + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const id = u16(buf, e);
      const size = u16(buf, e + 2);
      if (id === 0x0001) {
        let p = e + 4;
        if (uncompressedSize === 0xffffffff && p + 8 <= e + 4 + size) {
          uncompressedSize = u64(buf, p);
          p += 8;
        }
        if (compressedSize === 0xffffffff && p + 8 <= e + 4 + size) {
          compressedSize = u64(buf, p);
          p += 8;
        }
        if (localHeaderOffset === 0xffffffff && p + 8 <= e + 4 + size) {
          localHeaderOffset = u64(buf, p);
        }
      }
      e += 4 + size;
    }
    entries.push({ name, method, flags, compressedSize, uncompressedSize, localHeaderOffset });
    at += 46 + varLen;
  }
  return entries;
}

/** Run `fn` with random access to an archive; the handle may be re-opened per call. */
export type SourceOpener = <T>(fn: (src: ByteSource) => T) => T;

/**
 * Decompress one entry, handing its bytes to `sink` in chunks. Compressed
 * data is read {@link ZIP_READ_CHUNK} at a time through `open` (a fresh handle
 * per slice), and `between` is awaited after every slice so a long entry never
 * monopolizes the JS thread. `sink` may throw to abort (size budgets).
 */
export async function pumpZipEntry(
  open: SourceOpener,
  entry: ZipEntry,
  sink: (chunk: Uint8Array) => void,
  between: () => Promise<void> = () => Promise.resolve(),
): Promise<void> {
  if ((entry.flags & 0x1) !== 0) throw new ZipFormatError(`${entry.name} is encrypted`);
  if (entry.method !== 0 && entry.method !== 8) {
    throw new ZipFormatError(`${entry.name}: unsupported compression method ${entry.method}`);
  }
  const dataStart = open((src) => {
    const local = readExact(src, entry.localHeaderOffset, 30);
    if (u32(local, 0) !== SIG_LOCAL) throw new ZipFormatError('bad local file header');
    const start = entry.localHeaderOffset + 30 + u16(local, 26) + u16(local, 28);
    if (start + entry.compressedSize > src.size) {
      throw new ZipFormatError(`${entry.name}: data out of range`);
    }
    return start;
  });

  let inflater: Inflate | undefined;
  if (entry.method === 8) {
    inflater = new Inflate();
    inflater.ondata = (chunk) => sink(chunk);
  }
  const end = dataStart + entry.compressedSize;
  if (entry.compressedSize === 0) {
    inflater?.push(new Uint8Array(0), true);
    return;
  }
  for (let at = dataStart; at < end;) {
    const len = Math.min(ZIP_READ_CHUNK, end - at);
    const slice = open((src) => readExact(src, at, len));
    at += len;
    if (inflater) inflater.push(slice, at >= end);
    else sink(slice);
    if (at < end) await between();
  }
}
