import { destinationName } from '@core/infoStrip/target';
import { useLibraryStore } from '@state/libraryStore';
import { useNavigationStore } from '@state/navigationStore';
import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { Icon, Text, TouchableRipple } from '@ui/paper';

import { weatherChrome as wc } from '../weather/weatherChrome';
import { useScaledStyles } from '@ui/displayScale';

/**
 * The destination chip (#97; slimmed in 2.6.0, #673): what you are
 * navigating to, by name, and the ✕ that ends it. The distance, bearing and
 * ETE moved to the info strip and the compass tape, so the chip no longer
 * repeats them.
 *
 * Top-centre, on the fixed dark slab of the map's floating chrome. NOT
 * permanent: it exists only while there is a destination. The name is the
 * saved waypoint it was set on, else "Destination". Maestro keys on
 * 'Clear destination'.
 */
export function DestinationChip({ onClear }: { onClear: () => void }) {
  const styles = useScaledStyles(stylesSheet);

  const destination = useNavigationStore((s) => s.destination);
  const waypoints = useLibraryStore((s) => s.waypoints);
  const name = useMemo(
    () => (destination === null ? null : destinationName(destination, waypoints)),
    [destination, waypoints],
  );
  if (name === null) return null;
  return (
    <View style={styles.chip} accessible={false}>
      <Icon source="flag-variant" size={16} color={wc.accent} />
      <Text style={styles.text} numberOfLines={1} accessibilityLabel={`Navigating to ${name}`}>
        {name}
      </Text>
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

const stylesSheet = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: '100%',
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
    flexShrink: 1,
  },
  clear: { borderRadius: 12, padding: 5 },
});
