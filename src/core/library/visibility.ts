import type { MapDocument, TrackSummary, Waypoint } from '@core/models';
import { toggleId } from './toggleId';
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

/** The map's folder-visibility state: the mode plus the checked folder ids. */
export interface FolderVisibility {
  mode: MapVisibilityMode;
  visibleFolderIds: readonly string[];
}

/**
 * The visibility state after one tap on a folder row in the map's content
 * picker. Both fields move together — the picker must never leave the map in
 * 'folders' mode with an empty selection (which shows nothing at all).
 *
 * Coming from 'type' mode the selection *restarts* at the tapped folder: in
 * type mode every folder row reads unchecked (the "Everything" row is what's
 * on), so the tap turns exactly that folder on. Toggling a stale leftover
 * selection instead is what produced the "blank map after picking a folder"
 * bug — check TripA, tap Everything (mode flips to 'type', TripA stays in the
 * persisted set), then tap TripA again and the toggle *removed* it.
 *
 * Already in 'folders' mode it is a plain toggle, so a second tap on the same
 * row hides that folder again.
 */
export function nextFolderVisibility(current: FolderVisibility, id: string): FolderVisibility {
  if (current.mode !== 'folders') return { mode: 'folders', visibleFolderIds: [id] };
  return { mode: 'folders', visibleFolderIds: toggleId(current.visibleFolderIds, id) };
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
