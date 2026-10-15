import type { Area, Folder, MapDocument, TrackSummary, Waypoint } from '@core/models';

import type { LibraryListItem } from './libraryListItems';
import { georeferenceNotice } from './overlayPages';

/**
 * The Library's select mode (#711): hold a row to select it, then taps
 * toggle. It generalizes the trail-only merge selection to maps, trails,
 * waypoints and areas, and drives the action bar (Move to…, Show on map,
 * Share, Merge, Delete) that replaces the tab bar while anything is selected.
 *
 * A selection is an ordered list of {@link ItemRef}s: the order is the order
 * the user picked them in, which is the merge order for untimed trails.
 *
 * Pure: the screen keeps the selection in state and asks these helpers what
 * it means.
 */

export type LibraryItemKind = 'map' | 'track' | 'waypoint' | 'area';

/** One selected Library item. */
export interface ItemRef {
  readonly kind: LibraryItemKind;
  readonly id: string;
}

/** A stable key for a ref (`track:abc`), unique across kinds. */
export const refKey = (ref: ItemRef): string => `${ref.kind}:${ref.id}`;

/** Add the ref when absent, remove it when present (selection order kept). */
export function toggleRef(selection: readonly ItemRef[], ref: ItemRef): ItemRef[] {
  const key = refKey(ref);
  return selection.some((r) => refKey(r) === key)
    ? selection.filter((r) => refKey(r) !== key)
    : [...selection, ref];
}

/** The selection's keys, for O(1) "is this row selected?" lookups. */
export function selectionKeys(selection: readonly ItemRef[]): ReadonlySet<string> {
  return new Set(selection.map(refKey));
}

/**
 * The rows Select all covers: every item row the list shows right now, so the
 * current chip, search and filter apply, and a collapsed folder contributes
 * nothing (its rows are not in the list). Display order.
 */
export function scopeRefs(items: readonly LibraryListItem[]): ItemRef[] {
  const out: ItemRef[] = [];
  for (const item of items) {
    if (item.kind === 'map') out.push({ kind: 'map', id: item.map.id });
    else if (item.kind === 'track') out.push({ kind: 'track', id: item.track.id });
    else if (item.kind === 'waypoint') out.push({ kind: 'waypoint', id: item.waypoint.id });
    else if (item.kind === 'area') out.push({ kind: 'area', id: item.area.id });
  }
  return out;
}

/** True when the scope has rows and every one of them is selected. */
export function allInScopeSelected(
  selection: readonly ItemRef[],
  scope: readonly ItemRef[],
): boolean {
  if (scope.length === 0) return false;
  const keys = selectionKeys(selection);
  return scope.every((r) => keys.has(refKey(r)));
}

/**
 * Select all: the scope joins the selection (what was already selected keeps
 * its place, then the new rows in display order). When the whole scope is
 * already selected it is the opposite, Deselect all, which drops the scope
 * (and leaves select mode when nothing else was selected).
 */
export function selectAllInScope(
  selection: readonly ItemRef[],
  scope: readonly ItemRef[],
): ItemRef[] {
  const keys = selectionKeys(selection);
  if (allInScopeSelected(selection, scope)) {
    const scoped = selectionKeys(scope);
    return selection.filter((r) => !scoped.has(refKey(r)));
  }
  return [...selection, ...scope.filter((r) => !keys.has(refKey(r)))];
}

export type KindCounts = Record<LibraryItemKind, number>;

const KIND_ORDER: readonly LibraryItemKind[] = ['map', 'track', 'waypoint', 'area'];

const NOUNS: Record<LibraryItemKind, readonly [string, string]> = {
  map: ['map', 'maps'],
  track: ['trail', 'trails'],
  waypoint: ['waypoint', 'waypoints'],
  area: ['area', 'areas'],
};

/** "1 trail", "3 maps". */
export function kindCount(kind: LibraryItemKind, n: number): string {
  return `${n} ${NOUNS[kind][n === 1 ? 0 : 1]}`;
}

