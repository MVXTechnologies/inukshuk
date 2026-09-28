import type { BoundingBox, MapDocument } from '@core/models';

/**
 * Where a map document sits on the ground: the union of its active overlay
 * pages' footprints (all georeferenced pages when none is active). Null when
 * nothing is georeferenced. Used to fly the camera to a map opened from the
 * Library — the map may be hundreds of km from the user.
 */
export function mapDocumentBounds(
  doc: Pick<MapDocument, 'georeferences' | 'activePages'>,
): BoundingBox | null {
  const active = doc.georeferences.filter((g) => doc.activePages.includes(g.pageIndex));
  const pages = active.length > 0 ? active : doc.georeferences;
  let out: BoundingBox | null = null;
  for (const { bbox } of pages) {
    out =
      out === null
        ? { ...bbox }
        : {
            minLat: Math.min(out.minLat, bbox.minLat),
            minLng: Math.min(out.minLng, bbox.minLng),
            maxLat: Math.max(out.maxLat, bbox.maxLat),
            maxLng: Math.max(out.maxLng, bbox.maxLng),
          };
  }
  return out;
}
