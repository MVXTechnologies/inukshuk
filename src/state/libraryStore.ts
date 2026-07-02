import type {
  Bundle,
  Folder,
  GeoReference,
  MapDocument,
  Track,
  TrackNote,
  TrackSummary,
} from '@core/models';
import type { ImportedNote } from '@core/geo/track';
import { bundleMapActivePages, pruneBundles, toggleId } from '@core/library/bundles';
import { removeNoteById } from '@core/library/notes';
import * as storage from '@data/storage';
import { create } from 'zustand';

/**
 * Normalize a persisted map document to the current shape. Older builds stored a
 * single `georeference` (or none); the current model stores `georeferences[]` +
 * `activePages[]`. This keeps existing libraries working after an update.
 */
function migrateDoc(raw: MapDocument & { georeference?: GeoReference | null }): MapDocument {
  const georeferences = Array.isArray(raw.georeferences)
    ? raw.georeferences
    : raw.georeference
      ? [raw.georeference]
      : [];
  const activePages = Array.isArray(raw.activePages)
    ? raw.activePages
    : georeferences.map((g) => g.pageIndex);
  return {
    id: raw.id,
    name: raw.name,
    fileUri: raw.fileUri,
    importedAt: raw.importedAt,
    pageCount: raw.pageCount,
    georeferences,
    activePages,
    georeferenceWarning: raw.georeferenceWarning,
    folderId: raw.folderId,
  };
}

interface LibraryIndex {
  maps: MapDocument[];
  tracks: TrackSummary[];
  bundles: Bundle[];
  folders: Folder[];
  activeMapId: string | null;
}

interface LibraryState extends LibraryIndex {
  hydrated: boolean;
  hydrate: () => Promise<void>;
  addMap: (doc: MapDocument) => void;
  updateMap: (id: string, patch: Partial<MapDocument>) => void;
  removeMap: (id: string) => void;
  setActiveMap: (id: string | null) => void;
  /** Toggle whether a georeferenced page of a map is shown as an overlay. */
  toggleMapPage: (id: string, pageIndex: number) => void;
  addTrack: (track: Track, fileUri: string, notes?: readonly ImportedNote[]) => void;
  removeTrack: (id: string) => void;
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
  // Bundles — named collections of maps + trails.
  addBundle: (name: string) => string;
  renameBundle: (id: string, name: string) => void;
  removeBundle: (id: string) => void;
  toggleBundleMap: (bundleId: string, mapId: string) => void;
  toggleBundleTrack: (bundleId: string, trackId: string) => void;
  /**
   * Turn on every overlay in the bundle: sets each member map's activePages to
   * all its georeferenced pages, and returns the member track ids so the caller
   * can show them as trail overlays (which live in the map store).
   */
  activateBundle: (id: string) => string[];
  // Folders — flat, cross-type containers that organize maps + trails by area.
  addFolder: (name: string) => string;
  renameFolder: (id: string, name: string) => void;
  /** Delete a folder; its maps/trails fall back to Ungrouped (folderId cleared). */
  removeFolder: (id: string) => void;
  /** Move a map or trail into a folder, or out of any folder when `folderId` is null. */
  setItemFolder: (kind: 'map' | 'track', itemId: string, folderId: string | null) => void;
  activeMap: () => MapDocument | null;
}

function persist(state: LibraryIndex & { hydrated: boolean }): void {
  // Never write before hydration: a mutation that lands mid-hydrate (e.g. a
  // cold-start "Open with" import) would persist an index built from the empty
  // initial state and wipe the on-disk library. Callers that can run that early
  // must `await hydrate()` first; this guard is the backstop.
  if (!state.hydrated) return;
  storage.writeIndex({
    maps: state.maps,
    tracks: state.tracks,
    bundles: state.bundles,
    folders: state.folders,
    activeMapId: state.activeMapId,
  } satisfies LibraryIndex);
}

// Single-flight hydration: concurrent callers (RootLayout's effect and a
// cold-start "Open with" intent) await the same read instead of racing it.
let hydration: Promise<void> | null = null;

