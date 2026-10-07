import { create } from 'zustand';
import type { ExtensionKey } from '@core/extensions/keys';
import type { CompanionPack } from '@data/offline';

/**
 * Transient state of an extension's companion packs (`@features/extensions`
 * companions): the packs that carry its tiles for regions downloaded before
 * the install, whether they are being built, and the last failure. Read by
 * its Settings body.
 */
export interface CompanionSyncState {
  companions: CompanionPack[];
  /** Companion packs being downloaded: done / total regions. */
  syncing: { done: number; total: number } | null;
  error: string | null;
}

export const EMPTY_COMPANION_SYNC: CompanionSyncState = {
  companions: [],
  syncing: null,
  error: null,
};

interface ExtensionSyncState {
  byKey: Partial<Record<ExtensionKey, CompanionSyncState>>;
  patch: (key: ExtensionKey, p: Partial<CompanionSyncState>) => void;
}

export const useExtensionSyncStore = create<ExtensionSyncState>((set) => ({
  byKey: {},
  patch: (key, p) =>
    set((s) => ({
      byKey: { ...s.byKey, [key]: { ...(s.byKey[key] ?? EMPTY_COMPANION_SYNC), ...p } },
    })),
}));

/** One extension's companion-pack state (a stable empty one before any). */
export function useCompanionSync(key: ExtensionKey): CompanionSyncState {
  return useExtensionSyncStore((s) => s.byKey[key] ?? EMPTY_COMPANION_SYNC);
}
