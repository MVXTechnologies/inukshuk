import { create } from 'zustand';
import type { GeodeticCoverage } from '@core/geodetic/coverage';
import type { CompanionPack } from '@data/offline';

/**
 * Transient state of the geodetic-points extension's Settings screen: the
 * archive's coverage (from its TileJSON), the companion packs that carry the
 * marks for regions downloaded before the install, and whether they are being
 * built. The persisted switches live in `settingsStore`
 * (`geodeticInstalledAt`, `showGeodetic`, `geodeticOffline`).
 */
interface GeodeticState {
  coverage: GeodeticCoverage | null;
  companions: CompanionPack[];
  /** Companion packs being downloaded: done / total regions. */
  syncing: { done: number; total: number } | null;
  error: string | null;
  patch: (p: Partial<Omit<GeodeticState, 'patch'>>) => void;
}

export const useGeodeticStore = create<GeodeticState>((set) => ({
  coverage: null,
  companions: [],
  syncing: null,
  error: null,
  patch: (p) => set(p),
}));
