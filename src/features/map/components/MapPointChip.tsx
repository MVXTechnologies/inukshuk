import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';

import { weatherChrome as wc } from '../weather/weatherChrome';

/**
 * The one tap-anywhere readout surface on the map (marine wave D §D1/D-5):
 * the compact dark Windy-style chip wave A introduced for weather point
 * values, generalized so weather, marine depth and bare coordinates all
 * land in the SAME chip instead of three competing cards. With both weather
 * and marine active the chip simply stacks both lines.
 *
 * Rendered inside a MapLibre <Marker anchor="bottom">: chip above a pointer
 * tail above a small anchor dot. pointerEvents none — taps fall through to
 * the map, where MapScreen's onMapPress hit-tests the chip (Marker onPress
 * doesn't fire on Android — the waypoint-pin precedent). Fixed dark weather
 * chrome in both themes, plain Views only.
 *
 * "Plain Views only" is load-bearing, not stylistic: on the iOS simulator a
 * `Pressable` (or a Paper `Icon`) in this subtree makes the whole marker fail
 * to draw — the chip simply never appears. That is the rendering half of the
 * same lesson Trail2DView records for touches ("a Pressable child proved
 * unreliable across devices"). So the action row's buttons are plain Views
 * carrying raw RESPONDER props, which is enough to take a tap on iOS.
 *
 * Android rasterizes marker children, so a responder there may never fire —
 * the row's rectangles are therefore ALSO published as
 * {@link MAP_POINT_ACTION_LAYOUT} and hit-tested at the map level
 * ({@link runMapPointChipAction}), the waypoint-pin idiom. The two paths are
 * complementary, not redundant, and `onClaimTouch` keeps the map's own press
 * from undoing an action the responder already took.
 *
 * Each line owns its own data hook (see WeatherPointLine / DepthPointLine),
 * so a line that has nothing to say costs nothing and never blocks the rest.
 *
 * #232 gives the chip an ACTION ROW: the tapped point is the hub for the two
 * things you can do with a coordinate — navigate to it, or keep it. They live
 * in the chip rather than in a second popup or in permanent map chrome, so
 * they appear and disappear with the tap that summoned them.
 */
export function MapPointChip({
  children,
  accessibilityLabel,
  actions,
}: {
  children: ReactNode;
  accessibilityLabel: string;
  /** #232 — omit for a read-only chip (no action row is rendered at all). */
  actions?: MapPointChipActions;
}) {
  return (
    <View
      style={styles.wrap}
      // box-none so the action row can take a touch while every readout line
      // still lets the tap fall through to the map.
      pointerEvents={actions ? 'box-none' : 'none'}
      accessibilityLabel={accessibilityLabel}
    >
      <View style={styles.chip} pointerEvents={actions ? 'box-none' : 'none'}>
        <View pointerEvents="none">{children}</View>
        {actions && <MapPointChipActionRow {...actions} />}
      </View>
      <View style={styles.tail} />
      <View style={styles.dot} />
    </View>
  );
}

/** One readout line inside {@link MapPointChip}. */
export function MapPointLine({ text, muted = false }: { text: string; muted?: boolean }) {
  return (
    <Text style={[styles.chipText, muted && styles.chipTextMuted]} numberOfLines={1}>
      {text}
    </Text>
  );
}

export interface MapPointChipActions {
  /** Open the coordinates dialog prefilled with the tapped point. */
  onNavigate: () => void;
  /** Open the waypoint editor on the tapped point. */
  onAddWaypoint: () => void;
  /**
   * Fired the instant the row TAKES a touch, before the press itself. On iOS
   * MapLibre's own tap recognizer fires for the same tap even though the row
   * claimed it as a responder — and the map's chip hit-test would dismiss the
   * chip out from under the action the user just triggered. The caller uses
   * this to ignore that press (see MapScreen's onMapPress).
   */
  onClaimTouch?: () => void;
}

/** The two point actions the chip offers, stable a11y strings (#232). */
export const MAP_POINT_ACTION_LABELS = {
  navigate: 'Navigate to coordinates',
  waypoint: 'Add waypoint here',
} as const;

/**
 * Fixed layout of the action row, in px — fixed because the MAP also
 * hit-tests it (see the component note above). The buttons' drawn rectangles
 * and the hit rectangles have to be the same rectangles, so both read here.
 */
export const MAP_POINT_ACTION_LAYOUT = {
  buttonWidth: 104,
  buttonHeight: 28,
  gap: 6,
  /**
   * Gap between the tapped coordinate and the BOTTOM of the action row:
   * the marker is bottom-anchored, so below the chip sit the anchor dot
   * (7 + 2 margin) and the tail (8 − 5 margin) = 12 px, plus the chip's own
   * 5 px vertical padding.
   */
  bottomOffset: 17,
} as const;

