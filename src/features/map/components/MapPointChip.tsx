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
 * Each line owns its own data hook (see WeatherPointLine / DepthPointLine),
 * so a line that has nothing to say costs nothing and never blocks the rest.
 */
export function MapPointChip({
  children,
  accessibilityLabel,
}: {
  children: ReactNode;
  accessibilityLabel: string;
}) {
  return (
    <View style={styles.wrap} pointerEvents="none" accessibilityLabel={accessibilityLabel}>
      <View style={styles.chip}>{children}</View>
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
