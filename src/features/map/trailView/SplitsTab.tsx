import type { SplitRow } from '@core/library/trailViewText';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';

interface Props {
  rows: readonly SplitRow[];
  unitLabel: 'km' | 'mi';
  /** 'pace' | 'speed' column title; null for an untimed route (climb only). */
  measure: 'pace' | 'speed' | null;
  loading?: boolean;
}

/**
 * Splits tab (#511): per km (or mile) pace and climb, a bar showing each
 * split's pace against the fastest. An untimed route shows climb and descent
 * only, the bar sized by climb.
 */
export function SplitsTab({ rows, unitLabel, measure, loading }: Props) {
  const t = useSchemeTokens();
  if (loading) {
    return (
      <Text variant="bodySmall" style={[styles.pad, { color: t.inkMuted }]}>
        Working out the splits…
      </Text>
    );
  }
  if (rows.length === 0) {
    return (
      <Text variant="bodySmall" style={[styles.pad, { color: t.inkMuted }]}>
        This trail is too short for splits.
      </Text>
    );
  }
  const head = [styles.head, { color: t.inkMuted }];
  return (
    <View style={styles.wrap} testID="trail-splits">
      <View style={styles.row}>
        <Text style={[head, styles.colUnit]}>{unitLabel}</Text>
        <Text style={[head, styles.colBar]}>{measure ? '' : 'climb'}</Text>
        {measure && (
          <Text style={[head, styles.colNum]}>{measure === 'speed' ? 'speed' : 'pace'}</Text>
        )}
        <Text style={[head, styles.colNum]}>{measure ? 'climb' : 'up'}</Text>
        {!measure && <Text style={[head, styles.colNum]}>down</Text>}
      </View>
      {rows.map((r) => {
        return (
          <View
            key={r.label}
            style={styles.row}
            accessible
            accessibilityLabel={r.a11y}
            testID="split-row"
          >
            <Text style={[styles.unit, styles.colUnit, { color: t.ink }]}>{r.label}</Text>
            <View style={styles.colBar}>
              <View style={[styles.track, { backgroundColor: t.surfaceVariant }]}>
                <View
                  style={[
                    styles.bar,
                    {
                      width: `${Math.round(r.ratio * 100)}%`,
                      backgroundColor: measure ? t.library.onMapBorder : t.data.ascent,
                    },
                  ]}
                />
              </View>
            </View>
            {measure && <Text style={[styles.num, styles.colNum, { color: t.ink }]}>{r.pace}</Text>}
            <Text style={[styles.small, styles.colNum, { color: t.inkVariant }]}>
              {measure ? r.net : r.climb}
            </Text>
            {!measure && (
              <Text style={[styles.small, styles.colNum, { color: t.inkVariant }]}>
                {r.descent}
              </Text>
            )}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  pad: { padding: 16 },
  wrap: { paddingHorizontal: 16, paddingTop: 10, gap: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 34 },
  head: { fontSize: 12 },
  colUnit: { width: 40 },
  colBar: { flex: 1 },
  colNum: { width: 74, textAlign: 'right' },
  unit: { fontSize: 14, fontWeight: '800' },
  track: { height: 10, borderRadius: 5, overflow: 'hidden' },
  bar: { height: 10, borderRadius: 5 },
  num: { fontSize: 14, fontWeight: '800' },
  small: { fontSize: 13 },
});
