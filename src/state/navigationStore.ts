import type { LatLng } from '@core/models';
import { create } from 'zustand';

/**
 * What the map is navigating to (#672 / #678): ONE target at a time, either a
 * point (the destination pin, #97) or a saved trail being followed. Starting
 * one ends the other, so the compass never has two masters.
 *
 * Session state on purpose, like the destination pin always was: a
 * navigation is a "right now" thing, not something to resume after a restart.
 * A store (not MapScreen state) because "Follow this trail" is pressed on the
 * trail view, a screen above the map.
 */
export interface FollowedTrail {
  trackId: string;
  /** The name at the time following started (the chip's text). */
  name: string;
}

interface NavigationState {
  destination: LatLng | null;
  following: FollowedTrail | null;
  /** Navigate to a point (null clears it). Stops following a trail. */
  setDestination: (at: LatLng | null) => void;
  /** Follow a saved trail. Clears the destination pin. */
  follow: (trail: FollowedTrail) => void;
  stopFollowing: () => void;
}

export const useNavigationStore = create<NavigationState>((set) => ({
  destination: null,
  following: null,
  setDestination: (at) =>
    set(at === null ? { destination: null } : { destination: at, following: null }),
  follow: (trail) => set({ following: trail, destination: null }),
  stopFollowing: () => set({ following: null }),
}));
