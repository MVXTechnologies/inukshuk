import { mapColors } from '@ui/theme';
import { StyleSheet, View } from 'react-native';
import { Icon } from 'react-native-paper';
import { InukshukIcon } from './InukshukIcon';

interface Props {
  /** Whether the waypoint has a photo attached (shows a small camera badge). */
  hasPhoto?: boolean;
  /** Accessible name of the pin (the waypoint's label, e.g. "Waypoint 1"). */
  label?: string;
}

/**
 * Live recording waypoint marker: an inukshuk glyph in a round badge with a
 * downward pointer whose tip sits on the dropped coordinate (anchor="bottom").
 *
 * The pin is visual-only (`pointerEvents="none"` — taps are hit-tested at the
 * map level, see MapScreen's onMapPress) but it still announces itself to the
 * accessibility tree: screen readers (and the e2e suite) can locate a pin by
 * its label even though the touch itself falls through to the map.
 */
export function WaypointMarkerPin({ hasPhoto, label }: Props) {
  return (
    <View
      style={styles.wrap}
      pointerEvents="none"
      accessible={label !== undefined}
      accessibilityLabel={label}
    >
      <View style={styles.badge}>
        <InukshukIcon size={20} color="#ffffff" />
        {hasPhoto && (
          <View style={styles.photoDot}>
            <Icon source="camera" size={9} color="#ffffff" />
          </View>
        )}
      </View>
      <View style={styles.pointer} />
    </View>
  );
}

const BADGE = 34;
const styles = StyleSheet.create({
  wrap: { alignItems: 'center' },
  badge: {
    width: BADGE,
    height: BADGE,
    borderRadius: BADGE / 2,
    backgroundColor: mapColors.userLocation,
    borderWidth: 2,
    borderColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoDot: {
    position: 'absolute',
    right: -3,
    top: -3,
    width: 15,
    height: 15,
    borderRadius: 8,
    backgroundColor: '#2b2b2b',
    borderWidth: 1.5,
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
