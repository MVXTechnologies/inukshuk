import { create } from 'zustand';

/**
 * A one-shot "fly the main map here" request from the team screens (a task's
 * locate button, a pin notification). MapScreen takes it and moves its camera.
 */
interface TeamMapFocus {
  target: { lng: number; lat: number; zoom: number } | null;
  focus: (lng: number, lat: number, zoom?: number) => void;
  take: () => { lng: number; lat: number; zoom: number } | null;
}

export const useTeamMapFocus = create<TeamMapFocus>((set, get) => ({
  target: null,
  focus: (lng, lat, zoom = 15) => set({ target: { lng, lat, zoom } }),
  take: () => {
    const t = get().target;
    if (t) set({ target: null });
    return t;
  },
}));
