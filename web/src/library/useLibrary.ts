import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { parseGpx } from '@core/geo/gpx';
import { LIBRARY_SCHEMA_VERSION } from '@core/library/migrations';
import { toggleId } from '@core/library/toggleId';
import { nextFolderVisibility } from '@core/library/visibility';
import type { Folder, TrackPoint } from '@core/models';

import { DEMO_CUSTOM_CATEGORIES, DEMO_FOLDERS, DEMO_ROUTES, DEMO_WAYPOINTS } from '@/demo/routes';
import { synthGpx } from '@/demo/synth';
import { GPX_STORE, idb, LIBRARY_STORE } from '@/lib/idb';

import { importGpxText, TRACK_PALETTE } from './importGpx';
import type { WebLibraryIndex, WebTrack } from './types';

const INDEX_KEY = 'index';

const EMPTY_INDEX: WebLibraryIndex = {
  schemaVersion: LIBRARY_SCHEMA_VERSION,
  folders: [],
  tracks: [],
  waypoints: [],
  customCategories: [],
  mapVisibilityMode: 'type',
  visibleFolderIds: [],
  demoSeeded: false,
};

export interface LibraryState {
  index: WebLibraryIndex;
  ready: boolean;
  /** Non-null while the demo library is being generated, 0..1. */
  seeding: number | null;

  addFolder: (name: string) => void;
  renameFolder: (id: string, name: string) => void;
  removeFolder: (id: string) => void;
  setItemFolder: (kind: 'track' | 'waypoint', id: string, folderId: string | null) => void;
  setTrackCategory: (id: string, category: string | null) => void;
  renameTrack: (id: string, name: string) => void;
  removeTrack: (id: string) => void;
  removeWaypoint: (id: string) => void;
  /** One tap on a folder row in the visibility picker (`nextFolderVisibility`). */
  showFolder: (id: string) => void;
  /** The picker's "Everything" row: back to type mode. */
  showEverything: () => void;
  /** Parse and add dropped GPX files. Returns a line to toast. */
  importFiles: (files: readonly File[]) => Promise<string>;
  /** Load (and memoize) the full point list of one trail. */
  loadPoints: (id: string) => Promise<TrackPoint[]>;
  /** Replace a trail's points after a trim, or add the trimmed copy. */
  applyTrim: (
    id: string,
    points: readonly TrackPoint[],
    mode: 'overwrite' | 'copy',
  ) => Promise<string>;
  /** Throw the whole library away and re-seed the demo content. */
  reseed: () => Promise<void>;
}

/** Newly created ids. Short and readable in the URL, which carries a trail id. */
const newId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/**
 * The Library's data layer.
 *
 * Shaped after `src/state/libraryStore.ts`: one index object, every mutation a
 * pure transform of it, and a persist on every write. Mutation *semantics* are
 * `@core/library/*` wherever they exist — `nextFolderVisibility` for the folder
 * picker, `toggleId` for the selection set — so a rule the app fixed once is
 * not re-derived (and re-broken) here.
 */
