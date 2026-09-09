import type { Folder, MapDocument, Track, TrackNote, TrackSummary, Waypoint } from '@core/models';
import type { ImportedNote } from '@core/geo/track';
import { toggleId } from '@core/library/toggleId';
import type { CustomCategory } from '@core/library/categories';
import {
  LIBRARY_SCHEMA_VERSION,
  mapLibraryIndexPaths,
  migrateLibraryIndex,
  type LibraryIndex,
} from '@core/library/migrations';
import { isAbsolutePath } from '@core/storage/documentPaths';
import { removeNoteById } from '@core/library/notes';
import { nextFolderVisibility } from '@core/library/visibility';
import { nextWaypointLabel } from '@core/library/waypoints';
import * as storage from '@data/storage';
import {
  clearInterruptedPdfRender,
  protectInterruptedPdfRender,
  readInterruptedPdfRender,
} from '@data/pdfRenderRecovery';
import { reportError } from '@lib/errorReporting';
import { create } from 'zustand';

/**
 * A note to seed on a trail as it is added to the library: an {@link
 * ImportedNote} from a GPX import, or a live recorder waypoint — which can
 * additionally carry a photo.
 */
export interface SeedNote extends ImportedNote {
  /** Absolute file:// uri of an attached photo (already copied into storage). */
  photoUri?: string;
}

/** A trail as it comes out of an import: the parsed track, its GPX file and any notes. */
export interface ImportedTrack {
  track: Track;
  fileUri: string;
  notes?: readonly SeedNote[];
}

