import { palette, target } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { Pressable, StyleSheet } from 'react-native';
import { Icon, Text } from 'react-native-paper';

/**
 * "Search places" (revamp `Main.html`): the stone pill between the compass and
 * the right rail. Phase 1 is coordinates-first — it opens the existing
 * coordinates dialog; a real place index (peaks, lakes, trailheads) is a later
 * milestone, and this pill is where it will land.
 */
export function MapSearchPill({ onPress }: { onPress: () => void }) {
  const tokens = useSchemeTokens();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Search places"
      accessibilityHint="Opens coordinate entry"
      style={({ pressed }) => [
        styles.pill,
        { backgroundColor: tokens.map.chrome },
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

const styles = StyleSheet.create({
  pill: {
    height: target.min,
    borderRadius: target.min / 2,
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
