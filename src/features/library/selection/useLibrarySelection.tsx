import type { CreditLanguage } from '@core/catalog/credit';
import type { Units } from '@core/format';
import { compactDistance } from '@core/library/libraryRows';
import type { LibraryListItem } from '@core/library/libraryListItems';
import {
  allInScopeSelected,
  folderActions,
  folderCounts,
  itemCount,
  itemsPhrase,
  kindSummary,
  moveOptions,
  plannedMoves,
  refKey,
  resolveSelection,
  scopeRefs,
  selectAllInScope,
  selectionActions,
  selectionKeys,
  showTargets,
  toggleRef,
  undoMoves,
  type FolderMove,
  type ItemRef,
  type ResolvedSelection,
} from '@core/library/selection';
import { isCatalogMap, sharePlan, type SharePlan } from '@core/library/sharePlan';
import type { TrackSummary } from '@core/models';
import { reportError } from '@lib/errorReporting';
import { useLibraryStore } from '@state/libraryStore';
import { useUndoSnackbar } from '@features/common/useUndoSnackbar';
import { useTimedSnackbar } from '@features/common/useTimedSnackbar';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { space } from '@ui/tokens';

import { useScreenSheet } from '@features/common/useScreenSheet';
import { copyMergedTrailPhotos, mergeLibraryTracks } from '../mergeTracks';
import { planBytes, sendCopy } from '../share/sendCopy';
import { MoveToFolderSheet } from './MoveToFolderSheet';
import {
  BAR_HEIGHT,
  ReasonTip,
  SelectionActionBar,
  SelectionHeader,
  UndoBar,
  type BarSlot,
} from './SelectionChrome';
import { ShareSheet } from './ShareSheet';

/** How long moved rows keep their sage wash. */
const FLASH_MS = 1500;
/** How long the "why is this dimmed" bubble stays. */
const REASON_MS = 4000;
/** How long Undo is offered. Files are deleted only after it. */
export const UNDO_MS = 6000;

const NO_KEYS: ReadonlySet<string> = new Set();

interface ShareTarget {
  title: string;
  subtitle: string;
  plan: SharePlan;
  sizeNote?: string;
}

export interface LibrarySelectionArgs {
  /** The list as shown: Select all's scope. */
  items: readonly LibraryListItem[];
  /** The Library is the screen in front. */
  focused: boolean;
  units: Units;
  creditLang: CreditLanguage;
  /** The screen's plain snackbar. */
  showSnack: (message: string) => void;
  /** Ask for a new folder's name (the screen's NameDialog). */
  requestNewFolder: () => void;
  /** Rename a folder (the screen's NameDialog). */
  requestRenameFolder: (folder: { id: string; name: string }) => void;
  /** Items just moved into a folder (null: out of folders): show where they landed. */
  onMoved: (folderId: string | null) => void;
}

/**
 * Select mode in the Library (#711): the selection (items, or one folder),
 * what each action-bar slot does, the Move and Share sheets, Undo, and the
 * moved-rows flash. The screen renders `header` in place of its title row and
 * `overlay` over its content, and routes row taps and long-presses here.
 *
 * Per-row cost: the screen reads `keys` (a Set) per mounted row; a toggle
 * changes one row's `selected`, so only that row re-renders (trail rows are
 * memoized; see TrackListRow).
 */
