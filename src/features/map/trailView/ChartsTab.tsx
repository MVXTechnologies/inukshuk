import { formatSpan } from '@core/format';
import { heartRateBands, sampleIndexAt, type ChartSeries } from '@core/geo/track';
import { formatElevation, formatPace, formatSpeed } from '@state/formatters';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';
import { TrailChart } from './TrailChart';

interface Props {
  series: ChartSeries | null;
  /** 'pace' for foot activities, 'speed' for bike/ski/paddle. */
  display: 'pace' | 'speed';
  cursorDistanceM: number | null;
  onScrub: (distanceM: number) => void;
}

/**
 * Charts tab (#511, board C2): Elevation, Pace (or Speed) and Heart rate,
 * stacked and synced — dragging on any of them moves all three cursors, the
 * map marker and the readout. Pace breaks at stops, which are labelled; the
 * heart-rate chart shows light effort bands and only exists when the trail
 * carries heart rate; an untimed route keeps the elevation chart alone.
 */
export function ChartsTab({ series, display, cursorDistanceM, onScrub }: Props) {
  const t = useSchemeTokens();
  if (!series) {
    return (
      <Text variant="bodySmall" style={[styles.pad, { color: t.inkMuted }]}>
        Drawing the charts…
      </Text>
    );
  }
  const i = cursorDistanceM === null ? null : sampleIndexAt(series, cursorDistanceM);
  const pick = (vals: readonly (number | null)[] | null) =>
    vals && i !== null ? (vals[i] ?? null) : null;
  const common = {
    distances: series.distances,
    totalM: series.totalM,
    cursorDistanceM,
    onScrub,
  };
  const charts: number = [series.elevation, series.speed, series.heartRate].filter(Boolean).length;

  const ele = pick(series.elevation);
  const speed = pick(series.speed);
  const hr = pick(series.heartRate);
  const speedText =
    i === null
      ? '—'
      : speed === null
        ? 'stopped'
        : display === 'speed'
          ? formatSpeed(speed)
          : formatPace(speed);

  return (
    <View style={styles.wrap} testID="trail-charts">
      <Text style={[styles.hint, { color: t.inkMuted }]}>
        {charts > 1
          ? 'Drag on any chart: they all follow, and so does the map.'
          : 'Drag on the chart: the map follows.'}
      </Text>
      {series.elevation && (
        <TrailChart
          {...common}
          title="Elevation"
          valueText={ele === null ? '—' : formatElevation(ele)}
          values={series.elevation}
          color={palette.ochre}
          area
          testID="chart-elevation"
        />
      )}
      {series.speed && (
        <TrailChart
          {...common}
          title={display === 'speed' ? 'Speed' : 'Pace'}
          valueText={speedText}
          values={series.speed}
          color={palette.puck}
          marks={series.stopMarks.map((m) => ({
            distanceM: m.distanceM,
            label: `${m.kind === 'pause' ? 'paused' : 'stop'} ${formatSpan(m.durationS)}`,
          }))}
          testID="chart-pace"
        />
      )}
      {series.heartRate && (
        <TrailChart
          {...common}
          title="Heart rate"
          valueText={hr === null ? '—' : `${Math.round(hr)} bpm`}
          values={series.heartRate}
          color={t.explore.trail}
          bands={heartRateBands(series.heartRate).map((b, k) => ({
            from: b.fromBpm,
            to: b.toBpm,
            color: t.explore.trail,
            opacity: k === 0 ? 0.16 : 0.08,
          }))}
          footnote="From your watch or import. Bands: the top 10 % and 20 % of this outing's peak."
          testID="chart-hr"
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  pad: { padding: 16 },
  wrap: { paddingHorizontal: 16, paddingTop: 12, gap: 10 },
  hint: { fontSize: 12.5 },
});