interface LibraryState extends Omit<LibraryIndex, 'schemaVersion'> {
  hydrated: boolean;
  pdfRecoveryNotice: string | null;
  dismissPdfRecoveryNotice: () => void;
  hydrate: () => Promise<void>;
  addMap: (doc: MapDocument) => void;
  /**
   * Add several maps at once, keeping `docs` order at the top of the library
   * and making the first one active — a multi-file import in ONE index write
   * instead of one full serialization per picked file.
   */
  addMaps: (docs: readonly MapDocument[]) => void;
  updateMap: (id: string, patch: Partial<MapDocument>) => void;
  /**
   * Rename an imported map (the title shown on its Library card, its drag
   * ghost and its delete confirmation). Same guard as
   * {@link renameTrack}: the name is trimmed and a blank one is rejected.
   * Index-level only — the PDF on disk is never rewritten, so the document's
   * own embedded title is left alone (the same reason a trail rename does not
   * touch the GPX's `<name>`). Duplicate names are allowed: maps are addressed
   * by id everywhere, and the data export dedupes colliding file names itself.
   */
  renameMap: (id: string, name: string) => void;
  removeMap: (id: string) => void;
  setActiveMap: (id: string | null) => void;
  /** Toggle whether a georeferenced page of a map is shown as an overlay. */
  toggleMapPage: (id: string, pageIndex: number) => void;
  retryMapPage: (id: string, pageIndex: number) => void;
  pauseMapPageAfterRenderFailure: (
    id: string,
    pageIndex: number,
    message: string,
    expected?: { fileUri: string; importedAt: number },
  ) => void;
  /**
   * Add a trail with all of its seeded notes in ONE index write — the recorder's
   * save path relies on this: a per-note `addTrackNote` loop cost one full
   * serialization + atomic swap of the whole library per dropped waypoint.
   */
  addTrack: (track: Track, fileUri: string, notes?: readonly SeedNote[]) => void;
  /** Add several imported trails in `items` order, in ONE index write. */
  addTracks: (items: readonly ImportedTrack[]) => void;
  /** Patch a saved trail, including switching its file URI to a committed revision. */
  updateTrack: (id: string, patch: Partial<Omit<TrackSummary, 'id'>>) => void;
  /**
   * Rename a saved trail (the user-facing title of an activity). A blank or
   * whitespace-only name is rejected — the trail keeps its current one, the
   * same guard `renameFolder` applies. Duplicate names are allowed: trails are
   * addressed by id everywhere, and the data export dedupes colliding file
   * names on its own.
   */
  renameTrack: (id: string, name: string) => void;
  removeTrack: (id: string) => void;
  // Trail overlays — which saved trails are drawn on the main map. Persisted
  // (like maps' activePages) so the selection survives an app restart.
  /** Toggle whether a saved trail is drawn as an overlay on the main map. */
  toggleTrackOverlay: (id: string) => void;
  /** Replace the set of trail overlays (e.g. "view trail"). */
  setActiveTrackIds: (ids: string[]) => void;
  // Trail annotations (GPX editor) — anchored by distance along the trail.
  addTrackNote: (trackId: string, distanceM: number, text: string, photoUri?: string) => string;
  /** Update a note's text and, when `photoUri` is given, its photo (null = remove). */
  updateTrackNote: (
    trackId: string,
    noteId: string,
    text: string,
    photoUri?: string | null,
  ) => void;
  removeTrackNote: (trackId: string, noteId: string) => void;
  // Map-visibility mode: 'type' shows the classic PDF/Trails toggles' picks;
  // 'folders' shows exactly the checked folders' items (see visibleFolderIds).
  setMapVisibilityMode: (mode: 'type' | 'folders') => void;
  /**
   * One tap on a folder row in the map's content picker: enter 'folders' mode
   * AND move the folder (or the 'ungrouped' pseudo-id) in the visible set, in
   * a single `set()` / single index write. This deliberately replaces the old
   * `setMapVisibilityMode` + `toggleVisibleFolder` pair, which cost two
   * synchronous serializations of the whole index per tap and passed through a
   * mode='folders' / selection=[] state that shows an empty map.
   */
  showFolder: (id: string) => void;
  // Folders — flat, cross-type containers that organize maps + trails by area.
  addFolder: (name: string) => string;
  renameFolder: (id: string, name: string) => void;
  /** Delete a folder; its maps/trails fall back to Ungrouped (folderId cleared). */
  removeFolder: (id: string) => void;
  /**
   * Move an item into a folder, or out of any folder when `folderId` is null.
   * An unknown folder id is ignored (no-op) rather than committed as dangling.
   */
  setItemFolder: (
    kind: 'map' | 'track' | 'waypoint',
    itemId: string,
    folderId: string | null,
  ) => void;
  // Activity categories — built-ins live in @core/library/categories; only
  // user-defined ones are stored (and persisted) here.
  /** Create a custom category (name assumed pre-validated); returns its id. */
  addCustomCategory: (name: string, color: string) => string;
  /** Set (or clear, with null) a saved trail's activity category. */
  setTrackCategory: (trackId: string, category: string | null) => void;
  // Standalone waypoints — dropped from the map's "+" speed-dial outside any
  // recording, persisted in the index (a live recording's waypoints live in the
  // recorder store instead and become trail notes on stop).
  /**
   * Drop a waypoint at a position; returns its id so the editor can open on it.
   *
   * `label` is the name typed in the editor's Name field (#232). It is applied
   * at CREATION rather than through {@link renameWaypoint} afterwards, so a
   * named waypoint never briefly holds — and burns — an auto number. Blank or
   * omitted falls back to the next `Waypoint N`.
   */
  addWaypoint: (latitude: number, longitude: number, label?: string) => string;
  /** Edit a waypoint's note text and/or photo (empty photoUri removes the photo). */
  updateWaypoint: (id: string, patch: { note?: string; photoUri?: string }) => void;
  /**
   * Rename a waypoint (its `label` — the title shown on the pin, the Library
   * row, the drag ghost and the delete confirmation). Same guard as
   * {@link renameTrack}: trimmed, and a blank name keeps the current label.
   * Duplicates are allowed — waypoints are addressed by id, and `addWaypoint`
   * only ever reads labels still matching `Waypoint N` to pick its next
   * number, so a renamed one simply stops taking part in that numbering.
   */
  renameWaypoint: (id: string, label: string) => void;
  /** Remove a waypoint and any photo it owns. */
  removeWaypoint: (id: string) => void;
  activeMap: () => MapDocument | null;
}

