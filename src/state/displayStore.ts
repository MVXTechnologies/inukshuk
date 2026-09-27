import { create } from 'zustand';

/**
 * Transient display state (not persisted): when "Night on · tap to exit"
 * silenced the automatic night mode, and until when.
 */
interface DisplayState {
  autoNightDismissedUntil: number | null;
  dismissAutoNight: (until: number) => void;
}

export const useDisplayStore = create<DisplayState>((set) => ({
  autoNightDismissedUntil: null,
  dismissAutoNight: (until) => set({ autoNightDismissedUntil: until }),
}));
