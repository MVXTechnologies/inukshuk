import type { ElevationRange } from '@core/map/slopeSettings';
import { create } from 'zustand';

/**
 * What the 2D slope job last measured about the area it computed (#723):
 * its lowest and highest ground, which sizes the Slope sub-panel's altitude
 * scale. Kept when the layer goes off (the scale stays put); null until the
 * first compute. Not persisted.
 */
interface TerrainAreaState {
  elevationRange: ElevationRange | null;
  setElevationRange: (range: ElevationRange) => void;
}

export const useTerrainAreaStore = create<TerrainAreaState>((set, get) => ({
  elevationRange: null,
  setElevationRange: (range) => {
    const cur = get().elevationRange;
    if (cur !== null && cur.minM === range.minM && cur.maxM === range.maxM) return;
    set({ elevationRange: range });
  },
}));
