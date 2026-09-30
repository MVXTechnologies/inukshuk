import type { ExploreFilter } from '@core/catalog/exploreFacets';
import { create } from 'zustand';

/**
 * The explorer's list ↔ map filter hand-back (#474). A filtered list pushes
 * its map view on top of itself (so the map's back arrow returns to it); a
 * filter changed on the map must then be the list's filter when the user
 * comes back — whichever way they come back (the arrow, Android's back, the
 * list toggle). The map publishes its filter here while it is open over a
 * list; the list below adopts it and clears it.
 *
 * Deliberately one slot: there is at most one list under one map.
 */
interface ExploreHandoffState {
  /** The filter the map last showed, for the list it was opened from. */
  listFilter: ExploreFilter | null;
  handBack: (filter: ExploreFilter) => void;
  clear: () => void;
}

export const useExploreHandoffStore = create<ExploreHandoffState>((set) => ({
  listFilter: null,
  handBack: (filter) => set({ listFilter: filter }),
  clear: () => set({ listFilter: null }),
}));
