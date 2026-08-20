import type { CustomCategory } from '@core/library/categories';
import type { MapVisibilityMode } from '@core/library/migrations';
import type { Folder, LngLat, TrackPoint, TrackSummary, Waypoint } from '@core/models';

/**
 * The playground's Library index — the browser twin of the app's
 * `library.json`.
 *
 * It is deliberately shaped like `@core/library/migrations#LibraryIndex` minus
 * the parts that need a device: no `MapDocument[]` (no GeoPDF pipeline here,
 * see the README), no `activeMapId`. Everything else is the same field with
 * the same meaning, so every pure selector in `@core/library/*` — the folder
 * grouping, the visibility rules, the filter predicate — consumes it unchanged.
 */
export interface WebLibraryIndex {
  schemaVersion: number;
  folders: Folder[];
  tracks: WebTrack[];
  waypoints: Waypoint[];
  customCategories: CustomCategory[];
  mapVisibilityMode: MapVisibilityMode;
  visibleFolderIds: string[];
  /** True once the Québec demo content has been generated into this browser. */
  demoSeeded: boolean;
}

/**
 * A trail as the Library holds it.
 *
 * It **extends `TrackSummary` rather than replacing it**, which is what lets
 * `filterTracks`, `groupByFolder` and `visibleTrackIds` take these objects
 * verbatim. `fileUri` keeps its meaning — "where the points live" — and simply
 * names an IndexedDB key (`idb://gpx/<id>`) instead of a `file://` path, the
 * same way the app names a document-directory path.
 */
export interface WebTrack extends TrackSummary {
  /**
   * Decimated `[lng, lat]` polyline, ~600 points, stored in the index.
   *
   * The app draws trails from the full GPX because it has already loaded it.
   * Here the full point lists total ~90 000 points across the demo library and
   * live only in IndexedDB, so the index carries a cheap overview line: the map
   * can draw every trail immediately, and the real points are parsed on demand
   * when one trail is opened.
   */
  preview: LngLat[];
  /** Stable trace colour, assigned at import and cycled through a palette. */
  color: string;
}

/** A trail with its points parsed — what the trail-focus screen works on. */
export interface LoadedTrack {
  track: WebTrack;
  points: TrackPoint[];
}
