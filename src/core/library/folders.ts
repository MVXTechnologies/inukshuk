import type { Area, Folder, MapDocument, TrackSummary, Waypoint } from '@core/models';

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
  /** Drawn areas filed in the folder (#711; areas could not be filed before). */
  areas: Area[];
}

/** The full folder view: one group per folder, plus the un-foldered leftovers. */
export interface FolderGrouping<T extends TrackSummary = TrackSummary> {
  groups: FolderGroup<T>[];
  ungroupedMaps: MapDocument[];
  ungroupedTracks: T[];
  ungroupedWaypoints: Waypoint[];
  ungroupedAreas: Area[];
}

/**
 * Bucket maps, trails, waypoints and areas into their folders. Groups are returned in
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
  areas: readonly Area[] = [],
): FolderGrouping<T> {
  const indexOf = new Map(folders.map((f, i) => [f.id, i]));
  const groups: FolderGroup<T>[] = folders.map((f) => ({
    folder: f,
    maps: [],
    tracks: [],
    waypoints: [],
    areas: [],
  }));
  const ungroupedMaps: MapDocument[] = [];
  const ungroupedTracks: T[] = [];
  const ungroupedWaypoints: Waypoint[] = [];
  const ungroupedAreas: Area[] = [];

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
  bucket(areas, (g) => g.areas, ungroupedAreas);

  return { groups, ungroupedMaps, ungroupedTracks, ungroupedWaypoints, ungroupedAreas };
}

/** One folder in tree order, with how deep it sits (0: top level). */
export interface FolderNode {
  folder: Folder;
  depth: number;
  /** Its ancestors' ids, nearest first (collapsing one hides it). */
  ancestors: string[];
}

/**
 * Folders in tree order (#712: sub-folders, kept from shared folders): each
 * parent before its children, siblings in their given order. A parent that
 * no longer exists, or a cycle, puts the folder at the top level.
 */
export function folderTree(folders: readonly Folder[]): FolderNode[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  /** The effective parent: an existing folder that is not its own ancestor. */
  const parentOf = (f: Folder): string | undefined => {
    const seen = new Set([f.id]);
    let p = f.parentId;
    while (p !== undefined) {
      if (seen.has(p) || !byId.has(p)) return undefined;
      seen.add(p);
      p = byId.get(p)!.parentId;
    }
    return f.parentId;
  };
  const kids = new Map<string | undefined, Folder[]>();
  for (const f of folders) {
    const p = parentOf(f);
    const list = kids.get(p);
    if (list === undefined) kids.set(p, [f]);
    else list.push(f);
  }
  const out: FolderNode[] = [];
  const visit = (parent: string | undefined, depth: number, ancestors: string[]) => {
    for (const f of kids.get(parent) ?? []) {
      out.push({ folder: f, depth, ancestors });
      visit(f.id, depth + 1, [f.id, ...ancestors]);
    }
  };
  visit(undefined, 0, []);
  return out;
}

/** Total number of items (maps + trails + waypoints + areas) in a folder group. */
export function folderItemCount<T extends TrackSummary>(group: FolderGroup<T>): number {
  return group.maps.length + group.tracks.length + group.waypoints.length + group.areas.length;
}
