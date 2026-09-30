import { create } from 'zustand';

/**
 * The coffee mascot's session state (#476, round 4), shared by the tip button
 * (which decides when a bubble is due and animates the face) and the bubble
 * layer (which the Map renders at its root, so the bubble can be tapped on
 * Android — a touchable that overflows its parent there gets no touches).
 *
 * In memory only: "(x) snoozes for the rest of the session" means until the
 * app process ends.
 */
interface TipMascotState {
  /** The fact on screen, or null when no bubble is up. */
  bubbleFact: number | null;
  /** The last fact shown (never repeated back to back). */
  lastFact: number | null;
  /** When the last bubble appeared (epoch ms), for the once-a-minute rule. */
  lastBubbleAt: number | null;
  /** (x) was pressed: no more bubbles this session. */
  snoozed: boolean;
  show: (fact: number, now: number) => void;
  hide: () => void;
  snooze: () => void;
}

export const useTipMascotStore = create<TipMascotState>((set) => ({
  bubbleFact: null,
  lastFact: null,
  lastBubbleAt: null,
  snoozed: false,
  show: (fact, now) => set({ bubbleFact: fact, lastFact: fact, lastBubbleAt: now }),
  hide: () => set({ bubbleFact: null }),
  snooze: () => set({ bubbleFact: null, snoozed: true }),
}));
