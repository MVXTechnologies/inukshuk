import type { Place } from '@core/search/place';
import { PLACE_TYPES } from '@core/search/placeTypes';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';

/**
 * The temporary highlight on a place-search result (#496): the place's name
 * in a chip over a pointer onto the spot, so a jump lands on something you
 * can see. Rendered inside a MapLibre `<Marker anchor="bottom">`; gone at the
 * next tap on the map.
 *
 * River blue, not the sage destination flag nor a waypoint pin: it marks
 * "what you looked up", nothing saved and nothing you are heading to.
 * Visual only — taps fall through to the map.
 */
export function SearchHitMarker({ place }: { place: Place }) {
  const tokens = useSchemeTokens();
  return (
    <View
      style={styles.wrap}
      pointerEvents="none"
      accessible
      accessibilityLabel={`Search result: ${place.name}`}
    >
      <View style={[styles.chip, { backgroundColor: tokens.map.chip }]}>
        <Icon source={PLACE_TYPES[place.type].icon} size={16} color={palette.river} />
        <Text numberOfLines={1} style={[styles.label, { color: tokens.map.chipInk }]}>
          {place.name}
        </Text>
      </View>
      <View style={[styles.stem, { backgroundColor: palette.white }]} />
      <View style={styles.dot} />
    </View>
  );
}

const DOT = 16;
const styles = StyleSheet.create({
  wrap: { alignItems: 'center' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: 220,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
    shadowColor: palette.shadow,
    shadowOpacity: 0.3,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 3,
  },
  label: { flexShrink: 1, fontSize: 13, fontWeight: '700' },
  stem: { width: 2, height: 10 },
  // Its centre is the coordinate: the Marker anchors the bottom edge, so the
  // dot's lower half hangs below — negligible at the zooms we fly to.
  dot: {
    width: DOT,
    height: DOT,
    borderRadius: DOT / 2,
    backgroundColor: palette.river,
    borderWidth: 3,
    borderColor: palette.white,
  },
});
