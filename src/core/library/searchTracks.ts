import type { Folder, TrackSummary } from '@core/models';

/**
 * Pure text search over the Library's trail list — the fourth pure pass beside
 * {@link filterTracks}, {@link sortTracks} and `groupByFolder`, composed in
 * that order: `searchTracks` → `filterTracks` → `sortTracks` → `groupByFolder`.
 * Search runs FIRST because it is the coarsest cut (the user typed a name;
 * everything else refines what that name found), and because narrowing before
 * the comparator work means a query never pays to sort trails it just hid.
 *
 * Matching is deliberately forgiving, because this is a Québec app and trail
 * names are full of accents, hyphens and apostrophes nobody types on a phone:
 *
 * - **accent-insensitive** — "eperon" finds "Éperon", via NFD decomposition
 *   plus removal of the combining marks the decomposition exposes;
 * - **separator-insensitive** — "sainte anne" finds "Sainte-Anne", and
 *   "l'ile" finds "L’Île", because every separator (dash, apostrophe of either
 *   shape, slash, punctuation) folds to a single space;
 * - **word-order-insensitive** — the query is split into terms and EVERY term
 *   must appear somewhere, so "anne sainte" still finds "Sainte-Anne";
 * - **case-insensitive**, last, after the folding above.
 *
 * A trail matches on its own name, on the name of the FOLDER it lives in (so
 * typing a folder name narrows the list to that area), and on the text of its
 * notes.
 */

/**
 * Combining marks exposed by NFD decomposition. This is the ASCII-safe
 * spelling of `\p{M}`: the main combining-diacritical block plus its
 * supplements and extensions, avoiding Unicode property escapes, whose support
 * in Hermes we do not want to depend on for something this load-bearing.
 */
const COMBINING_MARKS = /[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20f0\ufe20-\ufe2f]/g;

/**
 * Everything that separates words in a trail name. Folding these to a space
 * (rather than deleting them) is what makes "Sainte-Anne" and "Sainte Anne"
 * the same two terms instead of one run-on word.
 */
const SEPARATORS =
  /[\s\-_.,;:!?/\\|()[\]{}<>"@#&+*=~^%$\u0027\u2010-\u2015\u2018-\u201f\u00ab\u00bb\u0060\u00b4]+/g;

/**
 * Fold one string to its comparable form: decompose, drop accents, replace
 * separator runs with a single space, lowercase, trim.
 *
 * Exported for the callers that build their own haystacks (and for the tests
 * that pin the folding table); `searchTracks` is the normal entry point.
 */
export function foldForSearch(value: string): string {
  return value
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .replace(SEPARATORS, ' ')
    .toLowerCase()
    .trim();
}

/**
 * The folded terms of a query. An empty or separators-only query yields no
 * terms, which is how {@link isSearchActive} recognizes "not searching".
 */
export function searchTerms(query: string): string[] {
  const folded = foldForSearch(query);
  return folded === '' ? [] : folded.split(' ');
}

/** True when a query actually constrains anything (blank/punctuation = no). */
export function isSearchActive(query: string): boolean {
  return searchTerms(query).length > 0;
}

/**
 * Everything one trail is searchable by, folded and joined: its name, its
 * folder's name, and its notes' text. Joined with a space so a term can never
 * straddle two fields ("anne" + "sainte" from different fields still match,
 * but no term matches a boundary that does not exist in either).
 */
function haystack(track: TrackSummary, folderNames: ReadonlyMap<string, string>): string {
  const parts: string[] = [foldForSearch(typeof track.name === 'string' ? track.name : '')];
  const folderName = track.folderId === undefined ? undefined : folderNames.get(track.folderId);
  if (folderName !== undefined) parts.push(foldForSearch(folderName));
  const notes = track.notes;
  if (notes !== undefined && notes !== null) {
    for (const note of notes) {
      if (typeof note?.text === 'string' && note.text !== '') parts.push(foldForSearch(note.text));
    }
  }
  return parts.join(' ');
}

/**
 * Does one trail match every term of an already-folded query? Terms are ANDed
 * and matched as substrings, so a partial word ("epe") still finds "Éperon" —
 * at library scale a forgiving match beats a precise one that returns nothing.
 *
 * With no terms this is vacuously true: an empty query hides nothing.
 */
export function matchesTerms(
  track: TrackSummary,
  terms: readonly string[],
  folderNames: ReadonlyMap<string, string>,
): boolean {
  if (terms.length === 0) return true;
  const hay = haystack(track, folderNames);
  return terms.every((term) => hay.includes(term));
}

/**
 * Narrow the trail list to those matching `query`, preserving order. A blank
 * query returns the input array AS-IS (stable identity for memoized
 * consumers), exactly like `filterTracks` with no active criteria.
 *
 * `folders` is optional: pass the library's folders to make folder names
 * searchable; omit them and search covers names and notes only.
 *
 * Generic OVER `TrackSummary` for the same reason as its three sibling passes:
 * a caller holding a richer trail type gets its own element type back, so the
 * four compose without a widening round-trip.
 */
export function searchTracks<T extends TrackSummary>(
  tracks: readonly T[],
  query: string,
  folders: readonly Folder[] = [],
): readonly T[] {
  const terms = searchTerms(query);
  if (terms.length === 0) return tracks;
  const folderNames = new Map(folders.map((f) => [f.id, f.name]));
  return tracks.filter((t) => matchesTerms(t, terms, folderNames));
}
