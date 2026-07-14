import { useMemo, useState } from 'react';
import {
  PanResponder,
  StyleSheet,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from 'react-native';
import { useTheme } from 'react-native-paper';

const THUMB = 22;
const RAIL = 4;
const HEIGHT = 44;

interface Props {
  /** Total number of track points; thumbs address indices 0..count-1. */
  count: number;
  /** Index of the first kept point. */
  start: number;
  /** Index of the last kept point (inclusive). */
  end: number;
  /** Fired continuously while dragging; always start < end. */
  onChange: (start: number, end: number) => void;
}

/**
 * Dual-thumb range slider over point indices for the trim tool. One
 * PanResponder owns the whole rail: on touch it grabs the nearest thumb and
 * drags it, clamped against the other thumb so the kept segment always spans
 * at least two points. Mirrors ElevationProfile's responder setup — the View
 * holds the responder for the whole gesture and handlers are rebound per
 * render, so reading the controlled `start`/`end` props (and the active-thumb
 * state) from the closure is safe, and a parent ScrollView can't steal the
 * gesture mid-drag.
 */
export function TrimRangeSlider({ count, start, end, onChange }: Props) {
  const theme = useTheme();
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<'start' | 'end' | null>(null);
  const last = Math.max(1, count - 1);

  const pan = useMemo(() => {
    const usable = width - THUMB;
    const idxAt = (e: GestureResponderEvent) => {
      const x = e.nativeEvent.locationX - THUMB / 2;
      const ratio = usable > 0 ? Math.max(0, Math.min(1, x / usable)) : 0;
      return Math.round(ratio * last);
    };
    const moveThumb = (which: 'start' | 'end', e: GestureResponderEvent) => {
      const idx = idxAt(e);
      if (which === 'start') {
        const next = Math.max(0, Math.min(idx, end - 1));
        if (next !== start) onChange(next, end);
      } else {
        const next = Math.min(last, Math.max(idx, start + 1));
        if (next !== end) onChange(start, next);
      }
    };
    const grab = (e: GestureResponderEvent) => {
      const idx = idxAt(e);
      // Nearest thumb wins; when equidistant, the side the touch is on wins.
      const dStart = Math.abs(idx - start);
      const dEnd = Math.abs(idx - end);
      const which =
        dStart < dEnd ? 'start' : dEnd < dStart ? 'end' : idx <= start ? 'start' : 'end';
      setActive(which);
      moveThumb(which, e);
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onStartShouldSetPanResponderCapture: () => true,
      onMoveShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponderCapture: () => true,
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
      onPanResponderGrant: grab,
      onPanResponderMove: (e) => {
        if (active) moveThumb(active, e);
      },
      onPanResponderRelease: () => setActive(null),
      onPanResponderTerminate: () => setActive(null),
    });
  }, [width, last, start, end, active, onChange]);

  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  const usable = Math.max(0, width - THUMB);
  const xFor = (idx: number) => (idx / last) * usable;
  const startX = xFor(start);
  const endX = xFor(end);

  return (
    <View
      style={styles.container}
      onLayout={onLayout}
      {...pan.panHandlers}
      accessibilityRole="adjustable"
      accessibilityLabel={`Trim range, keeping points ${start + 1} to ${end + 1} of ${count}`}
    >
      {width > 0 && (
        <View pointerEvents="none" style={styles.fill}>
          {/* Rail (cut portions) */}
          <View style={[styles.rail, { backgroundColor: theme.colors.surfaceVariant }]} />
          {/* Kept segment */}
          <View
            style={[
              styles.kept,
              {
                backgroundColor: theme.colors.primary,
                left: THUMB / 2 + startX,
                width: Math.max(0, endX - startX),
              },
            ]}
          />
          {/* Thumbs */}
          {[startX, endX].map((x, i) => (
            <View
              key={i}
              style={[
                styles.thumb,
                {
                  left: x,
                  backgroundColor: theme.colors.primary,
                  borderColor: theme.colors.onPrimary,
                },
              ]}
            />
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { height: HEIGHT, justifyContent: 'center' },
  fill: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 },
  rail: {
    position: 'absolute',
    top: (HEIGHT - RAIL) / 2,
    left: THUMB / 2,
    right: THUMB / 2,
    height: RAIL,
    borderRadius: RAIL / 2,
  },
  kept: {
    position: 'absolute',
    top: (HEIGHT - RAIL) / 2,
    height: RAIL,
    borderRadius: RAIL / 2,
  },
  thumb: {
    position: 'absolute',
    top: (HEIGHT - THUMB) / 2,
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    borderWidth: 2,
    elevation: 2,
  },
});