/** "1 item", "5 items". */
export function itemCount(n: number): string {
  return `${n} ${n === 1 ? 'item' : 'items'}`;
}

export function kindCounts(refs: readonly ItemRef[]): KindCounts {
  const counts: KindCounts = { map: 0, track: 0, waypoint: 0, area: 0 };
  for (const r of refs) counts[r.kind]++;
  return counts;
}

/** "2 maps · 2 trails · 1 waypoint": the header's second line. Empty for none. */
export function kindSummary(refs: readonly ItemRef[]): string {
  const counts = kindCounts(refs);
  return KIND_ORDER.filter((k) => counts[k] > 0)
    .map((k) => kindCount(k, counts[k]))
    .join(' · ');
}

/**
 * What a snackbar calls the selection: "3 trails" when it is one kind,
 * "5 items" when kinds mix ("Moved 5 items to Gaspésie 2026").
 */
export function itemsPhrase(refs: readonly ItemRef[]): string {
  const counts = kindCounts(refs);
  const kinds = KIND_ORDER.filter((k) => counts[k] > 0);
  const [only] = kinds;
  return kinds.length === 1 && only !== undefined
    ? kindCount(only, counts[only])
    : itemCount(refs.length);
}

/** The Library's items, as the selection helpers need them. */
export interface LibraryItems {
  maps: readonly MapDocument[];
  tracks: readonly TrackSummary[];
  waypoints: readonly Waypoint[];
  areas: readonly Area[];
}

/** The selected items that still exist, by kind (each in selection order). */
export interface ResolvedSelection {
  refs: ItemRef[];
  maps: MapDocument[];
  tracks: TrackSummary[];
  waypoints: Waypoint[];
  areas: Area[];
}

/**
 * Look the refs up. A ref whose item is gone (deleted elsewhere, an import
 * replaced it) drops out, so a stale selection can never act on nothing.
 */
export function resolveSelection(
  selection: readonly ItemRef[],
  lib: LibraryItems,
): ResolvedSelection {
  const maps = new Map(lib.maps.map((m) => [m.id, m]));
  const tracks = new Map(lib.tracks.map((t) => [t.id, t]));
  const waypoints = new Map(lib.waypoints.map((w) => [w.id, w]));
  const areas = new Map(lib.areas.map((a) => [a.id, a]));
  const out: ResolvedSelection = { refs: [], maps: [], tracks: [], waypoints: [], areas: [] };
  for (const ref of selection) {
    if (ref.kind === 'map') {
      const m = maps.get(ref.id);
      if (m) out.maps.push(m);
      else continue;
    } else if (ref.kind === 'track') {
      const t = tracks.get(ref.id);
      if (t) out.tracks.push(t);
      else continue;
    } else if (ref.kind === 'waypoint') {
      const w = waypoints.get(ref.id);
      if (w) out.waypoints.push(w);
      else continue;
    } else {
      const a = areas.get(ref.id);
      if (a) out.areas.push(a);
      else continue;
    }
    out.refs.push(ref);
  }
  return out;
}

/** Every item of a resolved selection, with its folder. */
function members(
  sel: Pick<ResolvedSelection, 'maps' | 'tracks' | 'waypoints' | 'areas'>,
): { ref: ItemRef; folderId: string | undefined }[] {
  return [
    ...sel.maps.map((m) => ({ ref: { kind: 'map' as const, id: m.id }, folderId: m.folderId })),
    ...sel.tracks.map((t) => ({
      ref: { kind: 'track' as const, id: t.id },
      folderId: t.folderId,
    })),
    ...sel.waypoints.map((w) => ({
      ref: { kind: 'waypoint' as const, id: w.id },
      folderId: w.folderId,
    })),
    ...sel.areas.map((a) => ({ ref: { kind: 'area' as const, id: a.id }, folderId: a.folderId })),
  ];
}

