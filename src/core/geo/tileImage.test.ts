import { fnv1a32, isLikelyImageBytes, isOsmBlockedPolicyTile, isValidTileBytes } from './tileImage';

// The real 'Access blocked' policy tile served by tile.openstreetmap.org to
// unapproved app User-Agents (captured 2026-07-17; HTTP 200, image/png). Kept
// as a fixture so the fingerprint in tileImage.ts is verified against the
// genuine asset, not a hand-copied constant.
const OSM_BLOCKED_TILE_B64 = [
  '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',
  'QmCC',
].join('');

function fromBase64(b64: string): Uint8Array {
  const bin = Buffer.from(b64, 'base64');
  return new Uint8Array(bin.buffer, bin.byteOffset, bin.byteLength);
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

describe('isLikelyImageBytes', () => {
  it('accepts PNG and JPEG magic bytes', () => {
    expect(isLikelyImageBytes(new Uint8Array([...PNG_MAGIC, 0x0d, 0x0a]))).toBe(true);
    expect(isLikelyImageBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
  });

  it('rejects empty, tiny, and non-image payloads (HTML error pages)', () => {
    expect(isLikelyImageBytes(new Uint8Array(0))).toBe(false);
    expect(isLikelyImageBytes(new Uint8Array([0x89]))).toBe(false);
    const html = new TextEncoder().encode('<html><body>Blocked</body></html>');
    expect(isLikelyImageBytes(html)).toBe(false);
  });
});

describe('fnv1a32', () => {
  it('matches the published FNV-1a 32-bit test vectors', () => {
    expect(fnv1a32(new Uint8Array(0))).toBe(0x811c9dc5);
    expect(fnv1a32(new TextEncoder().encode('a'))).toBe(0xe40c292c);
    expect(fnv1a32(new TextEncoder().encode('foobar'))).toBe(0xbf9cf968);
  });
});

describe('isOsmBlockedPolicyTile', () => {
  const blocked = fromBase64(OSM_BLOCKED_TILE_B64);

  it('recognizes the real captured policy tile', () => {
    expect(blocked.length).toBe(6987);
    expect(isOsmBlockedPolicyTile(blocked)).toBe(true);
    expect(isValidTileBytes(blocked)).toBe(false);
  });

  it('does not flag other buffers, even at the same length', () => {
    const sameLength = new Uint8Array(blocked);
    sameLength[100] = sameLength[100]! ^ 0xff; // same length, different content
    expect(isOsmBlockedPolicyTile(sameLength)).toBe(false);

    const differentLength = blocked.slice(0, 4096);
    expect(isOsmBlockedPolicyTile(differentLength)).toBe(false);
  });
});

describe('isValidTileBytes', () => {
  it('accepts an ordinary PNG tile', () => {
    const png = new Uint8Array([...PNG_MAGIC, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    expect(isValidTileBytes(png)).toBe(true);
  });
});
