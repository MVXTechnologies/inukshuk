import { deflateSync, inflateSync, constants } from 'zlib';
import UPNG from 'upng-js';
import { adler32, crc32, decodePng, deflateRuns, encodeIndexedPng, inflateZlib } from './pngCodec';

/** Deterministic pseudo-random bytes. */
function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s >>> 24;
  };
}

/** Bytes shaped like real data: runs, gradients and noise. */
function sample(n: number, seed: number): Uint8Array {
  const r = prng(seed);
  const b = new Uint8Array(n);
  for (let i = 0; i < n;) {
    const kind = r() % 3;
    const len = 1 + (r() % 300);
    const v = r();
    for (let k = 0; k < len && i < n; k++, i++)
      b[i] = kind === 0 ? v : kind === 1 ? (v + k) & 255 : r();
  }
  return b;
}

const ab = (u: Uint8Array) =>
  u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
const same = (a: Uint8Array, b: Uint8Array) => Buffer.compare(a, b) === 0;

describe('checksums', () => {
  it('crc32 matches the standard check value', () => {
    const s = new TextEncoder().encode('123456789');
    expect(crc32(s, 0, s.length)).toBe(0xcbf43926);
  });

  it('adler32 matches the RFC 1950 example', () => {
    expect(adler32(new TextEncoder().encode('Wikipedia'))).toBe(0x11e60398);
    expect(adler32(new Uint8Array(100000).fill(255))).toBe(
      ((): number => {
        let a = 1;
        let b = 0;
        for (let i = 0; i < 100000; i++) {
          a = (a + 255) % 65521;
          b = (b + a) % 65521;
        }
        return ((b << 16) | a) >>> 0;
      })(),
    );
  });
});

describe('inflateZlib', () => {
  it.each([
    ['stored', constants.Z_NO_COMPRESSION],
    ['fastest', 1],
    ['default', 6],
    ['best', 9],
  ])('round-trips zlib %s output (fixed, dynamic and stored blocks)', (_, level) => {
    for (const [n, seed] of [
      [0, 1],
      [1, 2],
      [1000, 3],
      [200_000, 4],
    ] as const) {
      const raw = sample(n, seed);
      expect(same(inflateZlib(new Uint8Array(deflateSync(raw, { level }))), raw)).toBe(true);
    }
  });

  it('handles fixed-Huffman streams (Z_FIXED strategy) and long back-references', () => {
    const raw = new Uint8Array(70000);
    for (let i = 0; i < raw.length; i++) raw[i] = (i % 40000) & 0xff;
    expect(
      same(inflateZlib(new Uint8Array(deflateSync(raw, { strategy: constants.Z_FIXED }))), raw),
    ).toBe(true);
  });

  it('rejects garbage, truncation and a bad checksum', () => {
    const z = new Uint8Array(deflateSync(sample(5000, 9)));
    expect(() => inflateZlib(new Uint8Array([1, 2, 3, 4, 5, 6]))).toThrow();
    expect(() => inflateZlib(z.subarray(0, z.length - 10))).toThrow();
    const bad = z.slice();
    bad[bad.length - 1] = bad[bad.length - 1]! ^ 1;
    expect(() => inflateZlib(bad)).toThrow(/adler32/);
  });
});

