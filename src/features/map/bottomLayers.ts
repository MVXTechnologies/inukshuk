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