/**
 * Which action a tap at (`dx`, `dy`) px from the tapped coordinate hits —
 * screen pixels, y growing downward, so the chip sits at negative `dy`.
 * `null` when the tap is anywhere else (the caller then falls through to its
 * own dismiss/copy hit-test).
 */
export function hitMapPointChipAction(dx: number, dy: number): 'navigate' | 'waypoint' | null {
  const { buttonWidth, buttonHeight, gap, bottomOffset } = MAP_POINT_ACTION_LAYOUT;
  if (dy > -bottomOffset || dy < -(bottomOffset + buttonHeight)) return null;
  const half = gap / 2;
  if (dx <= -half && dx >= -(half + buttonWidth)) return 'navigate';
  if (dx >= half && dx <= half + buttonWidth) return 'waypoint';
  return null;
}

/**
 * Run the action a map tap at (`dx`, `dy`) from the tapped coordinate lands
 * on, and report whether the row claimed the tap — the map-level half of the
 * row's press handling, for the platforms where the responder above never
 * sees the touch.
 */
export function runMapPointChipAction(
  actions: MapPointChipActions,
  dx: number,
  dy: number,
): boolean {
  const hit = hitMapPointChipAction(dx, dy);
  if (hit === 'navigate') {
    actions.onNavigate();
    return true;
  }
  if (hit === 'waypoint') {
    actions.onAddWaypoint();
    return true;
  }
  return false;
}

function MapPointChipActionRow({ onNavigate, onAddWaypoint, onClaimTouch }: MapPointChipActions) {
  return (
    <View style={styles.actions} pointerEvents="box-none">
      <ActionButton
        text="Navigate"
        accessibilityLabel={MAP_POINT_ACTION_LABELS.navigate}
        onPress={onNavigate}
        onClaimTouch={onClaimTouch}
      />
      <ActionButton
        text="Waypoint"
        accessibilityLabel={MAP_POINT_ACTION_LABELS.waypoint}
        onPress={onAddWaypoint}
        onClaimTouch={onClaimTouch}
      />
    </View>
  );
}

/**
 * Raw responder props on a plain View, deliberately NOT a Pressable/Touchable:
 * inside a MapLibre marker a Pressable makes the whole marker fail to draw on
 * iOS (see the component note). Responder props add no component and no view —
 * they are the lightest possible way to claim a touch.
 */
function ActionButton({
  text,
  accessibilityLabel,
  onPress,
  onClaimTouch,
}: {
  text: string;
  accessibilityLabel: string;
  onPress: () => void;
  onClaimTouch?: (() => void) | undefined;
}) {
  return (
    <View
      style={styles.action}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onStartShouldSetResponder={() => {
        onClaimTouch?.();
        return true;
      }}
      onResponderRelease={onPress}
    >
      <Text style={styles.actionText} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center' },
  chip: {
    backgroundColor: wc.panel,
    borderRadius: 13,
    paddingHorizontal: 10,
    paddingVertical: 5,
    maxWidth: 240,
    gap: 1,
  },
  chipText: {
    fontSize: 12,
    lineHeight: 15,
    fontWeight: '700',
    color: wc.ink,
    fontVariant: ['tabular-nums'],
  },
  // Secondary lines (the coordinates readout's copy hint).
  chipTextMuted: { fontWeight: '400', color: wc.inkMuted },
  // Centred so the geometry above holds even when a weather line makes the
  // chip wider than the row itself.
  actions: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignSelf: 'stretch',
    gap: MAP_POINT_ACTION_LAYOUT.gap,
    marginTop: 4,
  },
  action: {
    width: MAP_POINT_ACTION_LAYOUT.buttonWidth,
    height: MAP_POINT_ACTION_LAYOUT.buttonHeight,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 9,
    // A lift off the slab rather than another slab colour: wc.panelSolid is
    // indistinguishable from wc.panel at this size.
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: wc.hairline,
  },
  actionText: { fontSize: 12, lineHeight: 15, fontWeight: '700', color: wc.ink },
  tail: {
    width: 8,
    height: 8,
    marginTop: -5,
    borderRadius: 1.5,
    backgroundColor: wc.panel,
    transform: [{ rotate: '45deg' }],
  },
  // Small accent anchor dot sitting exactly on the tapped coordinate.
  dot: {
    width: 7,
    height: 7,
    marginTop: 2,
    borderRadius: 3.5,
    backgroundColor: wc.accent,
    borderWidth: 1.5,
    borderColor: '#FFFFFF',
  },
});
