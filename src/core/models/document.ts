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
}
