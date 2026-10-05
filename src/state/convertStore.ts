import { HISTORY_MAX, loadHistory, saveHistory, type HistoryEntry } from '@data/convertHistory';
import { create } from 'zustand';

/**
 * Convert's per-device state: the history list, and a counter bumped
 * whenever a grid pack is installed or removed (so the screen re-reads the
 * grids on disk and re-runs the conversion that was waiting for it).
 */
interface ConvertState {
  history: HistoryEntry[];
  hydrated: boolean;
  gridsVersion: number;
  hydrate: () => Promise<void>;
  record: (entry: HistoryEntry) => void;
  clearHistory: () => void;
  gridsChanged: () => void;
}

let hydrating: Promise<void> | null = null;

export const useConvertStore = create<ConvertState>((set, get) => ({
  history: [],
  hydrated: false,
  gridsVersion: 0,
  hydrate: () => {
    if (get().hydrated) return Promise.resolve();
    hydrating ??= loadHistory().then((loaded) => {
      const merged = [...get().history, ...loaded].slice(0, HISTORY_MAX);
      set({ history: merged, hydrated: true });
      hydrating = null;
    });
    return hydrating;
  },
  record: (entry) => {
    // One entry per conversion: the same params replace the older one.
    const key = JSON.stringify(entry.params);
    const history = [entry, ...get().history.filter((e) => JSON.stringify(e.params) !== key)].slice(
      0,
      HISTORY_MAX,
    );
    set({ history });
    if (get().hydrated) saveHistory(history);
  },
  clearHistory: () => {
    set({ history: [] });
    saveHistory([]);
  },
  gridsChanged: () => set({ gridsVersion: get().gridsVersion + 1 }),
}));
