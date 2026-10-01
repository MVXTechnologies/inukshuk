import { createFormatters, formatDuration } from '@core/format';
import { trailTiming } from '@core/geo/track';
import type { TrackStats } from '@core/models';
import { useSettingsStore } from '@state/settingsStore';
import { StyleSheet, View } from 'react-native';
import { Text, useTheme } from 'react-native-paper';

interface Props {
  stats: Pick<TrackStats, 'distanceM' | 'durationS' | 'movingTimeS' | 'avgSpeedMps'>;
  /** The trail's activity category: pace (foot) or speed (bike/ski/paddle). */
  category?: string | null;
}

/**
 * The trail summary's time block (#504): elapsed time and its average next
 * to moving time and moving pace/speed — stops excluded, like Strava. A small
 * label over each value so the two times and the two averages can't be
 * confused. Renders nothing for an untimed trail (a planned route).
 */
export function TrailTimeStats({ stats, category }: Props) {
  const theme = useTheme();
  // Subscribed so a unit flip re-renders the open trail at once.
  const units = useSettingsStore((s) => s.units);
  const timing = trailTiming(stats, category);
  if (!timing) return null;

  const fmt = createFormatters(units);
  const avg = (mps: number) =>
    timing.display === 'speed' ? fmt.formatSpeed(mps) : fmt.formatPace(mps);
  const isSpeed = timing.display === 'speed';
  const cells: { label: string; value: string }[] = [
    { label: 'Time', value: formatDuration(timing.elapsedS) },
    { label: 'Moving time', value: formatDuration(timing.movingTimeS) },
    { label: isSpeed ? 'Avg speed' : 'Avg pace', value: avg(timing.elapsedSpeedMps) },
    { label: isSpeed ? 'Moving speed' : 'Moving pace', value: avg(timing.movingSpeedMps) },
  ];

  return (
    <View style={styles.row} testID="trail-time-stats">
      {cells.map((c) => (
        <View
          key={c.label}
          style={styles.cell}
          accessible
          accessibilityLabel={`${c.label} ${c.value}`}
        >
          <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
            {c.label}
          </Text>
          <Text variant="labelMedium">{c.value}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 14, rowGap: 4, marginTop: 4 },
  cell: { minWidth: 56 },
});
