import type { Folder, MapDocument, TrackSummary, Waypoint } from '@core/models';

/**
 * Pure helpers for the folder feature (organizing maps, trails and waypoints
 * by area). No platform deps — the Zustand store and UI are thin wrappers over
 * these.
 */

/**
 * A folder together with the items currently assigned to it.
 *
 * Generic over the trail type — see {@link groupByFolder}. The parameter
 * defaults to `TrackSummary`, so plain `FolderGroup` still means what it
 * always did.
 */
export interface FolderGroup<T extends TrackSummary = TrackSummary> {
  folder: Folder;
  maps: MapDocument[];
  tracks: T[];
  waypoints: Waypoint[];
}

/** The full folder view: one group per folder, plus the un-foldered leftovers. */
export interface FolderGrouping<T extends TrackSummary = TrackSummary> {
  groups: FolderGroup<T>[];
  ungroupedMaps: MapDocument[];
  ungroupedTracks: T[];
  ungroupedWaypoints: Waypoint[];
}

/**
 * Bucket maps, trails and waypoints into their folders. Groups are returned in
 * `folders` order (each folder always appears, even when empty). Items whose
 * `folderId` is unset — or points at a folder that no longer exists — fall
 * through to the ungrouped leftovers, preserving their original order.
 *
 * Generic OVER `TrackSummary` for the same reason as `filterTracks`: a caller
 * with a richer trail type gets its own elements back, not widened ones.
 */
export function groupByFolder<T extends TrackSummary>(
  folders: readonly Folder[],
  maps: readonly MapDocument[],
  tracks: readonly T[],
  waypoints: readonly Waypoint[],
): FolderGrouping<T> {
  const indexOf = new Map(folders.map((f, i) => [f.id, i]));
  const groups: FolderGroup<T>[] = folders.map((f) => ({
    folder: f,
    maps: [],
    tracks: [],
    waypoints: [],
  }));
  const ungroupedMaps: MapDocument[] = [];
  const ungroupedTracks: T[] = [];
  const ungroupedWaypoints: Waypoint[] = [];

  const bucket = <I extends { folderId?: string }>(
    items: readonly I[],
    pick: (g: FolderGroup<T>) => I[],
    ungrouped: I[],
  ) => {
    for (const item of items) {
      const idx = item.folderId !== undefined ? indexOf.get(item.folderId) : undefined;
      if (idx === undefined) ungrouped.push(item);
      else pick(groups[idx]!).push(item);
    }
  };
  bucket(maps, (g) => g.maps, ungroupedMaps);
  bucket(tracks, (g) => g.tracks, ungroupedTracks);
  bucket(waypoints, (g) => g.waypoints, ungroupedWaypoints);

  return { groups, ungroupedMaps, ungroupedTracks, ungroupedWaypoints };
}

/** Total number of items (maps + trails + waypoints) in a folder group. */
export function folderItemCount<T extends TrackSummary>(group: FolderGroup<T>): number {
  return group.maps.length + group.tracks.length + group.waypoints.length;
}
