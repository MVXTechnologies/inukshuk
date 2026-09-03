import { formatElevation } from '@state/formatters';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Surface, Text } from 'react-native-paper';

/**
 * Tap-to-query UI shared by the 3D terrain screens: a small chip showing the
 * elevation + slope under a tapped point (Paper Surface/Text, so it follows
 * the active theme), auto-hiding after a few seconds — in step with the
 * crosshair marker fading in the scene.
 */

export interface TapQueryInfo {
  elevM: number;
  slopeDeg: number;
}

/** How long the chip stays up; the 3D crosshair fade uses the same window. */
export const QUERY_SHOW_MS = 4000;
/** Crosshair fade: hold fully opaque, then fade to 0 over the remainder. */
export const QUERY_HOLD_MS = 3000;

/** Crosshair opacity for the time elapsed since the tap (1 → 0). */
export function queryMarkerOpacity(elapsedMs: number): number {
  if (elapsedMs <= QUERY_HOLD_MS) return 1;
  return Math.max(0, 1 - (elapsedMs - QUERY_HOLD_MS) / (QUERY_SHOW_MS - QUERY_HOLD_MS));
}

/** State + auto-hide timer for the chip. `show` is stable across renders. */
export function useTapQuery(): {
  info: TapQueryInfo | null;
  show: (info: TapQueryInfo) => void;
} {
  const [info, setInfo] = useState<TapQueryInfo | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const show = useCallback((i: TapQueryInfo) => {
    if (timer.current) clearTimeout(timer.current);
    setInfo(i);
    timer.current = setTimeout(() => setInfo(null), QUERY_SHOW_MS);
  }, []);
  return { info, show };
}

interface Props {
  info: TapQueryInfo | null;
  /** Positioning (absolute placement inside the GL box) is per-screen. */
  style?: StyleProp<ViewStyle>;
}

/** The "1 742 m · 31°" chip; renders nothing while no query is active. */
export function TapQueryChip({ info, style }: Props) {
  if (!info) return null;
  return (
    <View style={[styles.wrap, style]} pointerEvents="none">
      <Surface style={styles.chip} elevation={3}>
        <Text variant="labelLarge">
          {formatElevation(info.elevM)} · {Math.round(info.slopeDeg)}°
        </Text>
      </Surface>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center' },
  chip: { borderRadius: 18, paddingHorizontal: 14, paddingVertical: 6 },
});