function persist(state: Omit<LibraryIndex, 'schemaVersion'> & { hydrated: boolean }): void {
  // Never write before hydration: a mutation that lands mid-hydrate (e.g. a
  // cold-start "Open with" import) would persist an index built from the empty
  // initial state and wipe the on-disk library. Callers that can run that early
  // must `await hydrate()` first; this guard is the backstop.
  if (!state.hydrated) return;
  const index: LibraryIndex = {
    schemaVersion: LIBRARY_SCHEMA_VERSION,
    maps: state.maps,
    tracks: state.tracks,
    folders: state.folders,
    mapVisibilityMode: state.mapVisibilityMode,
    visibleFolderIds: state.visibleFolderIds,
    activeMapId: state.activeMapId,
    activeTrackIds: state.activeTrackIds,
    customCategories: state.customCategories,
    waypoints: state.waypoints,
  };
  // #247 — the store holds ABSOLUTE uris (every consumer, from <Image> to
  // Sharing to the GPX reader, wants one), but the index on disk must hold
  // document-RELATIVE paths: iOS rotates the container UUID on app updates and
  // an absolute path written by the previous build points at nothing.
  // Relativising here, and resolving in `hydrate`, keeps that translation in
  // exactly one place per direction.
  storage.writeIndex(mapLibraryIndexPaths(index, storage.toDocumentPath));
}

/** Commit metadata before best-effort cleanup of files it no longer references. */
function persistAndDelete(
  state: LibraryState,
  orphanedUris: readonly (string | undefined)[],
): void {
  persist(state);
  if (!state.hydrated) return;
  for (const uri of orphanedUris) {
    if (!uri) continue;
    try {
      storage.deleteFileAt(uri);
    } catch {
      // Metadata is committed: keep memory consistent even if an orphan remains.
    }
  }
}

/**
 * Turn a just-migrated index's document-relative paths back into absolute uris
 * against the CURRENT container (#247) — the form every consumer expects.
 *
 * A path that is still absolute here is one the migration deliberately left
 * alone: it lives under no document directory, so we have no basis to rewrite
 * it. Warn rather than mangle it — that is the shape a genuinely foreign path
 * (or a future bug) would take, and it should be visible in the logs.
 */
function resolveStoredPaths(index: LibraryIndex): LibraryIndex {
  const foreign: string[] = [];
  const resolved = mapLibraryIndexPaths(index, (path) => {
    if (path !== '' && isAbsolutePath(path)) foreign.push(path);
    return storage.resolveDocumentPath(path);
  });
  if (foreign.length > 0) {
    console.warn(
      `[library] ${foreign.length} stored path(s) outside the document directory, left as-is:`,
      foreign.slice(0, 3),
    );
  }
  return resolved;
}

/** The persisted summary for a freshly imported/recorded trail. */
function toSummary({ track, fileUri, notes }: ImportedTrack): TrackSummary {
  const seeded =
    notes && notes.length > 0
      ? notes.map((n) => ({
          id: storage.newId(),
          distanceM: Math.max(0, n.distanceM),
          text: n.text.trim(),
          createdAt: Date.now(),
          ...(n.photoUri ? { photoUri: n.photoUri } : {}),
        }))
      : undefined;
  return {
    id: track.id,
    name: track.name,
    startedAt: track.startedAt,
    endedAt: track.endedAt,
    stats: track.stats,
    fileUri,
    ...(seeded ? { notes: seeded } : {}),
    ...(track.category ? { category: track.category } : {}),
  };
}

// Single-flight hydration: concurrent callers (RootLayout's effect and a
// cold-start "Open with" intent) await the same read instead of racing it.
let hydration: Promise<void> | null = null;

function clearMapRecoveryError(map: MapDocument, pageIndex: number): MapDocument {
  const { renderRecoveryErrors, ...rest } = map;
  const remaining = renderRecoveryErrors?.filter((error) => error.pageIndex !== pageIndex);
  return remaining?.length ? { ...rest, renderRecoveryErrors: remaining } : rest;
}

