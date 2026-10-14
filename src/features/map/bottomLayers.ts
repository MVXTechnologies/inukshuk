import type { ViewStyle } from 'react-native';

/**
 * Stacking order of the map screen's bottom-edge layers (#505).
 *
 * The waypoint card used to be a bare sibling with no zIndex, so the
 * recording panel's dock (zIndex 6) drew — and caught touches — over it while
 * a recording was running. Both docks are elevation-free wrappers, so zIndex
 * alone decides their order on both platforms (Android sorts siblings by
 * elevation before zIndex; neither dock may gain one without the other).
 */
export const BOTTOM_LAYER = {
  /** The recording panel's dock. */
  recordingPanel: { zIndex: 6 },
  /** A tapped waypoint's card: always above the recording panel. */
  waypointCard: { zIndex: 7 },
  /** Snackbars: confirmations ("Waypoint deleted") must never hide under a dock. */
  snackbar: { zIndex: 8 },
} as const;

/** Gap between a floating waypoint card and the recording panel under it. */
export const FLOATING_CARD_GAP = 8;

/**
 * Where the waypoint card docks. Normally flush with the bottom edge; while
 * the recording panel is up it floats just above the panel (which keeps its
 * live stats and Stop in view) and on top of it in the stacking order, so
 * even a panel that grows under it can never cover the card.
 */
export function waypointCardDockStyle(recordingPanelUp: boolean, panelHeight: number): ViewStyle {
  const base: ViewStyle = {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    ...BOTTOM_LAYER.waypointCard,
  };
  if (!recordingPanelUp) return base;
  return {
    ...base,
    left: FLOATING_CARD_GAP,
    right: FLOATING_CARD_GAP,
    bottom: panelHeight + FLOATING_CARD_GAP,
  };
}

/**
 * The map screen's snackbars: above every bottom dock, and lifted over the
 * recording panel while it is up — they used to render under it, so the
 * "Waypoint dropped" / "Waypoint deleted" feedback never showed mid-recording.
 */
export function snackbarWrapperStyle(recordingPanelUp: boolean, panelHeight: number): ViewStyle {
  return {
    ...BOTTOM_LAYER.snackbar,
    ...(recordingPanelUp ? { bottom: panelHeight } : {}),
  };
}

/**
 * A long-lived snackbar (the 8 s EDIT / UNDO bar, #671/#676) sits ABOVE the
 * map's bottom column — the coordinates chip, the scale row and the
 * navigation compass — rather than on it: over them for 8 s it blocked the
 * very controls the user reaches for next. `columnBottom` is where the column
 * sits (above the recording panel, a trail sheet or the drawing panel) and
 * `columnHeight` its measured height (null before its first layout: the bar
 * then just clears whatever the column sits on).
 */
export function liftedSnackbarStyle(columnBottom: number, columnHeight: number | null): ViewStyle {
  return { ...BOTTOM_LAYER.snackbar, bottom: columnBottom + (columnHeight ?? 0) };
}

/**
 * How far above the bottom column's bottom edge the ⓘ + scale row's TOP is,
 * from the two measured layouts: the column's height and the row's y inside
 * it. The tip bubble and the credits sheet sit this high (plus a gap), so
 * they clear the row whatever is under it — nothing (the row at the bottom),
 * or the navigation compass tape, which goes BELOW the row while it shows
 * (owner, 2026-10-13, #672).
 */
export function rowLiftAboveColumnBottom(columnHeight: number, rowY: number): number {
  return Math.max(0, columnHeight - rowY);
}
