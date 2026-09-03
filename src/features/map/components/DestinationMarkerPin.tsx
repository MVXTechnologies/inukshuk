import { StyleSheet, View } from 'react-native';
import { Icon } from 'react-native-paper';
import { weatherChrome as wc } from '../weather/weatherChrome';

/**
 * The dropped destination pin (#97): a flag badge whose pointer tip sits on
 * the coordinate (rendered inside a MapLibre `<Marker anchor="bottom">`).
 *
 * Deliberately NOT a waypoint pin: a waypoint is a saved place in the
 * library, a destination is a transient "I'm heading there" marker, and they
 * must never be mistaken for each other on the map. Hence the flag glyph and
 * the sage accent disc instead of the inukshuk on the location blue.
 *
 * Visual only (`pointerEvents="none"`) — it carries an accessibility label so
 * screen readers can find it, but taps fall through to the map, exactly like
 * WaypointMarkerPin.
 */
export function DestinationMarkerPin() {
  return (
    <View style={styles.wrap} pointerEvents="none" accessible accessibilityLabel="Destination pin">
      <View style={styles.badge}>
        <Icon source="flag-variant" size={19} color={wc.onAccent} />
      </View>
      <View style={styles.pointer} />
    </View>
  );
}

const BADGE = 32;
const styles = StyleSheet.create({
  wrap: { alignItems: 'center' },
  badge: {
    width: BADGE,
    height: BADGE,
    borderRadius: BADGE / 2,
    backgroundColor: wc.accent,
    borderWidth: 2,
    borderColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Triangle pointing down; its tip aligns with the marker coordinate.
  pointer: {
    width: 0,
    height: 0,
    marginTop: -1,
    borderLeftWidth: 6,
    borderRightWidth: 6,
    borderTopWidth: 9,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderTopColor: '#ffffff',
  },
});
