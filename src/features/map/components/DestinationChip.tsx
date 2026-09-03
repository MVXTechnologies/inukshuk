import type { DestinationReadout } from '@core/geo/destination';
import { StyleSheet, View } from 'react-native';
import { Icon, Text, TouchableRipple } from 'react-native-paper';
import { weatherChrome as wc } from '../weather/weatherChrome';

/**
 * The dropped-pin destination readout (#97): how far the pin is and which way
 * to walk, live off the GPS fix.
 *
 * Top-centre, on the same fixed dark slab as the rest of the map's floating
 * chrome. It is a heads-up nav number, so it goes where nav apps put one —
 * and the two corners it could otherwise take are both spoken for (the
 * compass + scale stack on the left, the controls rail on the right), while
 * the bottom edge is a busy flex column (recording bar, legends, docks).
 *
 * NOT permanent chrome: it exists only while the user has a destination, and
 * the ✕ on it is the one-tap way out. Nothing about it is turn-by-turn —
 * routing, legs and ETAs are issue #95.
 */
export function DestinationChip({
  readout,
  onClear,
}: {
  /** Null while there is no GPS fix yet — the pin is set, the numbers aren't. */
  readout: DestinationReadout | null;
  onClear: () => void;
}) {
  return (
    <View style={styles.chip}>
      <Icon source="flag-variant" size={16} color={wc.accent} />
      {readout === null ? (
        <Text style={[styles.text, styles.muted]}>Destination · waiting for GPS</Text>
      ) : (
        <Text style={styles.text}>
          {readout.distance}
          <Text style={styles.muted}>{'  ·  '}</Text>
          {readout.bearing}
        </Text>
      )}
      <TouchableRipple
        onPress={onClear}
        style={styles.clear}
        accessibilityLabel="Clear destination"
        accessibilityRole="button"
        borderless
      >
        <Icon source="close" size={15} color={wc.inkMuted} />
      </TouchableRipple>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: wc.panel,
    borderRadius: 15,
    paddingLeft: 10,
    paddingRight: 4,
    paddingVertical: 5,
  },
  text: {
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '700',
    color: wc.ink,
    fontVariant: ['tabular-nums'],
  },
  muted: { fontWeight: '400', color: wc.inkMuted },
  clear: { borderRadius: 12, padding: 5 },
});
