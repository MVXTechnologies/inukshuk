import type { LatLng, StoredWaypointIcon, WaypointSize } from '@core/models';
import { create } from 'zustand';

/** The saved waypoint being moved (#676), as it was when Move started. */
export interface WaypointMoveTarget {
  id: string;
  label: string;
  /** Where it was: the dashed line starts here, Cancel and Undo return here. */
  from: LatLng;
  icon?: StoredWaypointIcon;
  color?: string;
  size?: WaypointSize;
}

interface WaypointMoveState {
  moving: WaypointMoveTarget | null;
  start: (target: WaypointMoveTarget) => void;
  end: () => void;
}

/**
 * Move mode (#676) as app state, not MapScreen state: the tab bar (in the
 * tabs layout) hides while it is on, and the pin layer, the dashed line and
 * the overlay all read the same target without threading props through the
 * map screen.
 */
export const useWaypointMoveStore = create<WaypointMoveState>((set) => ({
  moving: null,
  start: (target) => set({ moving: target }),
  end: () => set({ moving: null }),
}));