// --- Show on map -------------------------------------------------------------

/**
 * A map the Library can show or hide: it has georeferenced pages and nothing
 * stops it being drawn (the row's "On map" chip appears for exactly these).
 */
export function canShowMap(map: MapDocument): boolean {
  return map.georeferences.length > 0 && georeferenceNotice(map) === null;
}

/**
 * What "Show on map" acts on: maps that can be drawn and trails. Waypoints
 * and areas are always on the map, so they are neither shown nor hidden.
 * `allShown`: every one of those is on the map already, so the action reads
 * Hide from map.
 */
export function showTargets(
  sel: Pick<ResolvedSelection, 'maps' | 'tracks'>,
  activeTrackIds: readonly string[],
): { refs: ItemRef[]; allShown: boolean } {
  const active = new Set(activeTrackIds);
  const maps = sel.maps.filter(canShowMap);
  const refs: ItemRef[] = [
    ...maps.map((m) => ({ kind: 'map' as const, id: m.id })),
    ...sel.tracks.map((t) => ({ kind: 'track' as const, id: t.id })),
  ];
  const allShown =
    refs.length > 0 &&
    maps.every((m) => m.activePages.length > 0) &&
    sel.tracks.every((t) => active.has(t.id));
  return { refs, allShown };
}

// --- Action availability -----------------------------------------------------

export type SelectionAction = 'move' | 'show' | 'share' | 'merge' | 'delete';
export type FolderAction = 'share' | 'show' | 'rename' | 'delete';

/**
 * One action-bar slot: its label (Show on map flips to Hide from map), and,
 * when it does not apply, the reason a tap shows (also its accessibility
 * hint). A dimmed slot stays in place: the bar never reorders.
 */
export interface ActionState {
  label: string;
  enabled: boolean;
  reason: string | null;
}

const on = (label: string): ActionState => ({ label, enabled: true, reason: null });
const off = (label: string, reason: string): ActionState => ({ label, enabled: false, reason });

/** "2 maps and 1 waypoint" (the non-trail part of a selection), or null. */
function othersPhrase(counts: KindCounts): string | null {
  const parts = (['map', 'waypoint', 'area'] as const)
    .filter((k) => counts[k] > 0)
    .map((k) => kindCount(k, counts[k]));
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0] ?? null;
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function showState(
  sel: Pick<ResolvedSelection, 'maps' | 'tracks' | 'waypoints' | 'areas'>,
  activeTrackIds: readonly string[],
  scope: 'selection' | 'folder',
): ActionState {
  const { refs, allShown } = showTargets(sel, activeTrackIds);
  if (refs.length > 0) return on(allShown ? 'Hide from map' : 'Show on map');
  const label = 'Show on map';
  if (sel.maps.length > 0) {
    return off(
      label,
      scope === 'folder'
        ? 'Nothing in this folder can be shown or hidden: its maps cannot be placed on the map.'
        : sel.maps.length === 1 && sel.waypoints.length + sel.areas.length === 0
          ? 'This map cannot be placed on the map.'
          : 'Nothing selected can be shown or hidden: these maps cannot be placed, and waypoints and areas are always on the map.',
    );
  }
  if (sel.waypoints.length + sel.areas.length > 0) {
    return off(label, 'Waypoints and areas are always on the map.');
  }
  return off(label, scope === 'folder' ? 'This folder is empty.' : 'Nothing is selected.');
}

/** The five slots of the selection's action bar. */
export function selectionActions(
  sel: ResolvedSelection,
  activeTrackIds: readonly string[],
): Record<SelectionAction, ActionState> {
  const counts = kindCounts(sel.refs);
  const others = othersPhrase(counts);
  let merge: ActionState;
  if (others !== null) {
    merge = off(
      'Merge',
      `Merge joins trails only. This selection also has ${others}. Select only trails to merge them.`,
    );
  } else if (counts.track < 2) {
    merge = off('Merge', 'Select 2 or more trails to merge them.');
  } else {
    merge = on('Merge');
  }
  return {
    move: on('Move to…'),
    show: showState(sel, activeTrackIds, 'selection'),
    share: sel.refs.length > 0 ? on('Share') : off('Share', 'Nothing is selected.'),
    merge,
    delete: sel.refs.length > 0 ? on('Delete') : off('Delete', 'Nothing is selected.'),
  };
}

