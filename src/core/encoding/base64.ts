const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Plain base64 encoder for binary payloads (e.g. an encoded PNG destined for
 * `storage.writeOverlayPng`). Hermes ships no `btoa`/`Buffer`, and the chunked
 * `String.fromCharCode.apply` trick overflows the stack on megabyte inputs —
 * so: a boring, dependency-free loop.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out.push(
      ALPHABET[b0 >> 2]!,
      ALPHABET[((b0 & 3) << 4) | (b1 >> 4)]!,
      i + 1 < bytes.length ? ALPHABET[((b1 & 15) << 2) | (b2 >> 6)]! : '=',
      i + 2 < bytes.length ? ALPHABET[b2 & 63]! : '=',
    );
  }
  return out.join('');
}

const DECODE = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) t[ALPHABET.charCodeAt(i)] = i;
  return t;
})();

/**
 * Strict standard-alphabet base64 decoder, the inverse of
 * {@link bytesToBase64}. Padding is optional. Returns null on any other
 * character, a misplaced `=`, non-zero padding bits or an impossible length,
 * so a corrupt payload is reported instead of becoming silently wrong bytes.
 * On the hot path of native byte events (GNSS receivers): one pass, no
 * intermediate strings.
 */
export function base64ToBytes(text: string): Uint8Array | null {
  let len = text.length;
  if (len % 4 === 0 && len > 0) {
    if (text.charCodeAt(len - 1) === 61) len--;
    if (text.charCodeAt(len - 1) === 61) len--;
  }
  if (len % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((len * 3) / 4));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < len; i++) {
    const c = text.charCodeAt(i);
    const v = c < 128 ? (DECODE[c] ?? -1) : -1;
    if (v < 0) return null;
    acc = ((acc << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  // Leftover bits are padding and must be zero (canonical encoding).
  if ((acc & ((1 << bits) - 1)) !== 0) return null;
  return out;
}
