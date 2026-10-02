import { palette } from '@ui/tokens';
import { useEffect, useRef, useState } from 'react';
import {
  PanResponder,
  StyleSheet,
  View,
  type AccessibilityActionEvent,
  type GestureResponderEvent,
} from 'react-native';
import { Text, useTheme } from 'react-native-paper';

const A11Y_ACTIONS = [{ name: 'increment' }, { name: 'decrement' }];
const THUMB = 20;

/**
 * The stop under a track position: `x` dp along a `width`-dp track with
 * `count` evenly spaced stops (first at 0, last at `width`), snapped to the
 * nearest and clamped to the ends.
 */
export function stopAt(x: number, width: number, count: number): number {
  if (count <= 1 || width <= 0 || !Number.isFinite(x)) return 0;
  const t = Math.min(1, Math.max(0, x / width));
  return Math.round(t * (count - 1));
}

interface Props {
  /** One visible label per stop, in order ("Off", "25 %", …). */
  labels: readonly string[];
  /** The selected stop's index. */
  value: number;
  /** Committed on finger lift / tap (not per-move — the store persists each set). */
  onChange: (index: number) => void;
  /** Track width in dp. */
  width?: number;
  disabled?: boolean;
  /** The slider's accessible name ("See-through white"). */
  accessibilityLabel: string;
  /** Fill/thumb/value colour override (defaults to the theme primary). */
  accentColor?: string;
  /** Track colour override (defaults to the theme surfaceVariant). */
  trackColor?: string;
  /** Stop-tick colour override (defaults to the theme outline). */
  tickColor?: string;
}

/**
 * A single-thumb slider that snaps to a few stops, in the slope RangeSlider's
 * look (3-dp track, accent fill, white-ringed 20-dp thumb, value at the end)
 * with a small tick on every stop. Touch anywhere on the track: a tap jumps
 * to the nearest stop, a drag follows the finger stop by stop; the value
 * label updates live and the choice commits on lift. Like the RangeSlider it
 * claims its touch at touch-down and refuses termination, so a drag beats the
 * menu's ScrollView.
 *
 * Accessibility: ONE "adjustable" element named by `accessibilityLabel`,
 * valued with the stop's label; increment/decrement move one stop and commit
 * at once.
 */
export function StepSlider({
  labels,
  value,
  onChange,
  width = 190,
  disabled,
  accessibilityLabel,
  accentColor,
  trackColor,
  tickColor,
}: Props) {
  const theme = useTheme();
  const accent = accentColor ?? theme.colors.primary;
  const track = trackColor ?? theme.colors.surfaceVariant;
  const tick = tickColor ?? theme.colors.outline;
  const count = labels.length;
  const last = Math.max(0, count - 1);
  // The stop under the finger during a gesture; null = idle (render `value`).
  const [live, setLive] = useState<number | null>(null);
  const liveRef = useRef<number | null>(null);
  const startXRef = useRef(0);

  const propsRef = useRef({ width, count, disabled, onChange });
  useEffect(() => {
    propsRef.current = { width, count, disabled, onChange };
  });

  // The initializer only CAPTURES the stable ref objects; every `.current`
  // access happens inside responder callbacks (never during render). Same
  // pattern as RangeSlider / useDragToFolder.
  // eslint-disable-next-line react-hooks/refs
  const [pan] = useState(() => {
    const follow = (x: number) => {
      const p = propsRef.current;
      const next = stopAt(x, p.width, p.count);
      if (next !== liveRef.current) {
        liveRef.current = next;
        setLive(next);
      }
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => !propsRef.current.disabled,
      onMoveShouldSetPanResponder: () => !propsRef.current.disabled,
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
      onPanResponderGrant: (e: GestureResponderEvent) => {
        // The track's children ignore touches, so locationX is along the track.
        startXRef.current = e.nativeEvent.locationX;
        follow(startXRef.current);
      },
      onPanResponderMove: (_e, g) => follow(startXRef.current + g.dx),
      onPanResponderRelease: () => {
        const v = liveRef.current;
        liveRef.current = null;
        setLive(null);
        if (v !== null) propsRef.current.onChange(v);
      },
      onPanResponderTerminate: () => {
        liveRef.current = null;
        setLive(null);
      },
    }).panHandlers;
  });

  const shown = Math.min(last, Math.max(0, live ?? value));
  const step = last > 0 ? width / last : 0;
  const x = shown * step;
  const label = labels[shown] ?? '';

  const onA11y = (e: AccessibilityActionEvent) => {
    const action = e.nativeEvent.actionName;
    if (disabled || (action !== 'increment' && action !== 'decrement')) return;
    const next = Math.min(last, Math.max(0, shown + (action === 'increment' ? 1 : -1)));
    if (next !== shown) onChange(next);
  };

  return (
    <View
      style={[styles.row, disabled && styles.dimmed]}
      pointerEvents={disabled ? 'none' : 'auto'}
    >
      <View
        {...pan}
        hitSlop={{ top: 10, bottom: 10, left: THUMB / 2, right: THUMB / 2 }}
        style={[styles.trackBox, { width }]}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={accessibilityLabel}
        accessibilityValue={{ min: 0, max: last, now: shown, text: label }}
        accessibilityActions={A11Y_ACTIONS}
        onAccessibilityAction={onA11y}
        accessibilityState={{ disabled: disabled === true }}
      >
        <View pointerEvents="none" style={[styles.track, { backgroundColor: track }]} />
        <View pointerEvents="none" style={[styles.fill, { width: x, backgroundColor: accent }]} />
        {labels.map((l, i) => (
          <View
            key={l}
            pointerEvents="none"
            style={[
              styles.tick,
              { left: i * step - TICK / 2, backgroundColor: i <= shown ? accent : tick },
            ]}
          />
        ))}
        <View
          pointerEvents="none"
          style={[styles.thumb, { left: x - THUMB / 2, backgroundColor: accent }]}
        />
      </View>
      <Text variant="labelMedium" style={[styles.value, { color: accent }]}>
        {label}
      </Text>
    </View>
  );
}

const TICK = 6;

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dimmed: { opacity: 0.35 },
  trackBox: { height: 36, justifyContent: 'center' },
  track: { position: 'absolute', left: 0, right: 0, height: 3, borderRadius: 1.5 },
  fill: { position: 'absolute', left: 0, height: 3, borderRadius: 1.5, opacity: 0.6 },
  tick: {
    position: 'absolute',
    top: (36 - TICK) / 2,
    width: TICK,
    height: TICK,
    borderRadius: TICK / 2,
  },
  thumb: {
    position: 'absolute',
    top: (36 - THUMB) / 2,
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    borderWidth: 2,
    borderColor: palette.white,
    elevation: 3,
    shadowOpacity: 0.25,
    shadowRadius: 3,
  },
  value: { minWidth: 56, textAlign: 'right' },
});