/** The four slots of a selected folder's bar (Share folder, Show on map, Rename, Delete). */
export function folderActions(
  contents: Pick<ResolvedSelection, 'maps' | 'tracks' | 'waypoints' | 'areas'>,
  activeTrackIds: readonly string[],
): Record<FolderAction, ActionState> {
  const n =
    contents.maps.length +
    contents.tracks.length +
    contents.waypoints.length +
    contents.areas.length;
  return {
    share: n > 0 ? on('Share folder') : off('Share folder', 'This folder is empty.'),
    show: showState(contents, activeTrackIds, 'folder'),
    rename: on('Rename'),
    delete: on('Delete'),
  };
}

// --- Move to folder ----------------------------------------------------------

/** One row of the Move picker. */
export interface MoveOption {
  folder: Folder;
  /** Everything in the folder, whatever the chips show ("4 items"). */
  count: number;
  /** Every selected item is in this folder already: "· current", and a no-op. */
  current: boolean;
}

/** Items per folder id (maps, trails, waypoints and areas). */
export function folderCounts(lib: LibraryItems): Map<string, number> {
  const counts = new Map<string, number>();
  const add = (folderId: string | undefined) => {
    if (folderId !== undefined) counts.set(folderId, (counts.get(folderId) ?? 0) + 1);
  };
  for (const m of lib.maps) add(m.folderId);
  for (const t of lib.tracks) add(t.folderId);
  for (const w of lib.waypoints) add(w.folderId);
  for (const a of lib.areas) add(a.folderId);
  return counts;
}

/**
 * The Move picker's rows, in the folders' own order, and whether "Remove
 * from folder" applies (some selected item is in a folder that exists). It is
 * left out otherwise, never shown greyed.
 */
export function moveOptions(
  folders: readonly Folder[],
  sel: Pick<ResolvedSelection, 'maps' | 'tracks' | 'waypoints' | 'areas'>,
  counts: ReadonlyMap<string, number>,
): { options: MoveOption[]; canRemove: boolean } {
  const all = members(sel);
  const known = new Set(folders.map((f) => f.id));
  return {
    options: folders.map((folder) => ({
      folder,
      count: counts.get(folder.id) ?? 0,
      current: all.length > 0 && all.every((m) => m.folderId === folder.id),
    })),
    canRemove: all.some((m) => m.folderId !== undefined && known.has(m.folderId)),
  };
}

/** One item's move, with where it was (what Undo puts back). */
export interface FolderMove {
  ref: ItemRef;
  from: string | null;
  to: string | null;
}

/**
 * The moves that send the selection to `target` (a folder id, or null for
 * Ungrouped): only the items that actually change folder. A folder id that no
 * longer exists counts as Ungrouped, as the list shows it.
 */
export function plannedMoves(
  sel: Pick<ResolvedSelection, 'maps' | 'tracks' | 'waypoints' | 'areas'>,
  target: string | null,
  folders: readonly Folder[],
): FolderMove[] {
  const known = new Set(folders.map((f) => f.id));
  return members(sel)
    .map(({ ref, folderId }) => ({
      ref,
      from: folderId !== undefined && known.has(folderId) ? folderId : null,
      to: target,
    }))
    .filter((m) => m.from !== m.to);
}

/** Undo for {@link plannedMoves}: each item back in its own previous folder. */
export function undoMoves(moves: readonly FolderMove[]): FolderMove[] {
  return moves.map((m) => ({ ref: m.ref, from: m.to, to: m.from }));
}