export const useLibraryStore = create<LibraryState>((set, get) => ({
  maps: [],
  tracks: [],
  bundles: [],
  folders: [],
  activeMapId: null,
  hydrated: false,

  hydrate: () => {
    if (get().hydrated) return Promise.resolve();
    hydration ??= (async () => {
      storage.ensureStorage();
      const index = await storage.readIndex<LibraryIndex>();
      if (index) {
        set({
          maps: (index.maps ?? []).map(migrateDoc),
          tracks: index.tracks ?? [],
          bundles: index.bundles ?? [],
          folders: index.folders ?? [],
          activeMapId: index.activeMapId ?? null,
          hydrated: true,
        });
      } else {
        set({ hydrated: true });
      }
    })();
    return hydration;
  },

  addMap: (doc) =>
    set((s) => {
      const next = { ...s, maps: [doc, ...s.maps], activeMapId: doc.id };
      persist(next);
      return next;
    }),

  updateMap: (id, patch) =>
    set((s) => {
      const next = { ...s, maps: s.maps.map((m) => (m.id === id ? { ...m, ...patch } : m)) };
      persist(next);
      return next;
    }),

  removeMap: (id) =>
    set((s) => {
      const doc = s.maps.find((m) => m.id === id);
      if (doc) storage.deleteFileAt(doc.fileUri);
      const next = {
        ...s,
        maps: s.maps.filter((m) => m.id !== id),
        bundles: pruneBundles(s.bundles, { mapId: id }),
        activeMapId: s.activeMapId === id ? null : s.activeMapId,
      };
      persist(next);
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
      const next = {
        ...s,
        maps: s.maps.map((m) => {
          if (m.id !== id) return m;
          const on = m.activePages.includes(pageIndex);
          return {
            ...m,
            activePages: on
              ? m.activePages.filter((p) => p !== pageIndex)
              : [...m.activePages, pageIndex].sort((a, b) => a - b),
          };
        }),
      };
      persist(next);
      return next;
    }),

  addTrack: (track, fileUri, notes) =>
    set((s) => {
      const seeded =
        notes && notes.length > 0
          ? notes.map((n) => ({
              id: storage.newId(),
              distanceM: Math.max(0, n.distanceM),
              text: n.text.trim(),
              createdAt: Date.now(),
            }))
          : undefined;
      const summary: TrackSummary = {
        id: track.id,
        name: track.name,
        startedAt: track.startedAt,
        endedAt: track.endedAt,
        stats: track.stats,
        fileUri,
        ...(seeded ? { notes: seeded } : {}),
      };
      const next = { ...s, tracks: [summary, ...s.tracks] };
      persist(next);
      return next;
    }),

  removeTrack: (id) =>
    set((s) => {
      const t = s.tracks.find((x) => x.id === id);
      if (t) {
        storage.deleteFileAt(t.fileUri);
        t.notes?.forEach((n) => n.photoUri && storage.deleteFileAt(n.photoUri));
      }
      const next = {
        ...s,
        tracks: s.tracks.filter((x) => x.id !== id),
        bundles: pruneBundles(s.bundles, { trackId: id }),
      };
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
      // Replacing or clearing the photo: delete the now-orphaned file.
      if (old?.photoUri && photoUri !== undefined && photoUri !== old.photoUri) {
        storage.deleteFileAt(old.photoUri);
      }
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
      persist(next);
      return next;
    }),

  removeTrackNote: (trackId, noteId) =>
    set((s) => {
      const old = s.tracks.find((t) => t.id === trackId)?.notes?.find((n) => n.id === noteId);
      if (old?.photoUri) storage.deleteFileAt(old.photoUri);
      const next = {
        ...s,
        tracks: s.tracks.map((t) =>
          t.id === trackId ? { ...t, notes: removeNoteById(t.notes ?? [], noteId) } : t,
        ),
      };
      persist(next);
      return next;
    }),

  addBundle: (name) => {
    const id = storage.newId();
    set((s) => {
      const bundle: Bundle = {
        id,
        name: name.trim() || 'Bundle',
        mapIds: [],
        trackIds: [],
        createdAt: Date.now(),
      };
      const next = { ...s, bundles: [bundle, ...s.bundles] };
      persist(next);
      return next;
    });
    return id;
  },

  renameBundle: (id, name) =>
    set((s) => {
      const next = {
        ...s,
        bundles: s.bundles.map((b) => (b.id === id ? { ...b, name: name.trim() || b.name } : b)),
      };
      persist(next);
      return next;
    }),

  removeBundle: (id) =>
    set((s) => {
      const next = { ...s, bundles: s.bundles.filter((b) => b.id !== id) };
      persist(next);
      return next;
    }),

  toggleBundleMap: (bundleId, mapId) =>
    set((s) => {
      const next = {
        ...s,
        bundles: s.bundles.map((b) =>
          b.id === bundleId ? { ...b, mapIds: toggleId(b.mapIds, mapId) } : b,
        ),
      };
      persist(next);
      return next;
    }),

  toggleBundleTrack: (bundleId, trackId) =>
    set((s) => {
      const next = {
        ...s,
        bundles: s.bundles.map((b) =>
          b.id === bundleId ? { ...b, trackIds: toggleId(b.trackIds, trackId) } : b,
        ),
      };
      persist(next);
      return next;
    }),

  activateBundle: (id) => {
    const { bundles, maps } = get();
    const bundle = bundles.find((b) => b.id === id);
    if (!bundle) return [];
    const activations = bundleMapActivePages(bundle, maps);
    set((s) => {
      const next = {
        ...s,
        maps: s.maps.map((m) =>
          m.id in activations ? { ...m, activePages: activations[m.id]! } : m,
        ),
      };
      persist(next);
      return next;
    });
    return bundle.trackIds.filter((tid) => get().tracks.some((t) => t.id === tid));
  },

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
      };
      persist(next);
      return next;
    }),

  setItemFolder: (kind, itemId, folderId) =>
    set((s) => {
      const folder = folderId ?? undefined;
      const next =
        kind === 'map'
          ? { ...s, maps: s.maps.map((m) => (m.id === itemId ? { ...m, folderId: folder } : m)) }
          : {
              ...s,
              tracks: s.tracks.map((t) => (t.id === itemId ? { ...t, folderId: folder } : t)),
            };
      persist(next);
      return next;
    }),

  activeMap: () => {
    const { maps, activeMapId } = get();
    return maps.find((m) => m.id === activeMapId) ?? null;
  },
}));