describe('decodePng', () => {
  it('decodes RGB, RGBA and palette PNGs exactly like UPNG (all filter types)', () => {
    const w = 37;
    const h = 23;
    const rgba = new Uint8Array(w * h * 4);
    const r = prng(5);
    for (let i = 0; i < w * h; i++) {
      // Smooth fields so the encoder picks Sub/Up/Avg/Paeth filters.
      const x = i % w;
      const y = Math.floor(i / w);
      rgba[i * 4] = (x * 7 + y * 3) & 255;
      rgba[i * 4 + 1] = (x * y) & 255;
      rgba[i * 4 + 2] = r();
      rgba[i * 4 + 3] = 255;
    }
    const opaque = new Uint8Array(UPNG.encode([ab(rgba)], w, h, 0)); // RGB (alpha all 255)
    const translucent = rgba.slice();
    for (let i = 3; i < translucent.length; i += 8) translucent[i] = 77;
    const withAlpha = new Uint8Array(UPNG.encode([ab(translucent)], w, h, 0));
    const indexed = new Uint8Array(UPNG.encode([ab(rgba)], w, h, 16));
    for (const png of [opaque, withAlpha, indexed]) {
      const want = new Uint8Array(UPNG.toRGBA8(UPNG.decode(ab(png)))[0]!);
      const got = decodePng(png);
      expect([got.width, got.height]).toEqual([w, h]);
      expect(same(got.rgba, want)).toBe(true);
    }
  });

  it('decodes a Terrarium-style RGB tile to the same elevations', () => {
    // Terrarium: (r·256 + g + b/256) − 32768 for a 0..1200 m ramp with noise.
    const w = 256;
    const rgba = new Uint8Array(w * w * 4);
    const r = prng(11);
    for (let i = 0; i < w * w; i++) {
      const m = 32768 + ((i % w) * 3 + Math.floor(i / w) * 1.7 + r() / 64);
      const v = Math.round(m * 256);
      rgba[i * 4] = v >> 16;
      rgba[i * 4 + 1] = (v >> 8) & 255;
      rgba[i * 4 + 2] = v & 255;
      rgba[i * 4 + 3] = 255;
    }
    const png = new Uint8Array(UPNG.encode([ab(rgba)], w, w, 0));
    expect(same(decodePng(png).rgba, rgba)).toBe(true);
  });

  it('refuses what it does not implement', () => {
    expect(() => decodePng(new Uint8Array(20))).toThrow(/signature/);
    const gray16 = new Uint8Array(UPNG.encode([ab(new Uint8Array(16))], 2, 2, 0));
    gray16[24] = 16; // IHDR bit depth → 16 (CRC no longer matches; not checked)
    expect(() => decodePng(gray16)).toThrow(/8-bit/);
  });
});

describe('deflateRuns + encodeIndexedPng', () => {
  it('produces a valid zlib stream for any input', () => {
    for (const [n, seed] of [
      [0, 1],
      [2, 1],
      [5000, 2],
      [300_000, 3],
    ] as const) {
      const raw = sample(n, seed);
      expect(same(new Uint8Array(inflateSync(deflateRuns(raw))), raw)).toBe(true);
      expect(same(inflateZlib(deflateRuns(raw)), raw)).toBe(true);
      // With previous-row matches (incl. a distance needing extra bits).
      for (const rowDist of [37, 1025, 32768]) {
        expect(same(new Uint8Array(inflateSync(deflateRuns(raw, rowDist))), raw)).toBe(true);
      }
    }
  });

  it('compresses a slope-overlay-like index image well', () => {
    const w = 1024;
    const idx = new Uint8Array(w * w);
    for (let y = 0; y < w; y++)
      for (let x = 0; x < w; x++)
        idx[y * w + x] = Math.floor(Math.hypot(x - 300, y - 400) / 25) % 6;
    const png = encodeIndexedPng(
      w,
      w,
      idx,
      new Uint8Array(41 * 3).fill(9),
      new Uint8Array(41).fill(200),
    );
    expect(png.length).toBeLessThan(idx.length / 15);
  });

  it('round-trips through UPNG and decodePng with the palette and transparency', () => {
    const w = 50;
    const h = 7;
    const idx = new Uint8Array(w * h);
    const r = prng(3);
    for (let i = 0; i < idx.length; i++) idx[i] = r() % 4 === 0 ? 0 : r() % 3;
    const rgb = new Uint8Array([0, 0, 0, 246, 231, 74, 214, 44, 34]);
    const alpha = new Uint8Array([0, 128, 255]);
    const png = encodeIndexedPng(w, h, idx, rgb, alpha);
    const viaUpng = new Uint8Array(UPNG.toRGBA8(UPNG.decode(ab(png)))[0]!);
    const ours = decodePng(png).rgba;
    for (let i = 0; i < idx.length; i++) {
      const k = idx[i]!;
      const want = [rgb[k * 3], rgb[k * 3 + 1], rgb[k * 3 + 2], alpha[k]];
      expect([...ours.slice(i * 4, i * 4 + 4)]).toEqual(want);
      // UPNG zeroes the colour of fully transparent pixels.
      expect(viaUpng[i * 4 + 3]).toBe(alpha[k]);
    }
  });

  it('validates its input', () => {
    expect(() =>
      encodeIndexedPng(0, 1, new Uint8Array(0), new Uint8Array(3), new Uint8Array(1)),
    ).toThrow();
    expect(() =>
      encodeIndexedPng(2, 2, new Uint8Array(3), new Uint8Array(3), new Uint8Array(1)),
    ).toThrow();
  });
});
