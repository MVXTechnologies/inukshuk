import type { WhiteKeyLevel } from '@core/geo/pdfWhiteKey';
import type { GeoReference } from './georeference';

/** An imported georeferenced PDF map and its resolved georeferencing. */
export interface MapDocument {
  id: string;
  name: string;
  /** Absolute file:// uri of the PDF stored in app storage. */
  fileUri: string;
  importedAt: number;
  pageCount: number;
  /** Every georeferenced page resolved from the PDF (one entry per such page). */
  georeferences: GeoReference[];
  /** Page indexes currently rendered as map overlays (a subset of georeferences). */
  activePages: number[];
  /** Interrupted renders stay paused with an actionable Library notice until explicit retry. */
  renderRecoveryErrors?: (
    | { pageIndex: number; reason: 'interrupted' }
    | { pageIndex: number; reason: 'render-failed'; message: string }
  )[];
  /** Human-readable note when georeferencing failed or is partial. */
  georeferenceWarning?: string;
  /** Id of the {@link Folder} this map is organized under; undefined = Ungrouped. */
  folderId?: string;
  /**
   * Catalog item this map was downloaded from (Search tab); absent for local
   * imports and made maps. Drives store dedup ("In Library" instead of a
   * second Download) — see `@core/catalog/installStatus`.
   */
  sourceItemId?: string;
  /**
   * The catalog item's `updatedAt` at download time. A manifest revision newer
   * than this shows an "Update" action in the store.
   */
  sourceUpdatedAt?: string;
  /**
   * The catalog item's publisher file `version` (ETag / content hash) at
   * download time. A catalog version that differs shows "Update" (#680).
   */
  sourceVersion?: string;
  /**
   * The map's author credit as the catalog gave it ("Charles Leduc · 2023"),
   * kept so the Library row names the author offline (#680).
   */
  sourceCredit?: string;
  /** The host the publisher gives this map away on ("cartespleinair.org"). */
  sourceFreeAt?: string;
  /** The map's page on the publisher's site. */
  sourcePageUrl?: string;
  /**
   * This map's own "See-through white" level, overriding the global one from
   * the Overlays menu (`@core/geo/pdfWhiteKey`). Absent = follow the global.
   */
  whiteKey?: WhiteKeyLevel;
}
