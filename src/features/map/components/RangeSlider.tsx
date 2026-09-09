import { useEffect, useRef, useState } from 'react';
import { PanResponder, StyleSheet, View, type AccessibilityActionEvent } from 'react-native';
import { Text, useTheme } from 'react-native-paper';

const A11Y_ACTIONS = [{ name: 'increment' }, { name: 'decrement' }];

interface Props {
  /** Slider bounds (inclusive), stepped to whole units. */
  min: number;
  max: number;
  lo: number;
  hi: number;
  /** Committed on finger lift (not per-move — the store persists each set). */
  onChange: (lo: number, hi: number) => void;
  /** Track width in dp. */
  width?: number;
  unit?: string;
  disabled?: boolean;
  /**
   * What the window is a range OF ("Slope"); each thumb announces as
   * "<label> minimum" / "<label> maximum". Defaults to plain Minimum/Maximum.
   */
  accessibilityLabel?: string;
  /** Fill/thumb/value colour override (defaults to the theme primary) — for
   * hosts with fixed dark chrome, e.g. the overlays drill-down panel. */
  accentColor?: string;
  /** Track colour override (defaults to the theme surfaceVariant). */
  trackColor?: string;
}

/**
 * A two-thumb range slider (1-unit granularity) for the slope window. Thumbs
 * pan with claim-at-touch-down responders (same ScrollView-beating recipe as
 * the Library drag); values render live from local state and commit to the
 * caller on release, so the settings store isn't persisted per-move.
 *
 * Accessibility (#308): each thumb is its own "adjustable" element with a
 * value and bounds; VoiceOver/TalkBack increment/decrement moves it one unit
 * (clamped to the other thumb and the range) and commits at once.
 */
