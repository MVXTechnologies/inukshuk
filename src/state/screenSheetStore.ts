import { create } from 'zustand';

interface ScreenSheetState {
  /** Sheets up on the FOCUSED screen right now (a count: sheets can nest). */
  open: number;
  opened: () => void;
  closed: () => void;
}

/**
 * Whether a bottom sheet owns the focused tab screen (the waypoint editor,
 * #675). Such a sheet is a plain View inside its screen, not a Modal, so the
 * tab bar stays live under it unless the tabs layout hides it — and tab
 * screens stay mounted, so leaving with the sheet open would strand it on a
 * hidden screen. The tabs layout hides the bar while this is non-zero, the
 * way it does for Move mode (`waypointMoveStore`).
 *
 * Fed only by `useScreenSheet`, which counts a sheet only while its screen is
 * focused.
 */
export const useScreenSheetStore = create<ScreenSheetState>((set) => ({
  open: 0,
  opened: () => set((s) => ({ open: s.open + 1 })),
  closed: () => set((s) => ({ open: Math.max(0, s.open - 1) })),
}));
