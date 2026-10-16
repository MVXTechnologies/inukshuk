import { create } from 'zustand';

/**
 * The native 3D terrain's view tag while it draws (null in 2D), set by the
 * main map (#735). The map's line overlays read it to hand their lines to
 * the 3D scene, and the taps and pens to land on the relief. Transient.
 */
interface TerrainViewState {
  viewTag: number | null;
  setViewTag: (viewTag: number | null) => void;
}

export const useTerrainViewStore = create<TerrainViewState>((set) => ({
  viewTag: null,
  setViewTag: (viewTag) => set({ viewTag }),
}));
