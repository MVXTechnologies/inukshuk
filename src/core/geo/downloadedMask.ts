import type { BoundingBox } from '@core/models';
import type { Feature, Polygon, Position } from 'geojson';

/**
 * Extent covered by the "locally downloaded only" mask: the full longitude
 * range, with latitude clamped just inside web mercator's usable range
 * (±85.051…°) so the ring stays valid for MapLibre's projection.
 */
export const MASK_WORLD: BoundingBox = { minLng: -180, maxLng: 180, minLat: -85, maxLat: 85 };

/** A region clamped to {@link MASK_WORLD}, or null when nothing remains. */
function clampToWorld(b: BoundingBox): BoundingBox | null {
  const r: BoundingBox = {
    minLng: Math.max(b.minLng, MASK_WORLD.minLng),
    maxLng: Math.min(b.maxLng, MASK_WORLD.maxLng),
    minLat: Math.max(b.minLat, MASK_WORLD.minLat),
    maxLat: Math.min(b.maxLat, MASK_WORLD.maxLat),
  };
  return r.minLng < r.maxLng && r.minLat < r.maxLat ? r : null;
}

/** The parts of `r` NOT covered by `cut`: 0–4 disjoint rectangles. */
function subtract(r: BoundingBox, cut: BoundingBox): BoundingBox[] {
  const disjoint =
    cut.minLng >= r.maxLng ||
    cut.maxLng <= r.minLng ||
    cut.minLat >= r.maxLat ||
    cut.maxLat <= r.minLat;
  if (disjoint) return [r];
  const out: BoundingBox[] = [];
  // Full-width bands below and above the cut…
  if (cut.minLat > r.minLat) out.push({ ...r, maxLat: cut.minLat });
  if (cut.maxLat < r.maxLat) out.push({ ...r, minLat: cut.maxLat });
  // …then side bands spanning only the overlapped latitude range.
  const midMinLat = Math.max(r.minLat, cut.minLat);
  const midMaxLat = Math.min(r.maxLat, cut.maxLat);
  if (cut.minLng > r.minLng) {
    out.push({ minLng: r.minLng, maxLng: cut.minLng, minLat: midMinLat, maxLat: midMaxLat });
  }
  if (cut.maxLng < r.maxLng) {
    out.push({ minLng: cut.maxLng, maxLng: r.maxLng, minLat: midMinLat, maxLat: midMaxLat });
  }
  return out;
}

/**
 * Exterior world ring, wound counter-clockwise — RFC 7946's required winding
 * for a polygon's outer ring, which MapLibre's fill triangulation also treats
 * as "this is the filled area".
 */
function worldRing(): Position[] {
  return [
    [MASK_WORLD.minLng, MASK_WORLD.minLat],
    [MASK_WORLD.maxLng, MASK_WORLD.minLat],
    [MASK_WORLD.maxLng, MASK_WORLD.maxLat],
    [MASK_WORLD.minLng, MASK_WORLD.maxLat],
    [MASK_WORLD.minLng, MASK_WORLD.minLat],
  ];
}

/** A hole ring for one rectangle, wound clockwise (RFC 7946 inner-ring winding). */
function holeRing(r: BoundingBox): Position[] {
  return [
    [r.minLng, r.minLat],
    [r.minLng, r.maxLat],
    [r.maxLng, r.maxLat],
    [r.maxLng, r.minLat],
    [r.minLng, r.minLat],
  ];
}

/**
 * The "locally downloaded only" mask: one world-covering polygon with a hole
 * punched over each downloaded region, so a single opaque fill layer hides the
 * whole basemap EXCEPT where tiles were actually downloaded.
 *
 * Overlapping regions are first reduced to an equivalent set of DISJOINT
 * rectangles (later boxes have the earlier ones subtracted away). Overlapping
 * hole rings would be geometrically invalid and triangulate unpredictably in
 * MapLibre; disjoint holes always render correctly.
 *
 * Winding follows RFC 7946: counter-clockwise exterior, clockwise holes.
 */
export function buildDownloadedMask(regions: readonly BoundingBox[]): Feature<Polygon> {
  const disjoint: BoundingBox[] = [];
  for (const region of regions) {
    const clamped = clampToWorld(region);
    if (!clamped) continue;
    let pieces: BoundingBox[] = [clamped];
    for (const existing of disjoint) {
      pieces = pieces.flatMap((p) => subtract(p, existing));
    }
    disjoint.push(...pieces);
  }
  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [worldRing(), ...disjoint.map(holeRing)] },
    properties: {},
  };
}
