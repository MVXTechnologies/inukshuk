import {
  bytesEqual,
  concatBytes,
  fromB64u,
  fromB64uLen,
  fromHex,
  isAllZero,
  isB64uLen,
  toB64u,
  toHex,
  utf8,
  utf8Decode,
  utf8Slow,
} from './bytes';
import { forAll, int } from './testing/prop';

describe('base64url', () => {
  it('matches RFC 4648 §10 vectors (url alphabet, no padding)', () => {
    const cases: [string, string][] = [
      ['', ''],
      ['f', 'Zg'],
      ['fo', 'Zm8'],
      ['foo', 'Zm9v'],
      ['foob', 'Zm9vYg'],
      ['fooba', 'Zm9vYmE'],
      ['foobar', 'Zm9vYmFy'],
    ];
    for (const [plain, enc] of cases) {
      expect(toB64u(utf8(plain))).toBe(enc);
      expect(utf8Decode(fromB64u(enc)!)).toBe(plain);
    }
    expect(toB64u(Uint8Array.from([0xfb, 0xff]))).toBe('-_8');
  });

  it('round-trips random bytes and validates lengths without decoding', () => {
    forAll(
      1,
      300,
      (rnd) => Uint8Array.from({ length: int(rnd, 0, 70) }, () => int(rnd, 0, 255)),
      (bytes) => {
        const text = toB64u(bytes);
        expect(fromB64u(text)).toEqual(bytes);
        expect(isB64uLen(text, bytes.length)).toBe(true);
        expect(fromB64uLen(text, bytes.length)).toEqual(bytes);
        expect(isB64uLen(text, bytes.length + 1)).toBe(false);
      },
    );
  });

  it('rejects padding, foreign characters, bad lengths and non-canonical trailing bits', () => {
    for (const bad of [
      'Zg==',
      'Z',
      'Zm9v!',
      'ab+c',
      'ab/c',
      'é',
      'Zm9vYmE€',
      'Zm9vYm€',
      42,
      null,
    ]) {
      expect(fromB64u(bad)).toBeUndefined();
    }
    // 'Zg' is the only spelling of "f" and 'Zm8' the only spelling of "fo".
    for (const [alias, n] of [
      ['Zh', 1],
      ['Zm9', 2],
    ] as const) {
      expect(fromB64u(alias)).toBeUndefined();
      expect(isB64uLen(alias, n)).toBe(false);
    }
    expect(fromB64uLen('Zg', 2)).toBeUndefined();
    expect(isB64uLen(5, 1)).toBe(false);
    expect(isB64uLen('Z€', 1)).toBe(false);
  });
});

describe('utf8', () => {
  it('encodes like TextEncoder, including astral planes and lone surrogates', () => {
    for (const s of ['', 'abc', 'Québec', '漢字', '🏔️⛺', '\ud800x', 'x\udc00']) {
      expect(utf8Slow(s)).toEqual(new TextEncoder().encode(s));
      expect(utf8(s)).toEqual(utf8Slow(s));
    }
  });

  it('decodes strictly', () => {
    expect(utf8Decode(utf8('Québec 🏔️'))).toBe('Québec 🏔️');
    const bad = [
      [0xff],
      [0xc0, 0x80], // overlong
      [0xe0, 0x80, 0x80], // overlong
      [0xed, 0xa0, 0x80], // surrogate
      [0xf4, 0x90, 0x80, 0x80], // > U+10FFFF
      [0xe2, 0x82], // truncated
      [0x80],
    ];
    for (const b of bad) expect(utf8Decode(Uint8Array.from(b))).toBeUndefined();
  });
});

describe('misc', () => {
  it('concat, equality, zero check, hex', () => {
    expect(concatBytes(Uint8Array.from([1]), Uint8Array.from([2, 3]))).toEqual(
      Uint8Array.from([1, 2, 3]),
    );
    expect(bytesEqual(Uint8Array.from([1, 2]), Uint8Array.from([1, 2]))).toBe(true);
    expect(bytesEqual(Uint8Array.from([1, 2]), Uint8Array.from([1, 3]))).toBe(false);
    expect(bytesEqual(Uint8Array.from([1]), Uint8Array.from([1, 0]))).toBe(false);
    expect(isAllZero(new Uint8Array(4))).toBe(true);
    expect(isAllZero(Uint8Array.from([0, 1]))).toBe(false);
    expect(toHex(fromHex('00ff10')!)).toBe('00ff10');
    expect(fromHex('0')).toBeUndefined();
    expect(fromHex('zz')).toBeUndefined();
  });
});
