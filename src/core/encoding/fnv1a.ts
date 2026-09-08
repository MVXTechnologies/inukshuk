/**
 * 32-bit FNV-1a over a string's UTF-16 code units, as 8 hex digits.
 *
 * Not cryptographic — a content fingerprint. Used to version the rasterizer
 * page written into the served folder (#269): the URL carries the hash, so a
 * WebView can never keep serving a copy of the page that predates the code
 * that wrote it. Linear in the input; a 4 MB page hashes in tens of ms.
 */
export function fnv1a32(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    // 32-bit multiply by the FNV prime (16777619) without overflowing doubles.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
