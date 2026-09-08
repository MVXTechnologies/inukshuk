import type { GeoReference, MapDocument } from '@core/models';
import { cornersAreValid } from '@core/geo/geomath';
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
 * The line for a map that IS georeferenced but in a projection we could not
 * resolve, so its corners never became lon/lat.
 *
 * This is the other half of the same failure mode as
 * {@link NO_GEOREFERENCE_NOTICE}: every CanTopo sheet carried a perfectly good
 * NAD83 / UTM georeference that `crs.ts` did not recognize, so its corners
 * stayed in projected metres, `cornersAreValid` rejected them, and the overlay
 * pipeline skipped the page **without a word** — 2,234 sheets that could be
 * downloaded and listed but never drawn (#243). Naming the CRS is what makes
 * the next unsupported source visible instead of invisible.
 */
export function unsupportedProjectionNotice(crs?: string): string {
  return `Map projection not supported${crs ? ` (${crs})` : ''} — cannot be placed on the map`;
}

/** Can this georeference's corners actually be handed to the map? */
export function isPlaceable(geo: GeoReference): boolean {
  return cornersAreValid(geo.viewport.corners);
}

/**
 * The subtitle line for a map card, or `null` when the map has at least one
 * page that can be drawn (the card then shows its page/overlay counts instead).
 */
export function georeferenceNotice(map: Pick<MapDocument, 'georeferences'>): string | null {
  if (map.georeferences.length === 0) return NO_GEOREFERENCE_NOTICE;
  const primaries = primaryGeoreferences(map.georeferences);
  if (primaries.some(isPlaceable)) return null;
  // Report the CRS of the first page that failed. Documents imported before
  // #243 have no `sourceCrs` at all — they still get the notice, without a
  // name, and must be re-imported to be drawn (the raw projection was never
  // persisted, and projected metres alone cannot identify the projection).
  return unsupportedProjectionNotice(primaries.find((g) => g.sourceCrs)?.sourceCrs);
}
