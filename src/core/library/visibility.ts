import type { MapDocument, TrackSummary, Waypoint } from '@core/models';
import type { MapVisibilityMode } from './migrations';

/**
 * Pure selectors for the map's visibility modes. 'type' mode is the classic
 * behavior (the PDF/Trails master switches decide; trails additionally follow
 * `activeTrackIds`). 'folders' mode shows exactly the checked folders' items —
 * maps, trails AND waypoints — with {@link UNGROUPED_FOLDER_ID} standing in
 * for items that belong to no folder.
 */

/** Pseudo folder id selecting items without a folder in 'folders' mode. */
export const UNGROUPED_FOLDER_ID = 'ungrouped';

function inSelection(folderId: string | undefined, selected: ReadonlySet<string>): boolean {
  return folderId === undefined ? selected.has(UNGROUPED_FOLDER_ID) : selected.has(folderId);
}

/** The maps whose overlays may draw (their `activePages` still apply). */
export function visibleMaps(
  mode: MapVisibilityMode,
  visibleFolderIds: readonly string[],
  maps: readonly MapDocument[],
): MapDocument[] {
  if (mode === 'type') return [...maps];
  const selected = new Set(visibleFolderIds);
  return maps.filter((m) => inSelection(m.folderId, selected));
}

/**
 * The trail ids drawn as overlays. 'type' mode defers to the user's explicit
 * per-trail activation; 'folders' mode shows every trail of a checked folder.
 */
export function visibleTrackIds(
  mode: MapVisibilityMode,
  visibleFolderIds: readonly string[],
  tracks: readonly TrackSummary[],
  activeTrackIds: readonly string[],
): string[] {
  if (mode === 'type') return [...activeTrackIds];
  const selected = new Set(visibleFolderIds);
  return tracks.filter((t) => inSelection(t.folderId, selected)).map((t) => t.id);
}

/** The saved waypoints pinned on the map ('type' mode shows them all). */
export function visibleWaypoints(
  mode: MapVisibilityMode,
  visibleFolderIds: readonly string[],
  waypoints: readonly Waypoint[],
): Waypoint[] {
  if (mode === 'type') return [...waypoints];
  const selected = new Set(visibleFolderIds);
  return waypoints.filter((w) => inSelection(w.folderId, selected));
}
