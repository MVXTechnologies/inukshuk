import type { TypeCount } from '@core/dashboard/logbook';
import { findCategory, type CustomCategory } from '@core/library/categories';
import { tabularNums } from '@ui/fonts';
import { space, target } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { Pressable, ScrollView, StyleSheet } from 'react-native';
import { Icon, Text, useTheme } from 'react-native-paper';

/**
 * "Activities by type" (revamp `After-Logbook.html`): Hike · Run · Ski · Bike
 * with their counts — glyph in the category colour — then any other type the
 * logbook holds. Each chip is also the Logbook's type filter: tap to narrow
 * the chart, totals, Recent and calendar to that type; tap again for all.
 */
export function ActivityTypeChips({
  counts,
  customCategories,
  selectedId,
  onSelect,
}: {
  counts: readonly TypeCount[];
  customCategories: readonly CustomCategory[];
  selectedId: string | null;
  onSelect: (categoryId: string | null) => void;
}) {
  const theme = useTheme();
  const tokens = useSchemeTokens();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      accessibilityLabel="Activities by type"
      contentContainerStyle={styles.row}
      // Full-bleed scroller: the 16 dp gutter lives inside the content.
      style={styles.scroller}
    >
      {counts.map(({ categoryId, count }) => {
        const category = findCategory(categoryId, customCategories);
        if (category === null) return null;
        const selected = selectedId === categoryId;
        return (
          <Pressable
            key={categoryId}
            onPress={() => onSelect(selected ? null : categoryId)}
            hitSlop={target.compactHitSlop}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            accessibilityLabel={`${category.name}, ${count} ${count === 1 ? 'activity' : 'activities'}`}
            accessibilityHint={selected ? 'Shows every activity' : `Shows only ${category.name}`}
            style={({ pressed }) => [
              styles.chip,
              selected
                ? {
                    backgroundColor: theme.colors.secondaryContainer,
                    borderColor: theme.colors.secondary,
                  }
                : { backgroundColor: tokens.surface, borderColor: tokens.outlineVariant },
              pressed && styles.pressed,
            ]}
          >
            <Icon source={category.icon} size={16} color={category.color} />
            <Text style={[styles.name, { color: tokens.ink }]}>{category.name}</Text>
            <Text style={[styles.count, tabularNums, { color: tokens.inkMuted }]}>{count}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroller: { marginHorizontal: -space.lg, flexGrow: 0 },
  row: { paddingHorizontal: space.lg, paddingVertical: target.compactHitSlop, gap: 6 },
  chip: {
    height: target.compact,
    borderRadius: target.compact / 2,
    borderWidth: 1,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  pressed: { opacity: 0.8 },
  name: { fontSize: 13, lineHeight: 18, fontWeight: '700' },
  count: { fontSize: 13, lineHeight: 18, fontWeight: '500' },
});
