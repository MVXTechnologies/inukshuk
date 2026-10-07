import { create } from 'zustand';
import type { GeodeticCoverage } from '@core/geodetic/coverage';

/**
 * Transient state of the geodetic-points extension: the archive's coverage
 * (from its TileJSON), read by its Settings body and the filter panel. Its
 * companion packs' progress is the extensions' (`extensionSyncStore`); the
 * persisted switches live in `settingsStore` (`extensions.geodetic`).
 */
interface GeodeticState {
  coverage: GeodeticCoverage | null;
  patch: (p: Partial<Omit<GeodeticState, 'patch'>>) => void;
}

export const useGeodeticStore = create<GeodeticState>((set) => ({
  coverage: null,
  patch: (p) => set(p),
}));
