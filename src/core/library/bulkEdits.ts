import { primaryGeoreferences } from '@core/geo/geopdf/primary';
import type { Area, Folder, MapDocument, TrackSummary, Waypoint } from '@core/models';

import { canShowMap, refKey, type FolderMove, type ItemRef } from './selection';

/**
 * The Library index edits behind the selection's action bar (#711), each one
 * a pure function of the index so the store commits it in ONE write: moving
 * many items between folders (and Undo), deleting many items with Undo
 * (files are removed only once the Undo window has passed), deleting a folder
 * with Undo, and showing or hiding many items on the map.
 */

/** The slice of the Library index these edits read and write. */
export interface LibraryIndexSlice {
  maps: readonly MapDocument[];
  tracks: readonly TrackSummary[];
  waypoints: readonly Waypoint[];
  areas: readonly Area[];
  folders: readonly Folder[];
  activeTrackIds: readonly string[];
  activeMapId: string | null;
  visibleFolderIds: readonly string[];
}

/** Edited item lists (fresh arrays the store commits as they are). */
interface Items {
  maps: MapDocument[];
  tracks: TrackSummary[];
  waypoints: Waypoint[];
  areas: Area[];
}

interface Shown {
  activeTrackIds: string[];
  activeMapId: string | null;
}

function withFolder<T extends { folderId?: string }>(item: T, folderId: string | null): T {
  if (folderId === null) {
    const { folderId: _dropped, ...rest } = item;
    return rest as T;
  }
  return { ...item, folderId };
}

/**
 * Apply folder moves (a Move, or its Undo). A move to a folder that no longer
 * exists is skipped rather than committed as a dangling id (#303).
 */
export function applyFolderMoves(state: LibraryIndexSlice, moves: readonly FolderMove[]): Items {
  const known = new Set(state.folders.map((f) => f.id));
  const target = new Map<string, string | null>();
  for (const m of moves) {
    if (m.to !== null && !known.has(m.to)) continue;
    target.set(refKey(m.ref), m.to);
  }
  const move = <T extends { id: string; folderId?: string }>(
    kind: ItemRef['kind'],
    items: readonly T[],
  ) =>
    items.map((item) => {
      const to = target.get(`${kind}:${item.id}`);
      return to === undefined ? item : withFolder(item, to);
    });
  return {
    maps: move('map', state.maps),
    tracks: move('track', state.tracks),
    waypoints: move('waypoint', state.waypoints),
    areas: move('area', state.areas),
  };
}

/** Where a removed item sat, so Undo puts it back in its place. */
export interface Removed<T> {
  item: T;
  index: number;
}

/** Everything a bulk delete took out of the index: what Undo restores. */
export interface RemovedItems {
  maps: Removed<MapDocument>[];
  tracks: Removed<TrackSummary>[];
  waypoints: Removed<Waypoint>[];
  areas: Removed<Area>[];
  /** Removed trails that were shown on the map. */
  activeTrackIds: string[];
  /** The active map, when it was removed. */
  activeMapId: string | null;
}

function split<T extends { id: string }>(
  items: readonly T[],
  doomed: ReadonlySet<string>,
): { kept: T[]; removed: Removed<T>[] } {
  const kept: T[] = [];
  const removed: Removed<T>[] = [];
  items.forEach((item, index) => {
    if (doomed.has(item.id)) removed.push({ item, index });
    else kept.push(item);
  });
  return { kept, removed };
}

/**
 * Take the refs' items out of the index (no file is touched: that waits for
 * the Undo window, see {@link removedFileUris}).
 */
export function removeItems(
  state: LibraryIndexSlice,
  refs: readonly ItemRef[],
): {
  next: Items & Shown;
  removed: RemovedItems;
} {
  const ids = (kind: ItemRef['kind']) =>
    new Set(refs.filter((r) => r.kind === kind).map((r) => r.id));
  const maps = split(state.maps, ids('map'));
  const tracks = split(state.tracks, ids('track'));
  const waypoints = split(state.waypoints, ids('waypoint'));
  const areas = split(state.areas, ids('area'));
  const goneTracks = new Set(tracks.removed.map((r) => r.item.id));
  const mapGone =
    state.activeMapId !== null && maps.removed.some((r) => r.item.id === state.activeMapId);
  return {
    next: {
      maps: maps.kept,
      tracks: tracks.kept,
      waypoints: waypoints.kept,
      areas: areas.kept,
      activeTrackIds: state.activeTrackIds.filter((id) => !goneTracks.has(id)),
      activeMapId: mapGone ? null : state.activeMapId,
    },
    removed: {
      maps: maps.removed,
      tracks: tracks.removed,
      waypoints: waypoints.removed,
      areas: areas.removed,
      activeTrackIds: state.activeTrackIds.filter((id) => goneTracks.has(id)),
      activeMapId: mapGone ? state.activeMapId : null,
    },
  };
}

function reinsert<T extends { id: string }>(items: readonly T[], removed: readonly Removed<T>[]) {
  const present = new Set(items.map((i) => i.id));
  const out = [...items];
  // Ascending original positions: each insert lands where it was, given the
  // earlier ones are back already.
  for (const { item, index } of [...removed].sort((a, b) => a.index - b.index)) {
    if (present.has(item.id)) continue;
    out.splice(Math.min(index, out.length), 0, item);
  }
  return out;
}

/** Undo a {@link removeItems}: every item back in its place, shown as it was. */
export function restoreItems(state: LibraryIndexSlice, removed: RemovedItems): Items & Shown {
  const shown = new Set(state.activeTrackIds);
  return {
    maps: reinsert(state.maps, removed.maps),
    tracks: reinsert(state.tracks, removed.tracks),
    waypoints: reinsert(state.waypoints, removed.waypoints),
    areas: reinsert(state.areas, removed.areas),
    activeTrackIds: [
      ...state.activeTrackIds,
      ...removed.activeTrackIds.filter((id) => !shown.has(id)),
    ],
    activeMapId: state.activeMapId ?? removed.activeMapId,
  };
}

