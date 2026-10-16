import type { OverlapHit } from '@core/map/overlapPick';
import { create } from 'zustand';

/**
 * Two or more things under one tap (#745, mockup 262 screen 7): crossing
 * trails, a trail inside an area, nested areas. The map's tap opens the
 * chooser (`OverlapChooserSheet`) instead of guessing; a row selects that
 * item. Any other tap on the map, its ✕ or Back closes it.
 */
export const useOverlapChooser = create<{
  hits: OverlapHit[] | null;
  open: (hits: OverlapHit[]) => void;
  close: () => void;
}>((set) => ({
  hits: null,
  open: (hits) => set({ hits: hits.length > 1 ? hits : null }),
  close: () => set((s) => (s.hits === null ? s : { hits: null })),
}));
