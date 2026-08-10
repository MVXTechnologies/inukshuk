import { inflateSync } from 'node:zlib';
import { encodePng } from './png';

/** Read a big-endian u32 out of the PNG bytes. */
const u32 = (bytes: Uint8Array, o: number): number =>
  ((bytes[o]! << 24) | (bytes[o + 1]! << 16) | (bytes[o + 2]! << 8) | bytes[o + 3]!) >>> 0;

/** Extract a chunk's payload by type (first occurrence). */
function chunk(bytes: Uint8Array, type: string): Uint8Array | null {
  let o = 8;
  while (o + 8 <= bytes.length) {
    const len = u32(bytes, o);
    const t = String.fromCharCode(bytes[o + 4]!, bytes[o + 5]!, bytes[o + 6]!, bytes[o + 7]!);
    if (t === type) return bytes.subarray(o + 8, o + 8 + len);
    o += 12 + len;
  }
  return null;
}

function rgbaOf(width: number, height: number, fill: (i: number) => number): Uint8Array {
  return Uint8Array.from({ length: width * height * 4 }, (_, i) => fill(i) & 0xff);
}

describe('encodePng', () => {
  it('writes the PNG signature and an 8-bit RGBA IHDR', () => {
    const png = encodePng(
      3,
      2,
      rgbaOf(3, 2, (i) => i),
    );
    expect(Array.from(png.subarray(0, 8))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const ihdr = chunk(png, 'IHDR');
    expect(ihdr).not.toBeNull();
    if (!ihdr) return;
    expect(u32(ihdr, 0)).toBe(3);
    expect(u32(ihdr, 4)).toBe(2);
    expect(ihdr[8]).toBe(8); // bit depth
    expect(ihdr[9]).toBe(6); // truecolour + alpha
    expect(chunk(png, 'IEND')).not.toBeNull();
  });

  it('round-trips pixels through a real zlib inflate', () => {
    const width = 5;
    const height = 4;
    const rgba = rgbaOf(width, height, (i) => (i * 37) % 251);
    const png = encodePng(width, height, rgba);
    const idat = chunk(png, 'IDAT');
    expect(idat).not.toBeNull();
    if (!idat) return;
    const raw = new Uint8Array(inflateSync(idat));
    expect(raw.length).toBe((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) {
      expect(raw[y * (width * 4 + 1)]).toBe(0); // filter byte: None
      const row = raw.subarray(y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1));
      expect(Array.from(row)).toEqual(
        Array.from(rgba.subarray(y * width * 4, (y + 1) * width * 4)),
      );
    }
  });

  it('splits large images across multiple stored blocks correctly', () => {
    // 128×130 RGBA raw stream (incl. filter bytes) ≈ 66.7 KB > one block.
    const width = 128;
    const height = 130;
    const rgba = rgbaOf(width, height, (i) => i % 256);
    const png = encodePng(width, height, rgba);
    const idat = chunk(png, 'IDAT');
    expect(idat).not.toBeNull();
    if (!idat) return;
    const raw = new Uint8Array(inflateSync(idat));
    expect(raw.length).toBe((width * 4 + 1) * height);
    // Spot-check a scanline beyond the first block boundary.
    const y = 120;
    const row = raw.subarray(y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1));
    expect(Array.from(row)).toEqual(Array.from(rgba.subarray(y * width * 4, (y + 1) * width * 4)));
  });

  it('has valid chunk CRCs (verified against a reference CRC-32)', () => {
    const png = encodePng(
      2,
      2,
      rgbaOf(2, 2, () => 0x7f),
    );
    // Walk every chunk and recompute its CRC with an independent bitwise
    // implementation.
    const crcRef = (bytes: Uint8Array): number => {
      let crc = 0xffffffff;
      for (const byte of bytes) {
        crc ^= byte;
        for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
      }
      return (crc ^ 0xffffffff) >>> 0;
    };
    let o = 8;
    let checked = 0;
    while (o + 8 <= png.length) {
      const len = u32(png, o);
      const body = png.subarray(o + 4, o + 8 + len);
      expect(u32(png, o + 8 + len)).toBe(crcRef(body));
      checked++;
      o += 12 + len;
    }
    expect(checked).toBe(3); // IHDR, IDAT, IEND
  });

  it('throws on size mismatches (programmer-error guard)', () => {
    expect(() => encodePng(2, 2, new Uint8Array(15))).toThrow();
    expect(() => encodePng(0, 2, new Uint8Array(0))).toThrow();
  });
});
