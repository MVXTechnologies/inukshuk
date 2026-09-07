import type { GeoReference, MapDocument } from '@core/models';
import { primaryGeoreferences } from '@core/geo/geopdf/primary';

/**
 * The overlay-page rules a freshly parsed PDF lands with, and the line the
 * Library card shows when a PDF carries no georeferencing at all.
 *
 * Pure so both the import path (`@features/library/importMap`) and the Library
 * card read the same rules — the two disagreeing is exactly how a map can end
 * up in the library that the overlay pipeline will never draw (#236).
 */

/**
 * The pages a newly imported map starts with active: **every georeferenced
 * page**, once each.
 *
 * One PAGE may carry several viewports (US Topo and AUSTopo sheets put a
 * locator inset and an adjoining-sheet diagram beside the map), so this is the
 * distinct page indexes — never one entry per viewport, which would activate
 * the same page three times and stack three copies of the same raster.
 *
 * A PDF with no georeferencing yields `[]`: there is nothing that could be
 * placed on the map, and the card says so (see {@link georeferenceNotice}).
 */
export function defaultActivePages(georeferences: readonly GeoReference[]): number[] {
  return primaryGeoreferences(georeferences).map((g) => g.pageIndex);
}

/**
 * What the Library card tells the user about a map that has no georeferenced
 * page — plain language, not the parser's diagnostic.
 *
 * The raw `georeferenceWarning` (e.g. "no embedded georeferencing (VP/Measure
 * GEO or LGIDict) found") stays on the document for error reports, but it is
 * jargon, it is sometimes absent entirely (older documents, and any map whose
 * warning was never persisted), and an absent warning rendered as the card's
 * only subtitle left a blank line under the name — a map that silently cannot
 * be drawn and never says why.
 */
export const NO_GEOREFERENCE_NOTICE =
  'No georeferencing found — this PDF cannot be placed on the map';

/**
 * The subtitle line for a map card, or `null` when the map has georeferenced
 * pages (the card then shows its page/overlay counts instead).
 */
export function georeferenceNotice(
  map: Pick<MapDocument, 'georeferences'>,
): typeof NO_GEOREFERENCE_NOTICE | null {
  return map.georeferences.length === 0 ? NO_GEOREFERENCE_NOTICE : null;
}
