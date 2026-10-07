/**
 * Byte helpers for the GNSS protocols: little-endian reads (UBX), a
 * big-endian bit reader (RTCM 3), ASCII conversion and base64 (NTRIP Basic
 * auth). Pure: no Buffer, no TextEncoder, so the same code runs in Hermes,
 * Node and Jest.
 */

/** Concatenate byte arrays. */
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Latin-1 bytes → string (each byte one code unit). NMEA and HTTP headers are ASCII. */
export function bytesToAscii(b: Uint8Array, start = 0, end = b.length): string {
  let s = '';
  for (let i = start; i < end; i++) s += String.fromCharCode(b[i] as number);
  return s;
}

/** String → bytes; code units above 0xFF become '?' (callers send ASCII only). */
export function asciiToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[i] = c > 0xff ? 0x3f : c;
  }
  return out;
}

/** String → UTF-8 bytes (credentials may hold accents). */
export function utf8Bytes(s: string): Uint8Array {
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else
      out.push(
        0xf0 | (c >> 18),
        0x80 | ((c >> 12) & 0x3f),
        0x80 | ((c >> 6) & 0x3f),
        0x80 | (c & 0x3f),
      );
  }
  return Uint8Array.from(out);
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** RFC 4648 base64 of bytes. */
export function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    s += B64[(n >> 18) & 63];
    s += B64[(n >> 12) & 63];
    s += b === undefined ? '=' : B64[(n >> 6) & 63];
    s += c === undefined ? '=' : B64[n & 63];
  }
  return s;
}

/** Little-endian reader over a payload (UBX). Reads past the end return NaN. */
export class LeReader {
  private readonly view: DataView;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  private ok(off: number, n: number): boolean {
    return off >= 0 && off + n <= this.bytes.length;
  }
  u1(off: number): number {
    return this.ok(off, 1) ? this.view.getUint8(off) : NaN;
  }
  i1(off: number): number {
    return this.ok(off, 1) ? this.view.getInt8(off) : NaN;
  }
  u2(off: number): number {
    return this.ok(off, 2) ? this.view.getUint16(off, true) : NaN;
  }
  i2(off: number): number {
    return this.ok(off, 2) ? this.view.getInt16(off, true) : NaN;
  }
  u4(off: number): number {
    return this.ok(off, 4) ? this.view.getUint32(off, true) : NaN;
  }
  i4(off: number): number {
    return this.ok(off, 4) ? this.view.getInt32(off, true) : NaN;
  }
}

/** Little-endian writer for building UBX payloads. */
export class LeWriter {
  private readonly out: number[] = [];
  u1(v: number): this {
    this.out.push(v & 0xff);
    return this;
  }
  u2(v: number): this {
    this.out.push(v & 0xff, (v >>> 8) & 0xff);
    return this;
  }
  u4(v: number): this {
    this.out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
    return this;
  }
  /** 64-bit unsigned from a non-negative safe integer. */
  u8(v: number): this {
    const lo = v % 0x1_0000_0000;
    const hi = Math.floor(v / 0x1_0000_0000);
    return this.u4(lo).u4(hi);
  }
  bytes(): Uint8Array {
    return Uint8Array.from(this.out);
  }
}

/**
 * Big-endian bit reader (RTCM 3 data fields are MSB-first bit strings).
 * Reading past the end throws `RangeError`; RTCM decoders catch it and
 * report a malformed message instead of letting it escape.
 */
export class BitReader {
  pos = 0;
  constructor(
    private readonly bytes: Uint8Array,
    startBit = 0,
  ) {
    this.pos = startBit;
  }
  get remaining(): number {
    return this.bytes.length * 8 - this.pos;
  }
  /** Unsigned field of `n` bits (n ≤ 53). */
  u(n: number): number {
    if (n > this.remaining) throw new RangeError('RTCM field past end of message');
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.bytes[(this.pos + i) >> 3] as number;
      const bit = (byte >> (7 - ((this.pos + i) & 7))) & 1;
      v = v * 2 + bit;
    }
    this.pos += n;
    return v;
  }
  /** Two's-complement signed field of `n` bits (n ≤ 53). */
  s(n: number): number {
    const v = this.u(n);
    const half = 2 ** (n - 1);
    return v >= half ? v - 2 * half : v;
  }
  skip(n: number): void {
    if (n > this.remaining) throw new RangeError('RTCM field past end of message');
    this.pos += n;
  }
}
