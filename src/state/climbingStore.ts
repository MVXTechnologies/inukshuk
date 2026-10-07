import { create } from 'zustand';

import type { ClimbingCoverage } from '@core/climbing/coverage';
import { CLIMBING_SCHEMA_VERSION, type SavedCrag } from '@core/climbing/saved';
import { foldForSearch } from '@core/library/searchTracks';
import { loadCragIndex, readClimbingDoc, writeClimbingDoc } from '@data/climbing';

/**
 * Saved (downloaded) crags and the extension's transient state. Persisted in
 * `climbing.json` (`@core/climbing/saved`, with its own schema version); the
 * install switches live in `settingsStore` (`climbingInstalledAt`,
 * `showClimbing`, `climbingShowAll`, `climbingGradeSystem`). The actions that
 * download, update and remove are in `@features/climbing/climbingActions`.
 */
export interface CragDownload {
  phase: 'topo' | 'map';
  /** 0–100 for the map pack; 0 while the topo is fetched. */
  pct: number;
  bytes: number;
  /** Expected size of the map pack, for "4.1 of 6.4 MB". */
  expectedBytes: number;
}

/** One crag of the world index, ready for the place search (name pre-folded). */
export interface CragSearchRow {
  uid: string;
  name: string;
  folded: string;
  lng: number;
  lat: number;
  region?: string;
}

interface ClimbingState {
  hydrated: boolean;
  saved: SavedCrag[];
  downloads: Record<string, CragDownload>;
  coverage: ClimbingCoverage | null;
  error: string | null;
  /** The world's crags for "Search places", once loaded (extension installed). */
  searchIndex: CragSearchRow[] | null;
  hydrate: () => Promise<void>;
  /** Load the world index (cached a week on the phone); no-op when loaded. */
  loadSearchIndex: () => Promise<void>;
  /** Replace or add a saved crag (persisted). */
  put: (crag: SavedCrag) => void;
  /** Drop saved crags (persisted). */
  drop: (uids: readonly string[]) => void;
  setDownload: (uid: string, d: CragDownload | null) => void;
  patch: (p: Partial<Pick<ClimbingState, 'coverage' | 'error'>>) => void;
}

let hydration: Promise<void> | null = null;
let indexLoading = false;

function persist(saved: SavedCrag[]): void {
  try {
    writeClimbingDoc({ schemaVersion: CLIMBING_SCHEMA_VERSION, saved });
  } catch {
    // Disk full: the in-memory list stays right; the next change retries.
  }
}

export const useClimbingStore = create<ClimbingState>((set, get) => ({
  hydrated: false,
  saved: [],
  downloads: {},
  coverage: null,
  error: null,
  searchIndex: null,
  loadSearchIndex: async () => {
    if (get().searchIndex !== null || indexLoading) return;
    indexLoading = true;
    try {
      const index = await loadCragIndex();
      if (index !== null) {
        set({
          searchIndex: index.rows.map((r) => ({
            uid: r.uid,
            name: r.name,
            folded: foldForSearch(r.name),
            lng: r.lng,
            lat: r.lat,
            ...(r.region !== '' ? { region: r.region } : {}),
          })),
        });
      }
    } finally {
      indexLoading = false;
    }
  },
  hydrate: () => {
    hydration ??= (async () => {
      const doc = await readClimbingDoc();
      // Anything saved before hydration finished wins for its own crag.
      const early = get().saved;
      const merged = [...doc.saved.filter((s) => !early.some((e) => e.uid === s.uid)), ...early];
      set({ saved: merged, hydrated: true });
      if (early.length > 0) persist(merged);
    })().finally(() => {
      hydration = null;
    });
    return hydration;
  },
  put: (crag) => {
    const saved = [...get().saved.filter((s) => s.uid !== crag.uid), crag];
    set({ saved });
    if (get().hydrated) persist(saved);
  },
  drop: (uids) => {
    const saved = get().saved.filter((s) => !uids.includes(s.uid));
    set({ saved });
    if (get().hydrated) persist(saved);
  },
  setDownload: (uid, d) => {
    const downloads = { ...get().downloads };
    if (d === null) delete downloads[uid];
    else downloads[uid] = d;
    set({ downloads });
  },
  patch: (p) => set(p),
}));
