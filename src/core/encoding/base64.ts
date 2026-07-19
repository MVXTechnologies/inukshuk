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
