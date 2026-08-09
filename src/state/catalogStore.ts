import type { CatalogManifest } from '@core/catalog/schema';
import { loadCatalogManifest } from '@data/catalogCache';
import { create } from 'zustand';

/**
 * Map-store (Search tab) state: the loaded catalog manifest plus per-item
 * download progress. Lives in a store (not screen state) so an in-flight
 * download keeps its progress bar when the user hops to another tab and back.
 * The download orchestration itself is `@features/store/downloadCatalogItem`;
 * it drives `setDownloadProgress`/`clearDownload` here.
 */

export type CatalogStatus = 'idle' | 'loading' | 'ready' | 'error';

interface CatalogState {
  status: CatalogStatus;
  manifest: CatalogManifest | null;
  /** True when the manifest came from the on-device cache (offline browse). */
  fromCache: boolean;
  /** itemId → fraction 0..1, or null for indeterminate. */
  downloads: Record<string, number | null>;
  /** Destination folder of the last store download (pre-selected next time). */
  lastFolderId: string | null;
  /** Load (or refresh, with `force`) the manifest. Safe to call repeatedly. */
  load: (force?: boolean) => Promise<void>;
  setDownloadProgress: (itemId: string, fraction: number | null) => void;
  clearDownload: (itemId: string) => void;
  setLastFolderId: (folderId: string | null) => void;
}

export const useCatalogStore = create<CatalogState>((set, get) => ({
  status: 'idle',
  manifest: null,
  fromCache: false,
  downloads: {},
  lastFolderId: null,

  load: async (force) => {
    if (get().status === 'loading') return;
    set({ status: 'loading' });
    const result = await loadCatalogManifest(force === true ? { force: true } : undefined);
    if (result === null) {
      // Keep any previously loaded manifest browsable; only flag error state
      // when there is nothing at all to show.
      set((s) => ({ status: s.manifest !== null ? 'ready' : 'error' }));
      return;
    }
    set({ status: 'ready', manifest: result.manifest, fromCache: result.fromCache });
  },

  setDownloadProgress: (itemId, fraction) =>
    set((s) => ({ downloads: { ...s.downloads, [itemId]: fraction } })),

  clearDownload: (itemId) =>
    set((s) => {
      const { [itemId]: _gone, ...rest } = s.downloads;
      return { downloads: rest };
    }),

  setLastFolderId: (folderId) => set({ lastFolderId: folderId }),
}));
