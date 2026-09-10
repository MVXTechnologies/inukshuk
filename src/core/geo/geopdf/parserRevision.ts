/**
 * Which version of the GeoPDF parser produced a stored georeference.
 *
 * Georeferencing is parsed ONCE, at import, and persisted in `library.json`.
 * Updating the app never re-parsed an already-imported map, so every parser
 * fix reached new imports only — a map imported on the 7th kept the corners
 * the 7th's parser gave it, forever (#336: an owner's Anticosti sheet still
 * drew upside down on 1.5.1, weeks after the fix shipped).
 *
 * Bumping this number is the signal to re-parse. Add a line whenever a change
 * makes the parser produce DIFFERENT output for some real file; a change that
 * only widens what parses (a new source, a better warning) does not need one,
 * because the documents it affects have no georeferencing to replace.
 *
 * 1. The shipping state before any of this (documents with no stamp).
 * 2. #270 — `/GPTS` is paired with the file's own `/LPTS`, not the ISO default
 *    order. Sheets whose producer lists corners upper-left first drew
 *    vertically flipped; one UTM export drew transposed.
 * 3. #287 — the rendered page box (CropBox ∩ MediaBox, origin included) is
 *    recorded as `pageBox` and used for placement. Cropped or shifted-origin
 *    pages were drawn at the wrong extent.
 */
export const GEOPDF_PARSER_REVISION = 3;

/**
 * The revision a stored georeference was produced by. Anything unstamped
 * predates the stamp itself, which is revision 1.
 */
export function georeferenceRevision(value: { parserRevision?: number } | undefined): number {
  const stamped = value?.parserRevision;
  return typeof stamped === 'number' && Number.isFinite(stamped) && stamped > 0 ? stamped : 1;
}

/**
 * Does this document's georeferencing predate the current parser?
 *
 * A document with NO georeferences is included: the parser may since have
 * learned to place it (#249 taught it the CanTopo projection, and those
 * sheets are stored flagged "no georeferencing found"). Re-parsing one costs
 * a few hundred KB now that the reader works by random access (#328).
 */
export function needsReparse(doc: {
  georeferences?: readonly { parserRevision?: number }[];
}): boolean {
  const refs = doc.georeferences ?? [];
  if (refs.length === 0) return true;
  return refs.some((g) => georeferenceRevision(g) < GEOPDF_PARSER_REVISION);
}
