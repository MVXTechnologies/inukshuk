/**
 * Byte helpers for the team protocol (#589). Pure and total: decoders return
 * `undefined` on bad input instead of throwing, because every byte they see
 * may come from a hostile peer.
 *
 * Hermes ships no `Buffer`/`btoa`, and its `TextEncoder` is recent, so UTF-8
 * and base64url are hand-rolled here (boring loops, no stack tricks).
 */

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
/** char code → 6-bit value, -1 for anything outside the base64url alphabet. */
const B64URL_INDEX = new Int16Array(128).fill(-1);
for (let i = 0; i < B64URL.length; i++) B64URL_INDEX[B64URL.charCodeAt(i)] = i;

function sextet(text: string, i: number): number {
  const code = text.charCodeAt(i);
  return code < 128 ? B64URL_INDEX[code]! : -1;
}

/** Unpadded base64url (RFC 4648 §5) — the only binary-to-text form on the wire. */
export function toB64u(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += B64URL[b0 >> 2]!;
    out += B64URL[((b0 & 3) << 4) | (b1 >> 4)]!;
    if (i + 1 < bytes.length) out += B64URL[((b1 & 15) << 2) | (b2 >> 6)]!;
    if (i + 2 < bytes.length) out += B64URL[b2 & 63]!;
  }
  return out;
}

/**
 * Whether `text` is the canonical unpadded base64url of exactly `length`
 * bytes — checked without decoding (ids are validated far more often than
 * they are decoded).
 */
export function isB64uLen(text: unknown, length: number): text is string {
  if (typeof text !== 'string' || text.length !== Math.ceil((length * 4) / 3)) return false;
  for (let i = 0; i < text.length; i++) if (sextet(text, i) < 0) return false;
  const last = sextet(text, text.length - 1);
  const rem = length % 3;
  return rem === 0 || (rem === 1 ? (last & 15) === 0 : (last & 3) === 0);
}

/**
 * Decode unpadded base64url. Strict: rejects padding, foreign characters, an
 * impossible length (n % 4 === 1) and non-zero trailing bits, so every byte
 * string has exactly one text form (signatures cover the text).
 */
export function fromB64u(text: unknown): Uint8Array | undefined {
  if (typeof text !== 'string' || text.length % 4 === 1) return undefined;
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let o = 0;
  let i = 0;
  for (; i + 4 <= text.length; i += 4) {
    const c0 = sextet(text, i);
    const c1 = sextet(text, i + 1);
    const c2 = sextet(text, i + 2);
    const c3 = sextet(text, i + 3);
    if ((c0 | c1 | c2 | c3) < 0) return undefined;
    out[o++] = (c0 << 2) | (c1 >> 4);
    out[o++] = ((c1 & 15) << 4) | (c2 >> 2);
    out[o++] = ((c2 & 3) << 6) | c3;
  }
  const rest = text.length - i;
  if (rest >= 2) {
    const c0 = sextet(text, i);
    const c1 = sextet(text, i + 1);
    if ((c0 | c1) < 0) return undefined;
    out[o++] = (c0 << 2) | (c1 >> 4);
    if (rest === 2) {
      if ((c1 & 15) !== 0) return undefined; // non-canonical trailing bits
    } else {
      const c2 = sextet(text, i + 2);
      if (c2 < 0 || (c2 & 3) !== 0) return undefined;
      out[o++] = ((c1 & 15) << 4) | (c2 >> 2);
    }
  }
  return out;
}

/** {@link fromB64u}, additionally requiring an exact decoded length. */
export function fromB64uLen(text: unknown, length: number): Uint8Array | undefined {
  return isB64uLen(text, length) ? fromB64u(text) : undefined;
}

const encoder: { encode(s: string): Uint8Array } | undefined =
  typeof TextEncoder === 'undefined' ? undefined : new TextEncoder();

/** UTF-8 encode. Lone surrogates become U+FFFD (as `TextEncoder` does). */
export function utf8(text: string): Uint8Array {
  if (encoder !== undefined) return encoder.encode(text);
  return utf8Slow(text);
}

/** The portable encoder (exported for tests; Hermes builds without `TextEncoder`). */
export function utf8Slow(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let cp = text.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < text.length) {
      const lo = text.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      }
    }
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 63),
        0x80 | ((cp >> 6) & 63),
        0x80 | (cp & 63),
      );
    }
  }
  return Uint8Array.from(out);
}

/** Strict UTF-8 decode: `undefined` on any malformed, overlong or surrogate sequence. */
export function utf8Decode(bytes: Uint8Array): string | undefined {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i]!;
    let cp: number;
    let need: number;
    let min: number;
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
      i++;
      continue;
    } else if ((b0 & 0xe0) === 0xc0) [cp, need, min] = [b0 & 0x1f, 1, 0x80];
    else if ((b0 & 0xf0) === 0xe0) [cp, need, min] = [b0 & 0x0f, 2, 0x800];
    else if ((b0 & 0xf8) === 0xf0) [cp, need, min] = [b0 & 0x07, 3, 0x10000];
    else return undefined;
    for (let k = 1; k <= need; k++) {
      const b = bytes[i + k];
      if (b === undefined || (b & 0xc0) !== 0x80) return undefined;
      cp = (cp << 6) | (b & 0x3f);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return undefined;
    out += String.fromCodePoint(cp);
    i += need + 1;
  }
  return out;
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Length-checked equality that does not exit early on the first differing byte. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function isAllZero(bytes: Uint8Array): boolean {
  let acc = 0;
  for (const b of bytes) acc |= b;
  return acc === 0;
}

/** Lowercase hex — for fingerprints and test vectors. */
export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function fromHex(text: string): Uint8Array | undefined {
  if (text.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(text)) return undefined;
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}