export function RangeSlider({
  min,
  max,
  lo,
  hi,
  onChange,
  width = 190,
  unit = '°',
  disabled,
  accessibilityLabel,
  accentColor,
  trackColor,
}: Props) {
  const theme = useTheme();
  const accent = accentColor ?? theme.colors.primary;
  const track = trackColor ?? theme.colors.surfaceVariant;
  // Live values during a drag; null = idle (render the committed props).
  const [live, setLive] = useState<{ lo: number; hi: number } | null>(null);
  const liveRef = useRef<{ lo: number; hi: number } | null>(null);
  const startRef = useRef(0);

  const shownLo = live?.lo ?? lo;
  const shownHi = live?.hi ?? hi;
  const span = max - min || 1;
  const xOf = (v: number) => ((v - min) / span) * width;

  const propsRef = useRef({ min, max, lo, hi, width, disabled, onChange });
  useEffect(() => {
    propsRef.current = { min, max, lo, hi, width, disabled, onChange };
  });

  // The initializer only CAPTURES the stable ref objects; every `.current`
  // access happens inside responder callbacks (never during render). Same
  // pattern as useDragToFolder.
  // eslint-disable-next-line react-hooks/refs
  const [thumbs] = useState(() => {
    const makeThumb = (which: 'lo' | 'hi') =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !propsRef.current.disabled,
        onMoveShouldSetPanResponder: () => !propsRef.current.disabled,
        onPanResponderTerminationRequest: () => false,
        onShouldBlockNativeResponder: () => true,
        onPanResponderGrant: () => {
          const p = propsRef.current;
          const cur = liveRef.current ?? { lo: p.lo, hi: p.hi };
          startRef.current = which === 'lo' ? cur.lo : cur.hi;
          liveRef.current = cur;
          setLive(cur);
        },
        onPanResponderMove: (_e, g) => {
          const p = propsRef.current;
          const pSpan = p.max - p.min || 1;
          const delta = Math.round((g.dx / p.width) * pSpan);
          const cur = liveRef.current ?? { lo: p.lo, hi: p.hi };
          const next =
            which === 'lo'
              ? { lo: Math.max(p.min, Math.min(cur.hi - 1, startRef.current + delta)), hi: cur.hi }
              : { lo: cur.lo, hi: Math.min(p.max, Math.max(cur.lo + 1, startRef.current + delta)) };
          if (next.lo !== cur.lo || next.hi !== cur.hi) {
            liveRef.current = next;
            setLive(next);
          }
        },
        onPanResponderRelease: () => {
          const v = liveRef.current;
          liveRef.current = null;
          setLive(null);
          if (v) propsRef.current.onChange(v.lo, v.hi);
        },
        onPanResponderTerminate: () => {
          liveRef.current = null;
          setLive(null);
        },
      });
    return { lo: makeThumb('lo').panHandlers, hi: makeThumb('hi').panHandlers };
  });

  const a11yAdjust = (which: 'lo' | 'hi', e: AccessibilityActionEvent) => {
    const action = e.nativeEvent.actionName;
    if (disabled || (action !== 'increment' && action !== 'decrement')) return;
    const delta = action === 'increment' ? 1 : -1;
    if (which === 'lo') {
      const next = Math.max(min, Math.min(shownHi - 1, shownLo + delta));
      if (next !== shownLo) onChange(next, shownHi);
    } else {
      const next = Math.min(max, Math.max(shownLo + 1, shownHi + delta));
      if (next !== shownHi) onChange(shownLo, next);
    }
  };
  const thumbLabel = (end: 'minimum' | 'maximum') =>
    accessibilityLabel === undefined
      ? end === 'minimum'
        ? 'Minimum'
        : 'Maximum'
      : `${accessibilityLabel} ${end}`;

  const dim = disabled ? 0.35 : 1;
  return (
    <View style={[styles.row, { opacity: dim }]} pointerEvents={disabled ? 'none' : 'auto'}>
      <View style={[styles.trackBox, { width }]}>
        <View style={[styles.track, { backgroundColor: track }]} />
        <View
          style={[
            styles.fill,
            {
              left: xOf(shownLo),
              width: xOf(shownHi) - xOf(shownLo),
              backgroundColor: accent,
            },
          ]}
        />
        <View
          {...thumbs.lo}
          hitSlop={{ top: 18, bottom: 18, left: 14, right: 8 }}
          style={[styles.thumb, { left: xOf(shownLo) - 10, backgroundColor: accent }]}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={thumbLabel('minimum')}
          accessibilityValue={{ min, max: shownHi - 1, now: shownLo, text: `${shownLo}${unit}` }}
          accessibilityActions={A11Y_ACTIONS}
          onAccessibilityAction={(e) => a11yAdjust('lo', e)}
          accessibilityState={{ disabled: disabled === true }}
        />
        <View
          {...thumbs.hi}
          hitSlop={{ top: 18, bottom: 18, left: 8, right: 14 }}
          style={[styles.thumb, { left: xOf(shownHi) - 10, backgroundColor: accent }]}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={thumbLabel('maximum')}
          accessibilityValue={{ min: shownLo + 1, max, now: shownHi, text: `${shownHi}${unit}` }}
          accessibilityActions={A11Y_ACTIONS}
          onAccessibilityAction={(e) => a11yAdjust('hi', e)}
          accessibilityState={{ disabled: disabled === true }}
        />
      </View>
      <Text variant="labelMedium" style={[styles.value, { color: accent }]}>
        {shownLo}–{shownHi}
        {unit}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  trackBox: { height: 36, justifyContent: 'center' },
  track: { position: 'absolute', left: 0, right: 0, height: 3, borderRadius: 1.5 },
  fill: { position: 'absolute', height: 3, borderRadius: 1.5, opacity: 0.6 },
  thumb: {
    position: 'absolute',
    top: 8,
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: '#ffffff',
    elevation: 3,
    shadowOpacity: 0.25,
    shadowRadius: 3,
  },
  value: { minWidth: 56, textAlign: 'right' },
});
