/**
 * Validation for downloaded raster tiles (pure — byte inspection only).
 *
 * Tile servers can answer a tile request with a NON-tile 200: OSM's CDN serves
 * a static "Access blocked" policy PNG (osm.wiki/Blocked) to unapproved app
 * User-Agents — HTTP 200, valid PNG, so nothing downstream errors and the
 * policy tile ends up rendered AND poisoning the disk cache (#129). Some CDNs
 * also serve HTML error pages with image content-types.
 */

/** True when the bytes start with a PNG or JPEG magic number. */
export function isLikelyImageBytes(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  // PNG: 89 50 4E 47
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return true;
  // JPEG: FF D8
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return true;
  return false;
}

/** FNV-1a 32-bit hash — tiny, dependency-free content fingerprint. */
export function fnv1a32(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i]!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

// Fingerprint of tile.openstreetmap.org's "Access blocked" policy tile as
// served on 2026-07-17 (byte-identical across tile coordinates). If OSM ever
// redesigns the image this stops matching — that only re-allows caching it,
// never rejects a real tile.
const OSM_BLOCKED_TILE_LENGTH = 6987;
const OSM_BLOCKED_TILE_FNV1A32 = 0x72301ff3;

/** True when the bytes are OSM's known "Access blocked" policy tile. */
export function isOsmBlockedPolicyTile(bytes: Uint8Array): boolean {
  return bytes.length === OSM_BLOCKED_TILE_LENGTH && fnv1a32(bytes) === OSM_BLOCKED_TILE_FNV1A32;
}

/**
 * Is this downloaded buffer a usable map tile? Rejects empty/truncated
 * responses, non-image payloads (HTML error pages), and the known OSM
 * policy-block tile.
 */
export function isValidTileBytes(bytes: Uint8Array): boolean {
  return isLikelyImageBytes(bytes) && !isOsmBlockedPolicyTile(bytes);
}
