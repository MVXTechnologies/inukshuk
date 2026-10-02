import { tabularNums } from '@ui/fonts';
import { target } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { Pressable, StyleSheet, View } from 'react-native';
import { Icon, Text, useTheme } from 'react-native-paper';

/**
 * The Logbook header's two additions (owner-approved mockup): the week-streak
 * flame — consecutive weeks with an outing, hidden at 0 — and the sage
 * "Statistics" pill. Both open Statistics.
 */
export function LogbookHeaderActions({
  streakWeeks,
  onOpenStats,
}: {
  streakWeeks: number;
  onOpenStats: () => void;
}) {
  const theme = useTheme();
  const tokens = useSchemeTokens();
  return (
    <View style={styles.row}>
      {streakWeeks > 0 && (
        <Pressable
          onPress={onOpenStats}
          accessibilityRole="button"
          accessibilityLabel={`${streakWeeks}-week streak`}
          accessibilityHint="Opens Statistics"
          style={({ pressed }) => [styles.flame, pressed && styles.pressed]}
        >
          <Icon source="fire" size={22} color={tokens.stats.flame} />
          <Text style={[styles.flameCount, tabularNums, { color: tokens.stats.flame }]}>
            {streakWeeks}
          </Text>
        </Pressable>
      )}
      <Pressable
        onPress={onOpenStats}
        accessibilityRole="button"
        accessibilityLabel="Statistics"
        // The 36 dp pill sits in a 44 dp touch target.
        hitSlop={(target.min - PILL_H) / 2}
        style={({ pressed }) => [
          styles.pill,
          { backgroundColor: theme.colors.secondaryContainer },
          pressed && styles.pressed,
        ]}
      >
        <Icon source="chart-bar" size={18} color={theme.colors.onSecondaryContainer} />
        <Text style={[styles.pillText, { color: theme.colors.onSecondaryContainer }]}>
          Statistics
        </Text>
      </Pressable>
    </View>
  );
}

const PILL_H = 36;

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 4, marginRight: 4 },
  flame: {
    minWidth: target.min,
    height: target.min,
    paddingHorizontal: 6,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 1,
  },
  flameCount: { fontSize: 16, lineHeight: 20, fontWeight: '800' },
  pill: {
    height: PILL_H,
    borderRadius: PILL_H / 2,
    paddingLeft: 12,
    paddingRight: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  pillText: { fontSize: 14, lineHeight: 18, fontWeight: '700' },
  pressed: { opacity: 0.75 },
});