/** A protected checkpoint is acknowledged only after the user's retry is saved. */
function persistMapRetry(state: LibraryState, map: MapDocument, pageIndex: number): void {
  const interrupted = readInterruptedPdfRender();
  persist(state);
  if (
    interrupted?.pageIndex === pageIndex &&
    storage.toDocumentPath(interrupted.fileUri) === storage.toDocumentPath(map.fileUri)
  ) {
    clearInterruptedPdfRender(interrupted.token);
  }
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  maps: [],
  tracks: [],
  folders: [],
  mapVisibilityMode: 'type',
  visibleFolderIds: [],
  activeMapId: null,
  activeTrackIds: [],
  customCategories: [],
  waypoints: [],
  hydrated: false,
  pdfRecoveryNotice: null,
  dismissPdfRecoveryNotice: () => set({ pdfRecoveryNotice: null }),

  hydrate: () => {
    if (get().hydrated) return Promise.resolve();
    hydration ??= (async () => {
      storage.ensureStorage();
      // Snapshot before publishing any maps: restored active pages otherwise
      // immediately retry the render interrupted by the previous process exit.
      const interrupted = readInterruptedPdfRender();
      const raw = await storage.readIndex<unknown>();
      if (raw) {
        // Route every load through the schema-version migration ladder: legacy
        // unversioned indexes are normalized, junk is dropped, never throws.
        // The ladder also relativises stored paths (#247), healing an index
        // written under a container UUID iOS has since rotated away.
        const { schemaVersion: _v, ...index } = resolveStoredPaths(
          migrateLibraryIndex(raw, storage.documentDirUri()),
        );
        let pdfRecoveryNotice: string | null = null;
        if (interrupted) {
          const map = index.maps.find(
            (m) =>
              storage.toDocumentPath(m.fileUri) === storage.toDocumentPath(interrupted.fileUri),
          );
          if (map && interrupted.pageIndex < map.pageCount) {
            index.maps = index.maps.map((m) =>
              m === map
                ? {
                    ...m,
                    activePages: m.activePages.filter((p) => p !== interrupted.pageIndex),
                    renderRecoveryErrors: [
                      ...(m.renderRecoveryErrors ?? []).filter(
                        (error) => error.pageIndex !== interrupted.pageIndex,
                      ),
                      { pageIndex: interrupted.pageIndex, reason: 'interrupted' as const },
                    ],
                  }
                : m,
            );
            pdfRecoveryNotice = `Paused page ${interrupted.pageIndex + 1} of “${map.name}” after an interrupted render. Your maps are saved. Use Retry in Library to try this page again.`;
            try {
              // Save the paused page before consuming evidence. If storage is
              // full, keep the checkpoint and still expose the safe library.
              persist({ ...index, hydrated: true });
              clearInterruptedPdfRender(interrupted.token);
            } catch (error) {
              protectInterruptedPdfRender(interrupted.token);
              reportError(error, 'pdf-recovery-save');
            }
          } else {
            try {
              clearInterruptedPdfRender(interrupted.token);
            } catch (error) {
              reportError(error, 'pdf-recovery-cleanup');
            }
          }
        }
        set({ ...index, hydrated: true, pdfRecoveryNotice });
      } else {
        set({ hydrated: true });
      }
    })().finally(() => {
      hydration = null;
    });
    return hydration;
  },

  addMap: (doc) =>
    set((s) => {
      const next = { ...s, maps: [doc, ...s.maps], activeMapId: doc.id };
      persist(next);
      return next;
    }),

  addMaps: (docs) =>
    set((s) => {
      const first = docs[0];
      if (first === undefined) return s;
      const next = { ...s, maps: [...docs, ...s.maps], activeMapId: first.id };
      persist(next);
      return next;
    }),

  updateMap: (id, patch) =>
    set((s) => {
      const next = { ...s, maps: s.maps.map((m) => (m.id === id ? { ...m, ...patch } : m)) };
      persist(next);
      return next;
    }),

  renameMap: (id, name) =>
    set((s) => {
      const next = {
        ...s,
        maps: s.maps.map((m) => (m.id === id ? { ...m, name: name.trim() || m.name } : m)),
      };
      persist(next);
      return next;
    }),

  removeMap: (id) =>
    set((s) => {
      const doc = s.maps.find((m) => m.id === id);
      const next = {
        ...s,
        maps: s.maps.filter((m) => m.id !== id),
        activeMapId: s.activeMapId === id ? null : s.activeMapId,
      };
      persistAndDelete(next, [doc?.fileUri]);
      return next;
    }),

  setActiveMap: (id) =>
    set((s) => {
      const next = { ...s, activeMapId: id };
      persist(next);
      return next;
    }),

  toggleMapPage: (id, pageIndex) =>
    set((s) => {
      const retrying = s.maps.find(
        (m) =>
          m.id === id &&
          !m.activePages.includes(pageIndex) &&
          m.renderRecoveryErrors?.some((error) => error.pageIndex === pageIndex),
      );
      const next = {
        ...s,
        maps: s.maps.map((m) => {
          if (m.id !== id) return m;
          const on = m.activePages.includes(pageIndex);
          return {
            ...(on ? m : clearMapRecoveryError(m, pageIndex)),
            activePages: on
              ? m.activePages.filter((p) => p !== pageIndex)
              : [...m.activePages, pageIndex].sort((a, b) => a - b),
          };
        }),
      };
      if (retrying) persistMapRetry(next, retrying, pageIndex);
      else persist(next);
      return next;
    }),

  pauseMapPageAfterRenderFailure: (id, pageIndex, message, expected) =>
    set((s) => {
      const map = s.maps.find((m) => m.id === id);
      if (!map?.activePages.includes(pageIndex)) return s;
      if (
        expected &&
        (map.importedAt !== expected.importedAt ||
          storage.toDocumentPath(map.fileUri) !== storage.toDocumentPath(expected.fileUri))
      )
        return s;
      const paused: MapDocument = {
        ...map,
        activePages: map.activePages.filter((page) => page !== pageIndex),
        renderRecoveryErrors: [
          ...(map.renderRecoveryErrors ?? []).filter((error) => error.pageIndex !== pageIndex),
          { pageIndex, reason: 'render-failed', message: message.slice(0, 400) },
        ],
      };
      const next = { ...s, maps: s.maps.map((m) => (m === map ? paused : m)) };
      try {
        persist(next);
      } catch (error) {
        reportError(error, 'pdf-render-failure-save');
      }
      return next;
    }),

  retryMapPage: (id, pageIndex) =>
    set((s) => {
      const map = s.maps.find((m) => m.id === id);
      if (!map?.renderRecoveryErrors?.some((error) => error.pageIndex === pageIndex)) return s;
      const retried = {
        ...clearMapRecoveryError(map, pageIndex),
        activePages: [...new Set([...map.activePages, pageIndex])].sort((a, b) => a - b),
      };
      const next = { ...s, maps: s.maps.map((m) => (m === map ? retried : m)) };
      persistMapRetry(next, map, pageIndex);
      return next;
    }),

  addTrack: (track, fileUri, notes) =>
    set((s) => {
      const next = { ...s, tracks: [toSummary({ track, fileUri, notes }), ...s.tracks] };
      persist(next);
      return next;
    }),

  addTracks: (items) =>
    set((s) => {
      if (items.length === 0) return s;
      const next = { ...s, tracks: [...items.map(toSummary), ...s.tracks] };
      persist(next);
      return next;
    }),

  updateTrack: (id, patch) =>
    set((s) => {
      const next = { ...s, tracks: s.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)) };
      persist(next);
      return next;
    }),

  renameTrack: (id, name) =>
    set((s) => {
      const next = {
        ...s,
        tracks: s.tracks.map((t) => (t.id === id ? { ...t, name: name.trim() || t.name } : t)),
      };
      persist(next);
      return next;
    }),

  removeTrack: (id) =>
    set((s) => {
      const t = s.tracks.find((x) => x.id === id);
      const next = {
        ...s,
        tracks: s.tracks.filter((x) => x.id !== id),
        // A deleted trail must not linger as (or come back as) a map overlay.
        activeTrackIds: s.activeTrackIds.filter((x) => x !== id),
      };
      persistAndDelete(next, [t?.fileUri, ...(t?.notes?.map((n) => n.photoUri) ?? [])]);
      return next;
    }),

  toggleTrackOverlay: (id) =>
    set((s) => {
      const next = { ...s, activeTrackIds: toggleId(s.activeTrackIds, id) };
      persist(next);
      return next;
    }),

  setActiveTrackIds: (ids) =>
    set((s) => {
      const next = { ...s, activeTrackIds: ids };
      persist(next);
      return next;
    }),

  addTrackNote: (trackId, distanceM, text, photoUri) => {
    const id = storage.newId();
    set((s) => {
      const note: TrackNote = {
        id,
        distanceM: Math.max(0, distanceM),
        text: text.trim(),
        createdAt: Date.now(),
        ...(photoUri ? { photoUri } : {}),
      };
      const next = {
        ...s,
        tracks: s.tracks.map((t) =>
          t.id === trackId ? { ...t, notes: [...(t.notes ?? []), note] } : t,
        ),
      };
      persist(next);
      return next;
    });
    return id;
  },

  updateTrackNote: (trackId, noteId, text, photoUri) =>
    set((s) => {
      const old = s.tracks.find((t) => t.id === trackId)?.notes?.find((n) => n.id === noteId);
      const next = {
        ...s,
        tracks: s.tracks.map((t) =>
          t.id === trackId
            ? {
                ...t,
                notes: (t.notes ?? []).map((n) =>
                  n.id === noteId
                    ? {
                        ...n,
                        text: text.trim(),
                        ...(photoUri !== undefined ? { photoUri: photoUri ?? undefined } : {}),
                      }
                    : n,
                ),
              }
            : t,
        ),
      };
      persistAndDelete(next, [
        photoUri !== undefined && photoUri !== old?.photoUri ? old?.photoUri : undefined,
      ]);
      return next;
    }),

  removeTrackNote: (trackId, noteId) =>
    set((s) => {
      const old = s.tracks.find((t) => t.id === trackId)?.notes?.find((n) => n.id === noteId);
      const next = {
        ...s,
        tracks: s.tracks.map((t) =>
          t.id === trackId ? { ...t, notes: removeNoteById(t.notes ?? [], noteId) } : t,
        ),
      };
      persistAndDelete(next, [old?.photoUri]);
      return next;
    }),

  setMapVisibilityMode: (mode) =>
    set((s) => {
      const next = { ...s, mapVisibilityMode: mode };
      persist(next);
      return next;
    }),

  showFolder: (id) =>
    set((s) => {
      const v = nextFolderVisibility(
        { mode: s.mapVisibilityMode, visibleFolderIds: s.visibleFolderIds },
        id,
      );
      const next = { ...s, mapVisibilityMode: v.mode, visibleFolderIds: [...v.visibleFolderIds] };
      persist(next);
      return next;
    }),

  addFolder: (name) => {
    const id = storage.newId();
    set((s) => {
      const folder: Folder = { id, name: name.trim() || 'Folder', createdAt: Date.now() };
      const next = { ...s, folders: [...s.folders, folder] };
      persist(next);
      return next;
    });
    return id;
  },

  renameFolder: (id, name) =>
    set((s) => {
      const next = {
        ...s,
        folders: s.folders.map((f) => (f.id === id ? { ...f, name: name.trim() || f.name } : f)),
      };
      persist(next);
      return next;
    }),

  removeFolder: (id) =>
    set((s) => {
      const clear = <T extends { folderId?: string }>(item: T): T =>
        item.folderId === id ? { ...item, folderId: undefined } : item;
      const next = {
        ...s,
        folders: s.folders.filter((f) => f.id !== id),
        maps: s.maps.map(clear),
        tracks: s.tracks.map(clear),
        waypoints: s.waypoints.map(clear),
        visibleFolderIds: s.visibleFolderIds.filter((f) => f !== id),
      };
      persist(next);
      return next;
    }),

  setItemFolder: (kind, itemId, folderId) =>
    set((s) => {
      // A destination that no longer exists (deleted folder, stale drag
      // target — #303) must not be committed: the item would render under
      // Ungrouped while the UI reports "Moved to …".
      if (folderId !== null && !s.folders.some((f) => f.id === folderId)) return s;
      const folder = folderId ?? undefined;
      const next =
        kind === 'map'
          ? { ...s, maps: s.maps.map((m) => (m.id === itemId ? { ...m, folderId: folder } : m)) }
          : kind === 'track'
            ? {
                ...s,
                tracks: s.tracks.map((t) => (t.id === itemId ? { ...t, folderId: folder } : t)),
              }
            : {
                ...s,
                waypoints: s.waypoints.map((w) =>
                  w.id === itemId ? { ...w, folderId: folder } : w,
                ),
              };
      persist(next);
      return next;
    }),

  addCustomCategory: (name, color) => {
    const id = storage.newId();
    set((s) => {
      const category: CustomCategory = { id, name: name.trim(), color, createdAt: Date.now() };
      const next = { ...s, customCategories: [...s.customCategories, category] };
      persist(next);
      return next;
    });
    return id;
  },

  addWaypoint: (latitude, longitude, label) => {
    const id = storage.newId();
    const typed = label?.trim() ?? '';
    set((s) => {
      // Number past the highest existing auto label so deleting "Waypoint 1"
      // and dropping a new one never mints a duplicate name. A typed name wins
      // outright and takes no number at all (#232).
      const waypoint: Waypoint = {
        id,
        latitude,
        longitude,
        label: typed === '' ? nextWaypointLabel(s.waypoints.map((w) => w.label)) : typed,
        createdAt: Date.now(),
      };
      const next = { ...s, waypoints: [...s.waypoints, waypoint] };
      persist(next);
      return next;
    });
    return id;
  },

  setTrackCategory: (trackId, category) =>
    set((s) => {
      const next = {
        ...s,
        tracks: s.tracks.map((t) =>
          t.id === trackId ? { ...t, category: category ?? undefined } : t,
        ),
      };
      persist(next);
      return next;
    }),

  updateWaypoint: (id, patch) =>
    set((s) => {
      const old = s.waypoints.find((w) => w.id === id);
      const next = {
        ...s,
        waypoints: s.waypoints.map((w) => {
          if (w.id !== id) return w;
          const updated: Waypoint = { ...w };
          if (patch.note !== undefined) updated.note = patch.note;
          if (patch.photoUri !== undefined) {
            if (patch.photoUri) updated.photoUri = patch.photoUri;
            else delete updated.photoUri;
          }
          return updated;
        }),
      };
      persistAndDelete(next, [
        patch.photoUri !== undefined && patch.photoUri !== old?.photoUri
          ? old?.photoUri
          : undefined,
      ]);
      return next;
    }),

  renameWaypoint: (id, label) =>
    set((s) => {
      const next = {
        ...s,
        waypoints: s.waypoints.map((w) =>
          w.id === id ? { ...w, label: label.trim() || w.label } : w,
        ),
      };
      persist(next);
      return next;
    }),

  removeWaypoint: (id) =>
    set((s) => {
      const w = s.waypoints.find((x) => x.id === id);
      const next = { ...s, waypoints: s.waypoints.filter((x) => x.id !== id) };
      persistAndDelete(next, [w?.photoUri]);
      return next;
    }),

  activeMap: () => {
    const { maps, activeMapId } = get();
    return maps.find((m) => m.id === activeMapId) ?? null;
  },
}));