export function useLibrary(): LibraryState {
  const [index, setIndex] = useState<WebLibraryIndex>(EMPTY_INDEX);
  const [ready, setReady] = useState(false);
  const [seeding, setSeeding] = useState<number | null>(null);

  // Parsed point lists, keyed by trail id. Never persisted: they are ~90 000
  // objects across the demo library and re-parse in a few ms from the text
  // already in IndexedDB.
  const pointCache = useRef(new Map<string, TrackPoint[]>());

  const persist = useCallback((next: WebLibraryIndex) => {
    setIndex(next);
    void idb.put(LIBRARY_STORE, INDEX_KEY, next).catch(() => undefined);
  }, []);

  /** Apply a pure transform to the index and persist the result. */
  const update = useCallback(
    (fn: (prev: WebLibraryIndex) => WebLibraryIndex) => {
      setIndex((prev) => {
        const next = fn(prev);
        void idb.put(LIBRARY_STORE, INDEX_KEY, next).catch(() => undefined);
        return next;
      });
    },
    [setIndex],
  );

  // ------------------------------------------------------------- seeding ---
  const seed = useCallback(async (): Promise<WebLibraryIndex> => {
    const tracks: WebTrack[] = [];
    setSeeding(0);
    for (let i = 0; i < DEMO_ROUTES.length; i++) {
      const route = DEMO_ROUTES[i]!;
      const xml = synthGpx(route);
      const { track } = importGpxText(xml, route.name, route.startedAt || Date.now(), {
        id: route.id,
        name: route.name,
        color: TRACK_PALETTE[i % TRACK_PALETTE.length]!,
        ...(route.category === undefined ? {} : { category: route.category }),
        ...(route.folderId === undefined ? {} : { folderId: route.folderId }),
      });
      tracks.push(track);
      await idb.put(GPX_STORE, route.id, xml).catch(() => undefined);
      setSeeding((i + 1) / DEMO_ROUTES.length);
      // Yield so the progress line actually paints between routes; synthesising
      // 23 multi-thousand-point recordings back to back would otherwise block
      // the main thread for about a second with a frozen UI.
      await new Promise((r) => setTimeout(r, 0));
    }

    // Newest first, matching the app's store (which prepends on add).
    tracks.sort((a, b) => b.startedAt - a.startedAt);

    const next: WebLibraryIndex = {
      schemaVersion: LIBRARY_SCHEMA_VERSION,
      folders: [...DEMO_FOLDERS],
      tracks,
      waypoints: [...DEMO_WAYPOINTS],
      customCategories: [...DEMO_CUSTOM_CATEGORIES],
      mapVisibilityMode: 'type',
      visibleFolderIds: [],
      demoSeeded: true,
    };
    setSeeding(null);
    return next;
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const stored = await idb.get<WebLibraryIndex>(LIBRARY_STORE, INDEX_KEY);
        if (stored !== undefined && stored.demoSeeded) {
          setIndex(stored);
          return;
        }
        persist(await seed());
      } catch {
        // A blocked IndexedDB (private mode) must not take the screen down —
        // seed into memory and accept that a reload starts over.
        try {
          setIndex(await seed());
        } catch {
          setIndex(EMPTY_INDEX);
        }
      } finally {
        setReady(true);
      }
    })();
  }, [persist, seed]);

  const reseed = useCallback(async () => {
    pointCache.current.clear();
    await idb.clear(GPX_STORE).catch(() => undefined);
    persist(await seed());
  }, [persist, seed]);

  // ----------------------------------------------------------- mutations ---
  const addFolder = useCallback(
    (name: string) => {
      const folder: Folder = {
        id: newId('f'),
        name: name.trim() || 'New folder',
        createdAt: Date.now(),
      };
      update((prev) => ({ ...prev, folders: [...prev.folders, folder] }));
    },
    [update],
  );

  const renameFolder = useCallback(
    (id: string, name: string) => {
      const clean = name.trim();
      if (clean === '') return;
      update((prev) => ({
        ...prev,
        folders: prev.folders.map((f) => (f.id === id ? { ...f, name: clean } : f)),
      }));
    },
    [update],
  );

  const removeFolder = useCallback(
    (id: string) => {
      update((prev) => ({
        ...prev,
        folders: prev.folders.filter((f) => f.id !== id),
        // Items fall back to Ungrouped rather than disappearing with the
        // folder — same rule as the app's `removeFolder`.
        tracks: prev.tracks.map((t) => (t.folderId === id ? stripFolder(t) : t)),
        waypoints: prev.waypoints.map((w) => (w.folderId === id ? stripFolder(w) : w)),
        visibleFolderIds: prev.visibleFolderIds.filter((v) => v !== id),
      }));
    },
    [update],
  );

  const setItemFolder = useCallback(
    (kind: 'track' | 'waypoint', id: string, folderId: string | null) => {
      update((prev) =>
        kind === 'track'
          ? {
              ...prev,
              tracks: prev.tracks.map((t) =>
                t.id === id ? (folderId === null ? stripFolder(t) : { ...t, folderId }) : t,
              ),
            }
          : {
              ...prev,
              waypoints: prev.waypoints.map((w) =>
                w.id === id ? (folderId === null ? stripFolder(w) : { ...w, folderId }) : w,
              ),
            },
      );
    },
    [update],
  );

  const setTrackCategory = useCallback(
    (id: string, category: string | null) => {
      update((prev) => ({
        ...prev,
        tracks: prev.tracks.map((t) => {
          if (t.id !== id) return t;
          if (category === null) {
            const { category: _drop, ...rest } = t;
            return rest;
          }
          return { ...t, category };
        }),
      }));
    },
    [update],
  );

  const renameTrack = useCallback(
    (id: string, name: string) => {
      const clean = name.trim();
      if (clean === '') return;
      update((prev) => ({
        ...prev,
        tracks: prev.tracks.map((t) => (t.id === id ? { ...t, name: clean } : t)),
      }));
    },
    [update],
  );

  const removeTrack = useCallback(
    (id: string) => {
      pointCache.current.delete(id);
      void idb.remove(GPX_STORE, id).catch(() => undefined);
      update((prev) => ({ ...prev, tracks: prev.tracks.filter((t) => t.id !== id) }));
    },
    [update],
  );

  const removeWaypoint = useCallback(
    (id: string) => {
      update((prev) => ({ ...prev, waypoints: prev.waypoints.filter((w) => w.id !== id) }));
    },
    [update],
  );

  // ---------------------------------------------------------- visibility ---
  const showFolder = useCallback(
    (id: string) => {
      update((prev) => {
        const next = nextFolderVisibility(
          { mode: prev.mapVisibilityMode, visibleFolderIds: prev.visibleFolderIds },
          id,
        );
        return {
          ...prev,
          mapVisibilityMode: next.mode,
          visibleFolderIds: [...next.visibleFolderIds],
        };
      });
    },
    [update],
  );

  const showEverything = useCallback(() => {
    update((prev) => ({ ...prev, mapVisibilityMode: 'type' }));
  }, [update]);

  // -------------------------------------------------------------- import ---
  const importFiles = useCallback(
    async (files: readonly File[]): Promise<string> => {
      const added: WebTrack[] = [];
      const failed: string[] = [];
      const base = index.tracks.length;

      for (const file of files) {
        try {
          const xml = await file.text();
          const { track } = importGpxText(xml, file.name.replace(/\.gpx$/i, ''), Date.now(), {
            color: TRACK_PALETTE[(base + added.length) % TRACK_PALETTE.length]!,
          });
          await idb.put(GPX_STORE, track.id, xml).catch(() => undefined);
          added.push(track);
        } catch {
          failed.push(file.name);
        }
      }

      if (added.length === 0) return `Could not read ${failed.join(', ') || 'that file'}`;
      update((prev) => ({ ...prev, tracks: [...added, ...prev.tracks] }));
      const noun = added.length === 1 ? 'trail' : 'trails';
      const tail = failed.length > 0 ? ` · ${failed.length} failed` : '';
      return `Imported ${added.length} ${noun}${tail}`;
    },
    [index.tracks.length, update],
  );

  const loadPoints = useCallback(async (id: string): Promise<TrackPoint[]> => {
    const hit = pointCache.current.get(id);
    if (hit !== undefined) return hit;
    const xml = await idb.get<string>(GPX_STORE, id);
    if (xml === undefined) return [];
    const points = parseGpx(xml).points;
    pointCache.current.set(id, points);
    return points;
  }, []);

  // ---------------------------------------------------------------- trim ---
  const applyTrim = useCallback(
    async (
      id: string,
      points: readonly TrackPoint[],
      mode: 'overwrite' | 'copy',
    ): Promise<string> => {
      const source = index.tracks.find((t) => t.id === id);
      if (source === undefined) return 'Trail is gone';
      const xml = await idb.get<string>(GPX_STORE, id);
      if (xml === undefined) return 'Trail file is gone';

      // Round-trip through GPX text on both paths, so the trimmed trail is
      // stored exactly as an imported one would be.
      const { buildGpx } = await import('@core/geo/gpx');
      const body = buildGpx({
        points: [...points],
        metadata: { name: mode === 'copy' ? `${source.name} (trimmed)` : source.name },
      });

      if (mode === 'copy') {
        const { track } = importGpxText(body, `${source.name} (trimmed)`, Date.now(), {
          name: `${source.name} (trimmed)`,
          color: source.color,
          ...(source.category === undefined ? {} : { category: source.category }),
          ...(source.folderId === undefined ? {} : { folderId: source.folderId }),
        });
        await idb.put(GPX_STORE, track.id, body).catch(() => undefined);
        update((prev) => ({ ...prev, tracks: [track, ...prev.tracks] }));
        return `Saved "${track.name}" to the library`;
      }

      const { track } = importGpxText(body, source.name, source.startedAt, {
        id,
        name: source.name,
        color: source.color,
        ...(source.category === undefined ? {} : { category: source.category }),
        ...(source.folderId === undefined ? {} : { folderId: source.folderId }),
      });
      await idb.put(GPX_STORE, id, body).catch(() => undefined);
      pointCache.current.set(id, [...points]);
      update((prev) => ({
        ...prev,
        tracks: prev.tracks.map((t) => (t.id === id ? track : t)),
      }));
      return `Trimmed "${source.name}"`;
    },
    [index.tracks, update],
  );

  return useMemo(
    () => ({
      index,
      ready,
      seeding,
      addFolder,
      renameFolder,
      removeFolder,
      setItemFolder,
      setTrackCategory,
      renameTrack,
      removeTrack,
      removeWaypoint,
      showFolder,
      showEverything,
      importFiles,
      loadPoints,
      applyTrim,
      reseed,
    }),
    [
      index,
      ready,
      seeding,
      addFolder,
      renameFolder,
      removeFolder,
      setItemFolder,
      setTrackCategory,
      renameTrack,
      removeTrack,
      removeWaypoint,
      showFolder,
      showEverything,
      importFiles,
      loadPoints,
      applyTrim,
      reseed,
    ],
  );
}

/** Drop `folderId` rather than setting it to undefined — the persisted index
 *  must not grow `"folderId": null` entries that `groupByFolder` then has to
 *  guard against. */
function stripFolder<T extends { folderId?: string }>(item: T): T {
  const { folderId: _drop, ...rest } = item;
  return rest as T;
}

/** Re-exported so callers do not reach past this module for the selection set. */
export { toggleId };
