import type { Place } from '@core/search/place';
import { pushRecent } from '@core/search/recents';
import { loadPlaceRecents, savePlaceRecents } from '@data/placeSearch';
import { create } from 'zustand';

/**
 * The last places chosen in the map's place search (#496), newest first. On
 * this device only (`place-search-recents.json`), never synced or sent.
 */
interface PlaceRecentsState {
  recents: Place[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  push: (place: Place) => void;
  clear: () => void;
}

let hydrating: Promise<void> | null = null;

export const usePlaceRecentsStore = create<PlaceRecentsState>((set, get) => ({
  recents: [],
  hydrated: false,
  hydrate: () => {
    if (get().hydrated) return Promise.resolve();
    hydrating ??= loadPlaceRecents().then((loaded) => {
      // A pick made before the file was read goes first; then what was on disk.
      const early = get().recents;
      const merged = early.reduceRight((list, p) => pushRecent(list, p), loaded);
      set({ recents: merged, hydrated: true });
      if (early.length > 0) savePlaceRecents(merged);
      hydrating = null;
    });
    return hydrating;
  },
  push: (place) => {
    const recents = pushRecent(get().recents, place);
    set({ recents });
    // Before the file is read, saving would overwrite it with this one pick;
    // hydrate() merges and saves instead.
    if (get().hydrated) savePlaceRecents(recents);
  },
  clear: () => {
    set({ recents: [] });
    savePlaceRecents([]);
  },
}));
