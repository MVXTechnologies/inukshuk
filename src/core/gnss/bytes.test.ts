import {
  asciiToBytes,
  base64,
  BitReader,
  bytesToAscii,
  concatBytes,
  LeReader,
  LeWriter,
  utf8Bytes,
} from './bytes';

describe('bytes', () => {
  it('concatenates and converts ASCII', () => {
    expect([
      ...concatBytes([Uint8Array.from([1]), new Uint8Array(0), Uint8Array.from([2, 3])]),
    ]).toEqual([1, 2, 3]);
    expect(bytesToAscii(asciiToBytes('ICY 200 OK'))).toBe('ICY 200 OK');
    expect(bytesToAscii(asciiToBytes('abcdef'), 1, 3)).toBe('bc');
    expect([...asciiToBytes('€')]).toEqual([0x3f]);
  });

  it('encodes UTF-8 for 1–4 byte code points', () => {
    expect([...utf8Bytes('a')]).toEqual([0x61]);
    expect([...utf8Bytes('é')]).toEqual([0xc3, 0xa9]);
    expect([...utf8Bytes('€')]).toEqual([0xe2, 0x82, 0xac]);
    expect([...utf8Bytes('😀')]).toEqual([0xf0, 0x9f, 0x98, 0x80]);
  });

  it('base64 matches RFC 4648 test vectors', () => {
    const v: [string, string][] = [
      ['', ''],
      ['f', 'Zg=='],
      ['fo', 'Zm8='],
      ['foo', 'Zm9v'],
      ['foob', 'Zm9vYg=='],
      ['fooba', 'Zm9vYmE='],
      ['foobar', 'Zm9vYmFy'],
    ];
    for (const [i, o] of v) expect(base64(asciiToBytes(i))).toBe(o);
    // RFC 7617's example credentials
    expect(base64(utf8Bytes('Aladdin:open sesame'))).toBe('QWxhZGRpbjpvcGVuIHNlc2FtZQ==');
  });

  it('reads little-endian fields and NaN past the end', () => {
    const r = new LeReader(Uint8Array.from([0xff, 0xfe, 0x01, 0x80, 0x00]));
    expect(r.u1(0)).toBe(255);
    expect(r.i1(0)).toBe(-1);
    expect(r.u2(0)).toBe(0xfeff);
    expect(r.i2(0)).toBe(-257);
    expect(r.u4(0)).toBe(0x8001feff);
    expect(r.i4(0)).toBe(0x8001feff - 2 ** 32);
    expect(r.u4(2)).toBeNaN();
    expect(r.i4(4)).toBeNaN();
    expect(r.u2(4)).toBeNaN();
    expect(r.i2(-1)).toBeNaN();
    expect(r.u1(5)).toBeNaN();
    expect(r.i1(9)).toBeNaN();
    // a view into a larger buffer keeps its offset
    const big = Uint8Array.from([9, 9, 0x34, 0x12]);
    expect(new LeReader(big.subarray(2)).u2(0)).toBe(0x1234);
  });

  it('writes little-endian fields including 64-bit', () => {
    expect([...new LeWriter().u1(0x1ff).u2(0x1234).u4(0xdeadbeef).bytes()]).toEqual([
      0xff, 0x34, 0x12, 0xef, 0xbe, 0xad, 0xde,
    ]);
    expect([...new LeWriter().u8(2 ** 32 + 2).bytes()]).toEqual([2, 0, 0, 0, 1, 0, 0, 0]);
  });

  it('reads big-endian bit fields, signed and unsigned, and throws RangeError past the end', () => {
    const r = new BitReader(Uint8Array.from([0b1011_0000, 0xff]));
    expect(r.u(1)).toBe(1);
    expect(r.u(3)).toBe(0b011);
    expect(r.remaining).toBe(12);
    expect(r.s(4)).toBe(0);
    r.skip(4);
    expect(r.s(4)).toBe(-1);
    expect(() => r.u(1)).toThrow(RangeError);
    expect(() => r.skip(1)).toThrow(RangeError);
    const s = new BitReader(Uint8Array.from([0x80, 0, 0, 0, 0, 0]), 0);
    expect(s.s(38)).toBe(-(2 ** 37));
    expect(new BitReader(Uint8Array.from([0x0f]), 4).u(4)).toBe(15);
  });
});
