/**
 * Marked-trail databases the map can drape as tile overlays. All served by
 * Waymarked Trails (waymarkedtrails.org, ODbL/OSM data, transparent PNG
 * tiles) — one endpoint per activity network, each independently checkable.
 */

export const TRAIL_NETWORKS = [
  { id: 'hiking', label: 'Hiking' },
  { id: 'cycling', label: 'Cycling' },
  { id: 'mtb', label: 'Mountain biking' },
  { id: 'riding', label: 'Horse riding' },
  { id: 'slopes', label: 'Winter slopes' },
] as const;

export type TrailNetworkId = (typeof TRAIL_NETWORKS)[number]['id'];

export const TRAIL_NETWORK_IDS: readonly TrailNetworkId[] = TRAIL_NETWORKS.map((n) => n.id);

export function isTrailNetworkId(v: unknown): v is TrailNetworkId {
  return typeof v === 'string' && (TRAIL_NETWORK_IDS as readonly string[]).includes(v);
}

/** Tile URL template ({z}/{x}/{y}) for a network. */
export function trailNetworkTileUrl(id: TrailNetworkId): string {
  return `https://tile.waymarkedtrails.org/${id}/{z}/{x}/{y}.png`;
}

/** Drop junk from a persisted network list (settings hydration). */
export function sanitizeTrailNetworks(v: unknown): TrailNetworkId[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isTrailNetworkId);
}