/** The files a committed bulk delete leaves orphaned: PDFs, GPX files and photos. */
export function removedFileUris(removed: RemovedItems): string[] {
  return [
    ...removed.maps.map((r) => r.item.fileUri),
    ...removed.tracks.flatMap((r) => [
      r.item.fileUri,
      ...(r.item.notes ?? []).flatMap((n) => (n.photoUri ? [n.photoUri] : [])),
    ]),
    ...removed.waypoints.flatMap((r) => (r.item.photoUri ? [r.item.photoUri] : [])),
    ...removed.areas.flatMap((r) => r.item.photoUris ?? []),
  ];
}

/** Nothing at all was removed. */
export function isEmptyRemoval(removed: RemovedItems): boolean {
  return (
    removed.maps.length +
      removed.tracks.length +
      removed.waypoints.length +
      removed.areas.length ===
    0
  );
}

// --- Folder delete, with Undo -------------------------------------------------

/** What deleting a folder undoes: the folder in its place, and who was in it. */
export interface FolderSnapshot {
  folder: Folder;
  index: number;
  members: ItemRef[];
  /** It was checked in the map's folder visibility. */
  visible: boolean;
}

export function folderSnapshot(state: LibraryIndexSlice, folderId: string): FolderSnapshot | null {
  const index = state.folders.findIndex((f) => f.id === folderId);
  const folder = state.folders[index];
  if (folder === undefined) return null;
  const inIt = <T extends { id: string; folderId?: string }>(
    kind: ItemRef['kind'],
    items: readonly T[],
  ) => items.filter((i) => i.folderId === folderId).map((i) => ({ kind, id: i.id }));
  return {
    folder,
    index,
    members: [
      ...inIt('map', state.maps),
      ...inIt('track', state.tracks),
      ...inIt('waypoint', state.waypoints),
      ...inIt('area', state.areas),
    ],
    visible: state.visibleFolderIds.includes(folderId),
  };
}

/**
 * Undo a folder delete: the folder back in its place, and its members back in
 * it, except those the user has filed elsewhere since.
 */
export function restoreFolder(
  state: LibraryIndexSlice,
  snap: FolderSnapshot,
): Items & { folders: Folder[]; visibleFolderIds: string[] } {
  const exists = state.folders.some((f) => f.id === snap.folder.id);
  const folders = exists
    ? [...state.folders]
    : [...state.folders.slice(0, snap.index), snap.folder, ...state.folders.slice(snap.index)];
  const known = new Set(folders.map((f) => f.id));
  const members = new Set(snap.members.map(refKey));
  const back = <T extends { id: string; folderId?: string }>(
    kind: ItemRef['kind'],
    items: readonly T[],
  ) =>
    items.map((i) =>
      members.has(`${kind}:${i.id}`) && (i.folderId === undefined || !known.has(i.folderId))
        ? { ...i, folderId: snap.folder.id }
        : i,
    );
  return {
    folders,
    maps: back('map', state.maps),
    tracks: back('track', state.tracks),
    waypoints: back('waypoint', state.waypoints),
    areas: back('area', state.areas),
    visibleFolderIds:
      snap.visible && !state.visibleFolderIds.includes(snap.folder.id)
        ? [...state.visibleFolderIds, snap.folder.id]
        : [...state.visibleFolderIds],
  };
}

// --- Show / hide on the map ---------------------------------------------------

/**
 * The pages "Show on map" turns on for a map: every primary page that has not
 * failed to render. A map whose pages have all failed is left alone: its
 * Retry (on the row) is the deliberate way back.
 */
export function pagesToShow(map: MapDocument): number[] {
  const failed = new Set((map.renderRecoveryErrors ?? []).map((e) => e.pageIndex));
  return primaryGeoreferences(map.georeferences)
    .map((g) => g.pageIndex)
    .filter((p) => !failed.has(p));
}

/**
 * Show (or hide) the refs' maps and trails on the map. Waypoints and areas
 * are always on the map and are ignored. `changed` counts the items whose
 * visibility actually flipped (the snackbar's number).
 */
export function applyShown(
  state: LibraryIndexSlice,
  refs: readonly ItemRef[],
  shown: boolean,
): { maps: MapDocument[]; activeTrackIds: string[]; changed: number } {
  const mapIds = new Set(refs.filter((r) => r.kind === 'map').map((r) => r.id));
  const trackIds = refs.filter((r) => r.kind === 'track').map((r) => r.id);
  const existing = new Set(state.tracks.map((t) => t.id));
  let changed = 0;
  const maps = state.maps.map((m) => {
    if (!mapIds.has(m.id) || !canShowMap(m)) return m;
    const isOn = m.activePages.length > 0;
    if (isOn === shown) return m;
    if (!shown) {
      changed++;
      return { ...m, activePages: [] };
    }
    const pages = pagesToShow(m);
    if (pages.length === 0) return m;
    changed++;
    return { ...m, activePages: pages };
  });
  const active = new Set(state.activeTrackIds);
  let activeTrackIds = [...state.activeTrackIds];
  if (shown) {
    for (const id of trackIds) {
      if (existing.has(id) && !active.has(id)) {
        activeTrackIds.push(id);
        active.add(id);
        changed++;
      }
    }
  } else {
    const hide = new Set(trackIds.filter((id) => active.has(id)));
    changed += hide.size;
    activeTrackIds = activeTrackIds.filter((id) => !hide.has(id));
  }
  return { maps, activeTrackIds, changed };
}
