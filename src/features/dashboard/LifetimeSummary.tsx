import { lifetimeTotals } from '@core/dashboard/lifetime';
import { findCategory, type CustomCategory } from '@core/library/categories';
import type { TrackSummary } from '@core/models';
import { formatDistance, formatDuration, formatElevation } from '@state/formatters';
import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { Divider, Icon, Text, useTheme } from 'react-native-paper';

interface Props {
  /**
   * The trails to total. The Dashboard passes its already category-filtered
   * list, so this block answers the same question the rest of the screen is
   * answering — just without the 7d/3m/1y window.
   */
  tracks: readonly TrackSummary[];
  customCategories: readonly CustomCategory[];
}

/**
 * "All time": the running totals the period graph above deliberately cannot
 * show, because every bucket there is windowed. Distance, moving time and D+
 * over the whole library, plus a per-category breakdown.
 *
 * The breakdown only renders when there is more than one category to compare —
 * with a single category it would just restate the totals line above it.
 *
 * Aggregation is pure ({@link lifetimeTotals}); this component only formats.
 */
export function LifetimeSummary({ tracks, customCategories }: Props) {
  const theme = useTheme();
  const dim = theme.colors.onSurfaceVariant;
  const totals = useMemo(() => lifetimeTotals(tracks), [tracks]);

  if (totals.outings === 0) return null;

  return (
    <View style={styles.block} accessibilityLabel="All time totals">
      <Text variant="titleSmall" style={{ color: dim }}>
        All time
      </Text>
      <Text variant="headlineSmall">{formatDistance(totals.distanceM)}</Text>
      <Text variant="bodyMedium" style={{ color: dim }}>
        {`${totals.outings} ${totals.outings === 1 ? 'outing' : 'outings'}`}
        {'  ·  '}
        {totals.movingTimeS > 0 ? formatDuration(totals.movingTimeS) : '—'}
        {'  ·  '}
        {`↑ ${formatElevation(totals.ascentM)}`}
      </Text>

      {totals.byCategory.length > 1 && (
        <>
          <Divider style={styles.divider} />
          {totals.byCategory.map((row) => {
            const category = findCategory(row.categoryId, customCategories);
            const name = category?.name ?? 'Uncategorized';
            return (
              <View key={row.categoryId ?? '__uncategorized__'} style={styles.row}>
                <Icon
                  source={category?.icon ?? 'help-circle-outline'}
                  size={18}
                  color={category?.color ?? dim}
                />
                <Text variant="bodyMedium" style={styles.rowName} numberOfLines={1}>
                  {name}
                </Text>
                <Text variant="bodySmall" style={{ color: dim }}>
                  {row.outings}
                </Text>
                <Text variant="bodyMedium" style={styles.rowValue}>
                  {formatDistance(row.distanceM)}
                </Text>
              </View>
            );
          })}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: 2 },
  divider: { marginTop: 8, marginBottom: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 3 },
  rowName: { flex: 1 },
  rowValue: { minWidth: 84, textAlign: 'right' },
});
