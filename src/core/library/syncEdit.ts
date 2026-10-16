import type { Area, Folder, MapDocument, TrackSummary, Waypoint } from '@core/models';

import type { LibraryIndex } from './migrations';

/**
 * What Share live (#712) changes in the Library in one go: the library
 * bridge's plan for one shared folder, as whole items (the bridge builds
 * each from the current item plus the record's fields, so local-only fields
 * such as photos survive). Applied in ONE index write, with origin "sync":
 * the bridge's base moves with it, so nothing echoes back.
 *
 * `put` inserts an item, or replaces the one with its id; `remove` deletes.
 * Maps are never created here (a catalog map arrives through its download).
 */
export interface SyncEdit {
  folders?: { put?: readonly Folder[]; remove?: readonly string[] };
  waypoints?: { put?: readonly Waypoint[]; remove?: readonly string[] };
  areas?: { put?: readonly Area[]; remove?: readonly string[] };
  tracks?: { put?: readonly TrackSummary[]; remove?: readonly string[] };
  maps?: { put?: readonly MapDocument[]; remove?: readonly string[] };
}

type Lists = Pick<LibraryIndex, 'folders' | 'waypoints' | 'areas' | 'tracks' | 'maps'> &
  Partial<Pick<LibraryIndex, 'activeTrackIds' | 'visibleFolderIds' | 'activeMapId'>>;

export interface SyncEditResult<T extends Lists> {
  index: T;
  /** Files no item names any more (removed items' files and photos, replaced GPX files). */
  orphanedUris: string[];
  /** Trails removed (their photo folders go too). */
  deletedTrackIds: string[];
  /** Whether anything changed. */
  changed: boolean;
}

function apply<I extends { id: string }>(
  list: readonly I[],
  put: readonly I[] | undefined,
  remove: readonly string[] | undefined,
  gone: (old: I, replacement: I | undefined) => void,
): I[] {
  if ((put === undefined || put.length === 0) && (remove === undefined || remove.length === 0))
    return list as I[];
  const doomed = new Set(remove ?? []);
  const byId = new Map((put ?? []).map((i) => [i.id, i]));
  const out: I[] = [];
  for (const item of list) {
    if (doomed.has(item.id)) {
      gone(item, undefined);
      continue;
    }
    const next = byId.get(item.id);
    if (next !== undefined) {
      gone(item, next);
      out.push(next);
      byId.delete(item.id);
    } else out.push(item);
  }
  for (const item of byId.values()) if (!doomed.has(item.id)) out.push(item);
  return out;
}

const dropped = (before: readonly (string | undefined)[], after: readonly (string | undefined)[]) =>
  before.filter((u): u is string => u !== undefined && !after.includes(u));

export function applySyncEdit<T extends Lists>(index: T, edit: SyncEdit): SyncEditResult<T> {
  const orphanedUris: string[] = [];
  const deletedTrackIds: string[] = [];
  const folders = apply(index.folders, edit.folders?.put, edit.folders?.remove, () => undefined);
  const waypoints = apply(index.waypoints, edit.waypoints?.put, edit.waypoints?.remove, (o, n) =>
    orphanedUris.push(...dropped([o.photoUri], [n?.photoUri])),
  );
  const areas = apply(index.areas, edit.areas?.put, edit.areas?.remove, (o, n) =>
    orphanedUris.push(...dropped(o.photoUris ?? [], n?.photoUris ?? [])),
  );
  const tracks = apply(index.tracks, edit.tracks?.put, edit.tracks?.remove, (o, n) => {
    const photos = (t: TrackSummary | undefined) => (t?.notes ?? []).map((x) => x.photoUri);
    orphanedUris.push(...dropped([o.fileUri, ...photos(o)], [n?.fileUri, ...photos(n)]));
    if (n === undefined) deletedTrackIds.push(o.id);
  });
  const maps = apply(index.maps, edit.maps?.put, edit.maps?.remove, (o, n) =>
    orphanedUris.push(...dropped([o.fileUri], [n?.fileUri])),
  );
  const changed =
    folders !== index.folders ||
    waypoints !== index.waypoints ||
    areas !== index.areas ||
    tracks !== index.tracks ||
    maps !== index.maps;
  if (!changed) return { index, orphanedUris: [], deletedTrackIds: [], changed: false };
  const next: T = { ...index, folders, waypoints, areas, tracks, maps };
  // Nothing removed may linger as an overlay or a visible folder.
  const removedFolders = new Set(edit.folders?.remove ?? []);
  if (index.visibleFolderIds !== undefined && removedFolders.size > 0)
    next.visibleFolderIds = index.visibleFolderIds.filter((f) => !removedFolders.has(f));
  if (index.activeTrackIds !== undefined && deletedTrackIds.length > 0)
    next.activeTrackIds = index.activeTrackIds.filter((t) => !deletedTrackIds.includes(t));
  if (index.activeMapId != null && (edit.maps?.remove ?? []).includes(index.activeMapId))
    next.activeMapId = null;
  // Items of a removed folder fall back to Ungrouped (as a folder delete does).
  if (removedFolders.size > 0) {
    const clear = <I extends { folderId?: string }>(i: I): I =>
      i.folderId !== undefined && removedFolders.has(i.folderId)
        ? { ...i, folderId: undefined }
        : i;
    next.waypoints = next.waypoints.map(clear);
    next.areas = next.areas.map(clear);
    next.tracks = next.tracks.map(clear);
    next.maps = next.maps.map(clear);
  }
  return { index: next, orphanedUris, deletedTrackIds, changed: true };
}
