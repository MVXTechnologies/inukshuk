/**
 * Minimal dependency-free PNG encoder (marine wave D): wraps raw RGBA pixels
 * into an 8-bit truecolour+alpha PNG — the depth-chart drape is rendered
 * in JS and handed to MapLibre as a `file://` PNG (`storage.writeOverlayPng`;
 * data: URIs crash the Android ImageSource, see that function's doc).
 *
 * The IDAT stream is a zlib wrapper around STORED (uncompressed) deflate
 * blocks: zero code, byte-exact output, and the OS cache directory owns the
 * files' lifetime — compression would buy disk we don't need at CPU cost on
 * every camera settle. Nothing platform-specific: pure typed-array math,
 * OTA-safe, unit-testable in Node (whose zlib inflates the output back).
 */

/** CRC-32 (IEEE 802.3), table-driven; PNG chunk checksums. */
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) {
    crc = (CRC_TABLE[(crc ^ (bytes[i] ?? 0)) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Adler-32 over the raw (pre-deflate) data; the zlib trailer. */
function adler32(bytes: Uint8Array): number {
  const MOD = 65521;
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + (bytes[i] ?? 0)) % MOD;
    b = (b + a) % MOD;
  }
  return ((b << 16) | a) >>> 0;
}

/** Max payload of one stored deflate block. */
const STORED_BLOCK_MAX = 65535;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Encode RGBA pixels as an 8-bit RGBA PNG. `rgba` must hold exactly
 * `width * height * 4` bytes (row-major, top row first). Returns the
 * complete PNG file bytes. Throws on mismatched sizes — callers own their
 * dimensions; this is a programmer-error guard, not a data guard.
 */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  if (width < 1 || height < 1) throw new Error('encodePng: empty image');
  if (rgba.length !== width * height * 4) throw new Error('encodePng: rgba size mismatch');

  // Raw scanline stream: one filter byte (0 = None) before each row.
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  // zlib stream: 2-byte header, stored deflate blocks, adler32 trailer.
  const blocks = Math.max(1, Math.ceil(raw.length / STORED_BLOCK_MAX));
  const idat = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  let o = 0;
  idat[o++] = 0x78; // CMF: deflate, 32K window
  idat[o++] = 0x01; // FLG: fastest, no dict (checksum-valid pair)
  for (let b = 0; b < blocks; b++) {
    const start = b * STORED_BLOCK_MAX;
    const len = Math.min(STORED_BLOCK_MAX, raw.length - start);
    idat[o++] = b === blocks - 1 ? 1 : 0; // BFINAL + BTYPE=00 (stored)
    idat[o++] = len & 0xff;
    idat[o++] = (len >> 8) & 0xff;
    idat[o++] = ~len & 0xff;
    idat[o++] = (~len >> 8) & 0xff;
    idat.set(raw.subarray(start, start + len), o);
    o += len;
  }
  const adler = adler32(raw);
  idat[o++] = (adler >>> 24) & 0xff;
  idat[o++] = (adler >>> 16) & 0xff;
  idat[o++] = (adler >>> 8) & 0xff;
  idat[o++] = adler & 0xff;

  // IHDR payload: dimensions + 8-bit RGBA, no interlace.
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour + alpha
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method 0
  ihdr[12] = 0; // no interlace

  const out = new Uint8Array(PNG_SIGNATURE.length + (12 + ihdr.length) + (12 + idat.length) + 12);
  let p = 0;
  out.set(PNG_SIGNATURE, p);
  p += PNG_SIGNATURE.length;
  p = writeChunk(out, p, 'IHDR', ihdr);
  p = writeChunk(out, p, 'IDAT', idat);
  writeChunk(out, p, 'IEND', new Uint8Array(0));
  return out;
}

/** Write one PNG chunk (length, type, payload, CRC); returns the next offset. */
function writeChunk(out: Uint8Array, offset: number, type: string, payload: Uint8Array): number {
  const view = new DataView(out.buffer, out.byteOffset);
  view.setUint32(offset, payload.length);
  for (let i = 0; i < 4; i++) out[offset + 4 + i] = type.charCodeAt(i);
  out.set(payload, offset + 8);
  const crc = crc32(out, offset + 4, offset + 8 + payload.length);
  view.setUint32(offset + 8 + payload.length, crc);
  return offset + 12 + payload.length;
}
