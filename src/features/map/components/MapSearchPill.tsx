import { palette, target } from '@ui/tokens';
import { useChromeOutline } from '@ui/useChromeOutline';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { Pressable, StyleSheet } from 'react-native';
import { Icon, Text } from '@ui/paper';
import { useDisplayScale, useScaledStyles } from '@ui/displayScale';

/** The pill's height at 100 %: the map's 48 dp touch target. */
const PILL_H = target.min;

/**
 * "Search places" (revamp `Main.html`): the stone pill between the compass and
 * the right rail. Opens the place search (#496, `../search/PlaceSearchSheet`):
 * towns, villages, peaks, lakes, campgrounds and parks by name, or a pasted
 * coordinate.
 */
export function MapSearchPill({ onPress }: { onPress: () => void }) {
  const styles = useScaledStyles(stylesSheet);
  // #760: the pill is drawn at the Display size (41 dp at Small) and touched at 48.
  const { sz, slop } = useDisplayScale();
  const h = sz(PILL_H);
  const tokens = useSchemeTokens();
  const outline = useChromeOutline();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Search places"
      accessibilityHint="Find towns, peaks, lakes and campgrounds by name, or go to coordinates"
      hitSlop={{ top: slop(PILL_H), bottom: slop(PILL_H) }}
      style={({ pressed }) => [
        styles.pill,
        { height: h, borderRadius: h / 2 },
        { backgroundColor: tokens.map.chrome },
        outline,
        pressed && styles.pressed,
      ]}
    >
      <Icon source="magnify" size={20} color={tokens.map.chromeInk} />
      <Text numberOfLines={1} style={[styles.label, { color: tokens.map.chromeInk }]}>
        Search places
      </Text>
    </Pressable>
  );
}

const stylesSheet = StyleSheet.create({
  // Height and radius come from the Display size (see above).
  pill: {
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    shadowColor: palette.shadow,
    shadowOpacity: 0.28,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  pressed: { opacity: 0.85 },
  label: { flexShrink: 1, fontSize: 16, fontWeight: '500' },
});
