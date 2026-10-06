import type { LatLng } from '@core/models';
import { create } from 'zustand';

/**
 * "Show on map" from a screen above the map (Convert): one pending point the
 * map consumes when it is next in front — it plants the destination pin and
 * flies there (#97's flow), then clears the slot. One slot on purpose.
 */
interface MapAimState {
  pending: LatLng | null;
  request: (at: LatLng) => void;
  take: () => LatLng | null;
}

export const useMapAimStore = create<MapAimState>((set, get) => ({
  pending: null,
  request: (at) => set({ pending: at }),
  take: () => {
    const at = get().pending;
    if (at) set({ pending: null });
    return at;
  },
}));
