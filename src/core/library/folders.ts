import type { Folder, MapDocument, TrackSummary, Waypoint } from '@core/models';

/**
 * Pure helpers for the folder feature (organizing maps, trails and waypoints
 * by area). No platform deps — the Zustand store and UI are thin wrappers over
 * these.
 */

/** A folder together with the items currently assigned to it. */
export interface FolderGroup {
  folder: Folder;
  maps: MapDocument[];
  tracks: TrackSummary[];
  waypoints: Waypoint[];
}

/** The full folder view: one group per folder, plus the un-foldered leftovers. */
export interface FolderGrouping {
  groups: FolderGroup[];
  ungroupedMaps: MapDocument[];
  ungroupedTracks: TrackSummary[];
  ungroupedWaypoints: Waypoint[];
}

/**
 * Bucket maps, trails and waypoints into their folders. Groups are returned in
 * `folders` order (each folder always appears, even when empty). Items whose
 * `folderId` is unset — or points at a folder that no longer exists — fall
 * through to the ungrouped leftovers, preserving their original order.
 */
export function groupByFolder(
  folders: readonly Folder[],
  maps: readonly MapDocument[],
  tracks: readonly TrackSummary[],
  waypoints: readonly Waypoint[],
): FolderGrouping {
  const indexOf = new Map(folders.map((f, i) => [f.id, i]));
  const groups: FolderGroup[] = folders.map((f) => ({
    folder: f,
    maps: [],
    tracks: [],
    waypoints: [],
  }));
  const ungroupedMaps: MapDocument[] = [];
  const ungroupedTracks: TrackSummary[] = [];
  const ungroupedWaypoints: Waypoint[] = [];

  const bucket = <T extends { folderId?: string }>(
    items: readonly T[],
    pick: (g: FolderGroup) => T[],
    ungrouped: T[],
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
export function folderItemCount(group: FolderGroup): number {
  return group.maps.length + group.tracks.length + group.waypoints.length;
}
