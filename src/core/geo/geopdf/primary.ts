import type { GeoReference } from '@core/models';

/**
 * Pick the *primary* georeference of a page — the one describing the actual
 * map, not a decorative inset.
 *
 * A published topographic sheet routinely carries several `/Viewport` entries,
 * each with its own `/Measure` dict, and their order in the PDF is arbitrary.
 * Geoscience Australia's AUSTopo sheets are the sharp case: viewport 0 is a
 * 142×142 pt **locator inset showing the whole continent** (111°E–156°E), and
 * the real 1:250 000 map is viewport 1. Taking "the first georeference for this
 * page" — which is what the overlay pipeline used to do — renders every one of
 * those 509 sheets stretched across Australia, in the wrong place. USGS US Topo
 * ships the same three-viewport layout (map, quadrangle location, adjoining
 * sheet diagram) and only happens to list the map first.
 *
 * The map frame is always the largest rectangle on the page: an inset exists to
 * be small. So area wins, with a deterministic tiebreak so the choice never
 * flips between runs on a page with two equal frames.
 */

/** Area of a georeference's map frame, in square PDF points. */
function viewportArea(geo: GeoReference): number {
  const { x0, y0, x1, y1 } = geo.viewport.rect;
  const width = Math.abs(x1 - x0);
  const height = Math.abs(y1 - y0);
  return Number.isFinite(width) && Number.isFinite(height) ? width * height : 0;
}

/**
 * The georeference to render for `pageIndex`: the largest viewport on that
 * page, or `undefined` when the page has none.
 */
export function primaryGeoreferenceForPage(
  georeferences: readonly GeoReference[],
  pageIndex: number,
): GeoReference | undefined {
  let best: GeoReference | undefined;
  let bestArea = -1;
  for (const geo of georeferences) {
    if (geo.pageIndex !== pageIndex) continue;
    const area = viewportArea(geo);
    // Strictly greater keeps the first of equal-area frames — deterministic,
    // and matches the old behaviour on single-viewport documents.
    if (area > bestArea) {
      best = geo;
      bestArea = area;
    }
  }
  return best;
}

/**
 * One georeference per page — the primary of each — in ascending page order.
 * This is the list the Library shows and the overlay pipeline draws, so a
 * three-viewport sheet reads as "1 page", not "3 pages" of the same map.
 */
export function primaryGeoreferences(georeferences: readonly GeoReference[]): GeoReference[] {
  const pages = [...new Set(georeferences.map((g) => g.pageIndex))].sort((a, b) => a - b);
  const primaries: GeoReference[] = [];
  for (const pageIndex of pages) {
    const geo = primaryGeoreferenceForPage(georeferences, pageIndex);
    if (geo !== undefined) primaries.push(geo);
  }
  return primaries;
}