export function useLibrarySelection(args: LibrarySelectionArgs) {
  const maps = useLibraryStore((s) => s.maps);
  const tracks = useLibraryStore((s) => s.tracks);
  const waypoints = useLibraryStore((s) => s.waypoints);
  const areas = useLibraryStore((s) => s.areas);
  const folders = useLibraryStore((s) => s.folders);
  const activeTrackIds = useLibraryStore((s) => s.activeTrackIds);
  const insets = useSafeAreaInsets();

  const [selection, setSelection] = useState<ItemRef[]>([]);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [shareTarget, setShareTarget] = useState<ShareTarget | null>(null);
  const [sharing, setSharing] = useState(false);
  const [merging, setMerging] = useState(false);
  const [flashKeys, setFlashKeys] = useState<ReadonlySet<string>>(NO_KEYS);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(flashTimer.current), []);

  const undo = useUndoSnackbar(UNDO_MS);
  const reason = useTimedSnackbar(REASON_MS);

  const lib = useMemo(() => ({ maps, tracks, waypoints, areas }), [maps, tracks, waypoints, areas]);
  // Items deleted elsewhere drop out: a stale selection never acts on nothing,
  // and an emptied one leaves select mode by itself.
  const resolved = useMemo(() => resolveSelection(selection, lib), [selection, lib]);
  const keys = useMemo(
    () => (resolved.refs.length > 0 ? selectionKeys(resolved.refs) : NO_KEYS),
    [resolved],
  );
  const folder = folderId === null ? null : (folders.find((f) => f.id === folderId) ?? null);
  const folderContents = useMemo<ResolvedSelection | null>(() => {
    if (folder === null) return null;
    const inIt = <T extends { folderId?: string }>(xs: readonly T[]) =>
      xs.filter((x) => x.folderId === folder.id);
    const contents = {
      maps: inIt(maps),
      tracks: inIt(tracks),
      waypoints: inIt(waypoints),
      areas: inIt(areas),
    };
    return {
      ...contents,
      refs: [
        ...contents.maps.map((m) => ({ kind: 'map' as const, id: m.id })),
        ...contents.tracks.map((t) => ({ kind: 'track' as const, id: t.id })),
        ...contents.waypoints.map((w) => ({ kind: 'waypoint' as const, id: w.id })),
        ...contents.areas.map((a) => ({ kind: 'area' as const, id: a.id })),
      ],
    };
  }, [folder, maps, tracks, waypoints, areas]);

  const selecting = resolved.refs.length > 0;
  const active = selecting || folder !== null;

  const exit = useCallback(() => {
    setSelection([]);
    setFolderId(null);
    setMoveOpen(false);
    setShareTarget(null);
    reason.dismiss();
  }, [reason]);

  // Back (Android) leaves select mode, and the tab bar gives way to the action bar.
  useScreenSheet(active && args.focused, exit);

  const toggle = useCallback((ref: ItemRef) => {
    setFolderId(null);
    setSelection((sel) => toggleRef(sel, ref));
  }, []);

  /** A row's long-press: select it (or, already selecting, toggle it). */
  const longPress = toggle;

  /**
   * A row's tap. True when select mode took it (toggled the row, or put a
   * selected folder down); false when the row should open as usual.
   */
  const press = useCallback(
    (ref: ItemRef): boolean => {
      if (selecting) {
        toggle(ref);
        return true;
      }
      if (folder !== null) {
        setFolderId(null);
        return true;
      }
      return false;
    },
    [selecting, folder, toggle],
  );

  const longPressFolder = useCallback((id: string) => {
    setSelection([]);
    setFolderId(id);
  }, []);

  // A trail's ⋮ › Merge: select mode with this trail picked.
  const pickForMerge = useCallback((id: string) => {
    setFolderId(null);
    setSelection((sel) =>
      sel.some((r) => r.kind === 'track' && r.id === id) ? sel : [...sel, { kind: 'track', id }],
    );
  }, []);

  const scope = useMemo(() => scopeRefs(args.items), [args.items]);
  const everything = allInScopeSelected(resolved.refs, scope);
  const selectAll = useCallback(() => setSelection((sel) => selectAllInScope(sel, scope)), [scope]);

  const flash = useCallback((refs: readonly ItemRef[]) => {
    clearTimeout(flashTimer.current);
    setFlashKeys(new Set(refs.map(refKey)));
    flashTimer.current = setTimeout(() => setFlashKeys(NO_KEYS), FLASH_MS);
  }, []);

  // --- Move -------------------------------------------------------------------

  const { showSnack, onMoved, requestNewFolder, requestRenameFolder } = args;
  const runMoves = useCallback(
    (moves: FolderMove[], target: string | null) => {
      setMoveOpen(false);
      setSelection([]);
      if (moves.length === 0) return;
      // What actually moved (items already there are not counted).
      const phrase = itemsPhrase(moves.map((m) => m.ref));
      useLibraryStore.getState().moveItems(moves);
      onMoved(target);
      flash(moves.map((m) => m.ref));
      const name =
        target === null
          ? null
          : useLibraryStore.getState().folders.find((f) => f.id === target)?.name;
      undo.show({
        message: name ? `Moved ${phrase} to ${name}` : `Removed ${phrase} from their folder`,
        undo: () => useLibraryStore.getState().moveItems(undoMoves(moves)),
      });
    },
    [flash, onMoved, undo],
  );

  const moveSelectionTo = useCallback(
    (target: string | null) => {
      const current = useLibraryStore.getState().folders;
      runMoves(plannedMoves(resolved, target, current), target);
    },
    [resolved, runMoves],
  );

  /** "New folder…": the screen's NameDialog asks, then this files the selection. */
  const moveIntoNewFolder = useCallback(
    (name: string) => {
      const id = useLibraryStore.getState().addFolder(name || 'New folder');
      moveSelectionTo(id);
    },
    [moveSelectionTo],
  );

  /**
   * A drag (Organize mode) dropped `item` on a folder header. Dragging a
   * selected row carries the whole selection; returns false when the drag
   * was a single, unselected item (the screen's own drop handles it).
   */
  const dropSelection = useCallback(
    (item: ItemRef, target: string | null): boolean => {
      if (!keys.has(refKey(item)) || resolved.refs.length < 2) return false;
      moveSelectionTo(target);
      return true;
    },
    [keys, resolved, moveSelectionTo],
  );

  // --- Share ------------------------------------------------------------------

  const openShare = useCallback(
    (
      sel: Pick<ResolvedSelection, 'maps' | 'tracks' | 'waypoints' | 'areas' | 'refs'>,
      folderName: string | null,
    ) => {
      const plan = sharePlan({ ...sel, folderName, lang: args.creditLang });
      if (plan === null) return;
      const n = sel.refs.length;
      let title = `Share ${itemCount(n)}`;
      let subtitle = kindSummary(sel.refs);
      let sizeNote: string | undefined;
      const [map] = sel.maps;
      const [trail] = sel.tracks;
      if (folderName !== null) {
        title = `Share “${folderName}”`;
        subtitle = `Folder · ${itemCount(n)}`;
      } else if (n === 1 && trail) {
        title = 'Share trail';
        subtitle = `${trail.name} · ${compactDistance(trail.stats.distanceM, args.units)}`;
      } else if (n === 1 && map) {
        title = 'Share map';
        if (isCatalogMap(map)) {
          subtitle = map.sourceFreeAt ? `${map.name} · ${map.sourceFreeAt}` : map.name;
        } else {
          subtitle = map.pageCount > 1 ? `${map.name} · ${map.pageCount} pages` : map.name;
          if (map.georeferences.length > 0) sizeNote = 'georeferenced';
        }
      } else if (n === 1) {
        const [w] = sel.waypoints;
        const [a] = sel.areas;
        title = w ? 'Share waypoint' : 'Share area';
        subtitle = w?.label ?? a?.name ?? '';
      }
      setShareTarget({ title, subtitle, plan, sizeNote });
    },
    [args.creditLang, args.units],
  );

  /** A trail's ⋮ › Share (the same sheet, for one trail). */
  const shareTrail = useCallback(
    (t: TrackSummary) =>
      openShare(
        { maps: [], tracks: [t], waypoints: [], areas: [], refs: [{ kind: 'track', id: t.id }] },
        null,
      ),
    [openShare],
  );

  const shareBytes = useMemo(
    () => (shareTarget === null ? 0 : planBytes(shareTarget.plan)),
    [shareTarget],
  );

  const send = useCallback(async () => {
    if (shareTarget === null) return;
    setSharing(true);
    const result = await sendCopy(shareTarget.plan, shareTarget.title);
    setSharing(false);
    setShareTarget(null);
    if (result.kind === 'unavailable') showSnack('Sharing is not available on this device');
    else if (result.kind === 'error') {
      reportError(new Error(result.message), 'library-send-copy');
      showSnack(`Could not prepare the copy: ${result.message}`);
    }
  }, [shareTarget, showSnack]);

  // --- Show on map, Delete, Merge ------------------------------------------------

  const toggleShown = useCallback(
    (sel: Pick<ResolvedSelection, 'maps' | 'tracks'>) => {
      const { refs, allShown } = showTargets(sel, useLibraryStore.getState().activeTrackIds);
      const changed = useLibraryStore.getState().setItemsShown(refs, !allShown);
      if (changed === 0) showSnack('Nothing changed on the map');
      else
        showSnack(
          allShown
            ? `Hid ${itemCount(changed)} from the map`
            : `Showing ${itemCount(changed)} on the map`,
        );
    },
    [showSnack],
  );

  const deleteSelection = useCallback(() => {
    const phrase = itemsPhrase(resolved.refs);
    const store = useLibraryStore.getState();
    const removed = store.removeItemsForUndo(resolved.refs);
    setSelection([]);
    undo.show({
      message: `Deleted ${phrase}`,
      undo: () => useLibraryStore.getState().restoreRemovedItems(removed),
      commit: () => useLibraryStore.getState().purgeRemovedItems(removed),
    });
  }, [resolved, undo]);

  const merge = useCallback(async () => {
    const chosen = resolved.tracks;
    if (chosen.length < 2 || merging) return;
    setMerging(true);
    try {
      const { track, fileUri, notes } = await mergeLibraryTracks(chosen);
      useLibraryStore.getState().addTrack(track, fileUri, notes);
      setSelection([]);
      // The sources' trail photos (#587) are copied onto the merged trail.
      const photos = await copyMergedTrailPhotos(
        chosen.map((t) => t.id),
        track,
      );
      showSnack(
        photos.skippedTrails > 0
          ? `Merged ${chosen.length} trails into "${track.name}". Photos from ${photos.skippedTrails} of them could not be copied (saved by a newer version of Inukshuk).`
          : `Merged ${chosen.length} trails into "${track.name}"`,
      );
    } catch (err) {
      showSnack(`Merge failed: ${err instanceof Error ? err.message : 'could not read a trail'}`);
    } finally {
      setMerging(false);
    }
  }, [resolved, merging, showSnack]);

  const deleteFolder = useCallback(() => {
    if (folder === null) return;
    const snapshot = useLibraryStore.getState().removeFolderForUndo(folder.id);
    setFolderId(null);
    if (snapshot === null) return;
    undo.show({
      message: `Deleted folder "${folder.name}"`,
      undo: () => useLibraryStore.getState().restoreFolder(snapshot),
    });
  }, [folder, undo]);

  // --- The bar --------------------------------------------------------------------

  const itemStates = useMemo(
    () => selectionActions(resolved, activeTrackIds),
    [resolved, activeTrackIds],
  );
  const folderStates = useMemo(
    () => (folderContents === null ? null : folderActions(folderContents, activeTrackIds)),
    [folderContents, activeTrackIds],
  );

  const slots: BarSlot[] =
    folderStates !== null
      ? [
          { id: 'share', icon: 'share-variant', state: folderStates.share, primary: true },
          {
            id: 'show',
            icon: folderStates.show.label === 'Hide from map' ? 'eye-off-outline' : 'eye-outline',
            state: folderStates.show,
          },
          { id: 'rename', icon: 'pencil-outline', state: folderStates.rename },
          { id: 'delete', icon: 'trash-can-outline', state: folderStates.delete, danger: true },
        ]
      : [
          { id: 'move', icon: 'folder-move-outline', state: itemStates.move, primary: true },
          {
            id: 'show',
            icon: itemStates.show.label === 'Hide from map' ? 'eye-off-outline' : 'eye-outline',
            state: itemStates.show,
          },
          { id: 'share', icon: 'share-variant', state: itemStates.share },
          {
            id: 'merge',
            icon: 'call-merge',
            state: merging
              ? { ...itemStates.merge, enabled: false, reason: 'Merging…' }
              : itemStates.merge,
          },
          { id: 'delete', icon: 'trash-can-outline', state: itemStates.delete, danger: true },
        ];

  const onAction = (id: string) => {
    reason.dismiss();
    if (folder !== null && folderContents !== null) {
      if (id === 'share') openShare(folderContents, folder.name);
      else if (id === 'show') toggleShown(folderContents);
      else if (id === 'rename') requestRenameFolder({ id: folder.id, name: folder.name });
      else if (id === 'delete') deleteFolder();
      return;
    }
    if (id === 'move') setMoveOpen(true);
    else if (id === 'show') toggleShown(resolved);
    else if (id === 'share') openShare(resolved, null);
    else if (id === 'merge') void merge();
    else if (id === 'delete') deleteSelection();
  };

  const counts = useMemo(() => folderCounts(lib), [lib]);
  const move = useMemo(
    () => (moveOpen ? moveOptions(folders, resolved, counts) : null),
    [moveOpen, folders, resolved, counts],
  );

  const header: ReactNode = !active ? null : folder !== null && folderContents !== null ? (
    <SelectionHeader
      title={folder.name}
      summary={`Folder · ${itemCount(folderContents.refs.length)}`}
      selectAll={null}
      onClose={exit}
    />
  ) : (
    <SelectionHeader
      title={`${resolved.refs.length} selected`}
      summary={kindSummary(resolved.refs)}
      selectAll={
        scope.length > 0
          ? { label: everything ? 'Deselect all' : 'Select all', onPress: selectAll }
          : null
      }
      onClose={exit}
    />
  );

  const barBottom = BAR_HEIGHT + Math.max(insets.bottom, space.sm);
  const n = resolved.refs.length;
  const overlay: ReactNode = (
    <>
      {active && (
        <SelectionActionBar
          slots={slots}
          onAction={onAction}
          onExplain={reason.show}
          testIDPrefix={folder !== null ? 'library-folder-action' : 'library-action'}
        />
      )}
      {active && <ReasonTip message={reason.message} />}
      <UndoBar
        message={undo.message}
        onUndo={undo.undo}
        bottom={active ? barBottom + space.md : space.md}
      />
      <MoveToFolderSheet
        visible={move !== null}
        focused={args.focused}
        title={`Move ${itemCount(n)} to…`}
        subtitle={kindSummary(resolved.refs)}
        newFolderDetail={`Name it, and the ${n === 1 ? 'item goes' : `${n} items go`} in`}
        options={move?.options ?? []}
        canRemove={move?.canRemove ?? false}
        onNewFolder={() => {
          // The sheet closes first: a Paper dialog never stacks over a sheet.
          setMoveOpen(false);
          requestNewFolder();
        }}
        onMove={moveSelectionTo}
        onClose={() => setMoveOpen(false)}
      />
      <ShareSheet
        visible={shareTarget !== null}
        focused={args.focused}
        title={shareTarget?.title ?? ''}
        subtitle={shareTarget?.subtitle ?? ''}
        plan={shareTarget?.plan ?? null}
        bytes={shareBytes}
        sizeNote={shareTarget?.sizeNote}
        busy={sharing}
        onSend={() => void send()}
        onClose={() => {
          if (!sharing) setShareTarget(null);
        }}
      />
    </>
  );

  return {
    /** Items are selected (not a folder). */
    selecting,
    /** Anything is selected: the header and bar are up. */
    active,
    /** The selected folder's id, or null. */
    selectedFolderId: folder?.id ?? null,
    keys,
    flashKeys,
    /** Bottom offset for the screen's own snackbar while the bar is up. */
    barBottom: active ? barBottom : 0,
    header,
    overlay,
    press,
    longPress,
    longPressFolder,
    pickForMerge,
    shareTrail,
    moveIntoNewFolder,
    dropSelection,
    exit,
    /** How many items a drag of a selected row carries. */
    count: n,
    /** The Undo bar is up. */
    undoVisible: undo.message !== null,
  };
}
