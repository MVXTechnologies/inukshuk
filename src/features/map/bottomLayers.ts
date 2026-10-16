import { MAP_STACK_GAP } from '@core/map/mapChrome';
import type { ViewStyle } from 'react-native';

import { MAP_OVERLAY_Z } from './overlayOrder';

/**
 * Stacking order of the map screen's bottom-edge layers (#505), from the
 * map's one overlay order (`MAP_OVERLAY_Z`, `overlayOrder.ts`).
 *
 * The waypoint card used to be a bare sibling with no zIndex, so the
 * recording panel's dock (zIndex 6) drew — and caught touches — over it while
 * a recording was running. Both docks are elevation-free wrappers, so zIndex
 * alone decides their order on both platforms (Android sorts siblings by
 * elevation before zIndex; neither dock may gain one without the other).
 */
export const BOTTOM_LAYER = {
  /** The recording panel's dock. */
  recordingPanel: { zIndex: MAP_OVERLAY_Z.recordingPanel },
  /** A tapped waypoint's card: always above the recording panel. */
  waypointCard: { zIndex: MAP_OVERLAY_Z.waypointCard },
  /** Snackbars: confirmations ("Waypoint deleted") must never hide under a dock. */
  snackbar: { zIndex: MAP_OVERLAY_Z.snackbar },
  /**
   * Team drawing mode (#683): its canvas and bars own the screen, above the
   * recording panel and the map's snackbars (its own snackbar is inside it).
   */
  drawMode: { zIndex: MAP_OVERLAY_Z.drawingMode },
  /** A sheet opened from drawing mode (the map credits): over it. */
  overDrawMode: { zIndex: MAP_OVERLAY_Z.overDrawMode },
} as const;

/** Gap between a floating waypoint card and the recording panel under it. */
export const FLOATING_CARD_GAP = 8;

/**
 * Where the bottom cards dock (a waypoint's card, a cluster's list, a team
 * point's card, a photo's card, an extension's card). Normally flush with the
 * bottom edge; while the recording panel is up it floats just above the
 * panel (which keeps its live stats and Stop in view) and on top of it in the
 * stacking order, so even a panel that grows under it can never cover the
 * card.
 *
 * A bottom-docked info strip (#673) sits on the tab bar or on the panel, and
 * the cards sit on the strip (`stripLift`, its measured lift, 0 when it is
 * hidden or at the top), as the bottom column does: a card never half-covers
 * the strip, and the strip never shows under a card.
 */
export function waypointCardDockStyle(
  recordingPanelUp: boolean,
  panelHeight: number,
  stripLift = 0,
): ViewStyle {
  const base: ViewStyle = {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: stripLift,
    ...BOTTOM_LAYER.waypointCard,
  };
  if (!recordingPanelUp) return base;
  return {
    ...base,
    left: FLOATING_CARD_GAP,
    right: FLOATING_CARD_GAP,
    bottom: panelHeight + stripLift + FLOATING_CARD_GAP,
  };
}

/**
 * The map screen's snackbars: above every bottom dock, and lifted over the
 * recording panel while it is up — they used to render under it, so the
 * "Waypoint dropped" / "Waypoint deleted" feedback never showed mid-recording.
 * Likewise over the drawing panel (`drawPanelHeight`): "Tap ✕ again to
 * discard this drawing" sat on the panel's own buttons (QA 2.6.1).
 */
export function snackbarWrapperStyle(
  recordingPanelUp: boolean,
  panelHeight: number,
  drawPanelHeight = 0,
): ViewStyle {
  return {
    ...BOTTOM_LAYER.snackbar,
    ...(drawPanelHeight > 0
      ? { bottom: drawPanelHeight }
      : recordingPanelUp
        ? { bottom: panelHeight }
        : {}),
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

/**
 * Gap between the team SOS button's bottom edge (#707; once the team button)
 * and the top of the bottom column: the rail's own button gap (#756), so the
 * SOS reads as one more button of the rail's column.
 */
export const TEAM_FAB_GAP = MAP_STACK_GAP;

/**
 * Where the team SOS button sits: just above the whole bottom column (the
 * coordinates chip, the scale row and, while navigating or following, the
 * compass tape), not at a fixed 72 dp, which put it on the chip's right end
 * once the tape pushed the row up (2.5.2 QA). Before the column's first
 * layout, as before: 56 dp of column.
 */
export function teamFabBottom(columnBottom: number, columnHeight: number | null): number {
  return columnBottom + (columnHeight ?? 56) + TEAM_FAB_GAP;
}
