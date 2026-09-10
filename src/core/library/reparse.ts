import { GEOPDF_PARSER_REVISION, needsReparse } from '@core/geo/geopdf';
import type { GeoReference, MapDocument } from '@core/models';

import { primaryGeoreferences } from '@core/geo/geopdf/primary';

import { defaultActivePages } from './overlayPages';

/**
 * Re-parsing stored maps whose georeferencing predates the current parser
 * (#336).
 *
 * Georeferencing is parsed once at import and persisted, so a parser fix only
 * ever reached NEW imports: an owner's Anticosti sheet still drew upside down
 * on 1.5.1, weeks after the fix for it shipped. This plans the catch-up pass;
 * the platform worker does the reading.
 */

/** A stored map whose georeferencing should be produced again. */
export interface ReparseJob {
  docId: string;
  fileUri: string;
  /** Only for the log/report line — never shown to the user. */
  name: string;
}

/**
 * Which stored maps to re-parse, in Library order.
 *
 * A map with no file cannot be re-parsed, and one already at the current
 * revision has nothing to gain.
 */
export function planReparse(maps: readonly MapDocument[]): ReparseJob[] {
  const jobs: ReparseJob[] = [];
  for (const m of maps) {
    if (!m.fileUri) continue;
    if (!needsReparse(m)) continue;
    jobs.push({ docId: m.id, fileUri: m.fileUri, name: m.name });
  }
  return jobs;
}

/** What a completed re-parse changes on the stored document. */
export interface ReparsePatch {
  georeferences: GeoReference[];
  activePages: number[];
  georeferenceWarning?: string;
}

/**
 * Fold a fresh parse into the stored document.
 *
 * The user's page selection is preserved wherever it still makes sense: a page
 * they had switched off stays off, and one they had on stays on as long as the
 * new parse still places it. Pages that only exist after the re-parse (a sheet
 * the parser has since learned to read) start on, like a fresh import.
 *
 * Returns `null` when the new parse has NO georeferencing while the stored one
 * had some. That is the one case where replacing would lose information: a
 * partial read (a truncated file, a handle that gave up early) must never turn
 * a working map into "no georeferencing found".
 */
export function applyReparse(
  doc: MapDocument,
  parsed: {
    pageCount: number;
    georeferences: readonly GeoReference[];
    warnings: readonly string[];
  },
): ReparsePatch | null {
  const fresh = parsed.georeferences;
  const stored = doc.georeferences ?? [];
  if (fresh.length === 0 && stored.length > 0) return null;

  const storedPages = new Set(stored.map((g) => g.pageIndex));
  const wasActive = new Set(doc.activePages ?? []);
  const freshDefaults = new Set(defaultActivePages([...fresh]));

  const activePages = primaryGeoreferences([...fresh])
    .map((g) => g.pageIndex)
    // Known page: keep the user's choice. New page: on, as a fresh import.
    .filter((page) => (storedPages.has(page) ? wasActive.has(page) : freshDefaults.has(page)));

  return {
    georeferences: fresh.map((g) => ({ ...g, parserRevision: GEOPDF_PARSER_REVISION })),
    activePages,
    georeferenceWarning:
      fresh.length > 0 ? undefined : (parsed.warnings[0] ?? 'No georeferencing found in this PDF.'),
  };
}
