import { sameIdSet } from '@core/library/onMapTrail';
import { create } from 'zustand';

import { useLibraryStore } from './libraryStore';

/**
 * The trail shown with the trail view's "On map" (#710), see
 * `@core/library/onMapTrail`. Session state, never persisted, and it never
 * writes the Library's shown set (`activeTrackIds`): closing it is how the
 * map gets that set back. A store (not MapScreen state) because "On map" is
 * pressed on the trail view, a screen above the map.
 */
interface OnMapTrailState {
  /** The trail drawn alone on the map with its chip, or null. */
  trackId: string | null;
  show: (trackId: string) => void;
  close: () => void;
}

export const useOnMapTrailStore = create<OnMapTrailState>((set) => ({
  trackId: null,
  show: (trackId) => set({ trackId }),
  close: () => set({ trackId: null }),
}));

// A deliberate change to the Library's shown set (an eye toggle, "View on
// map", deleting a shown trail, Follow adding one) takes the map back: the
// look ends. A filter that removed nothing is no change.
useLibraryStore.subscribe((s, prev) => {
  if (useOnMapTrailStore.getState().trackId === null) return;
  if (!sameIdSet(s.activeTrackIds, prev.activeTrackIds)) useOnMapTrailStore.getState().close();
});
