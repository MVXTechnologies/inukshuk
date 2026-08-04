import type { GpsQuality } from '@core/geo/track/gpsQuality';
import type { TrackStats } from '@core/models';
import { formatDistance, formatDuration, formatElevation, formatSpeed } from '@lib/format';
import { StatTile } from '@ui/components/StatTile';
import { StyleSheet, View } from 'react-native';
import { Icon, IconButton, Surface, Text, TouchableRipple, useTheme } from 'react-native-paper';

interface StatsHudProps {
  name: string;
  stats: TrackStats;
  /** Live wall-clock duration in seconds (ticks independently of GPS fixes). */
  elapsedS: number;
  /**
   * Instantaneous speed in m/s (see `@core/geo/track/liveSpeed`) — NOT
   * `stats.avgSpeedMps`, which is a whole-session moving average and reads as
   * "stuck" on a long recording.
   */
  liveSpeedMps: number;
  paused: boolean;
  /**
   * Live GPS signal quality. A warning chip shows for 'weak'/'lost' so a
   * stalled track (the filter silently drops bad fixes) is never mistaken for a
   * healthy one. Ignored while paused. Defaults to 'good' (no warning).
   */
  gpsQuality?: GpsQuality;
  /** Collapsed pill (false) vs. full card (true) — controlled so RecordControls
   * can lay its buttons out relative to the same state (item 3: expanded docks
   * the HUD bottom-left with the controls stacked vertically to its right). */
  expanded: boolean;
  onToggleExpanded: () => void;
}

/**
 * Recording HUD. Collapsed (default): a compact left-aligned pill (rec dot +
 * time + distance) so it doesn't cover the map. Expanded: a smaller card
 * (time, distance, speed, D+, D-, max alt) docked bottom-left — the sibling
 * RecordControls stacks its buttons vertically to its right in both states
 * (see MapScreen). The chevron on the pill/card toggles between the two.
 */
export function StatsHud({
  name,
  stats,
  elapsedS,
  liveSpeedMps,
  paused,
  gpsQuality = 'good',
  expanded,
  onToggleExpanded,
}: StatsHudProps) {
  const theme = useTheme();

  const statusMark = paused ? (
    <Text variant="labelSmall" style={{ color: theme.colors.tertiary }}>
      PAUSED
    </Text>
  ) : (
    <View style={[styles.dot, { backgroundColor: theme.colors.error }]} />
  );

  // Weak/lost GPS warning — only meaningful while actively recording (a paused
  // recording isn't expecting fixes). 'lost' is error-red; 'weak' is tertiary.
  const showGpsWarn = !paused && (gpsQuality === 'weak' || gpsQuality === 'lost');
  const gpsColor = gpsQuality === 'lost' ? theme.colors.error : theme.colors.tertiary;
  const gpsWarn = showGpsWarn ? (
    <View
      style={styles.gpsWarn}
      accessibilityLabel={gpsQuality === 'lost' ? 'No GPS signal' : 'Weak GPS signal'}
    >
      <Icon source="satellite-variant" size={14} color={gpsColor} />
      <Text variant="labelSmall" style={{ color: gpsColor, fontWeight: '700' }}>
        {gpsQuality === 'lost' ? 'No GPS' : 'Weak GPS'}
      </Text>
    </View>
  ) : null;

  if (!expanded) {
    return (
      <Surface style={styles.pill} elevation={4}>
        <TouchableRipple
          onPress={onToggleExpanded}
          borderless
          accessibilityRole="button"
          accessibilityLabel="Expand recording stats"
          style={styles.pillTouch}
        >
          <View style={styles.pillRow}>
            {statusMark}
            <Text variant="titleSmall" style={styles.mono}>
              {formatDuration(elapsedS)}
            </Text>
            <Text variant="bodyMedium" style={styles.mono}>
              {formatDistance(stats.distanceM)}
            </Text>
            {gpsWarn}
            <Icon source="chevron-up" size={20} />
          </View>
        </TouchableRipple>
      </Surface>
    );
  }

  return (
    <Surface style={styles.card} elevation={4}>
      <View style={styles.header}>
        <Text variant="labelLarge" numberOfLines={1} style={styles.title}>
          {name}
        </Text>
        {gpsWarn}
        {statusMark}
        <IconButton
          icon="chevron-down"
          size={16}
          onPress={onToggleExpanded}
          style={styles.collapseBtn}
          accessibilityLabel="Collapse recording stats"
        />
      </View>
      <View style={styles.row}>
        <StatTile compact label="Time" value={formatDuration(elapsedS)} />
        <StatTile compact label="Distance" value={formatDistance(stats.distanceM)} />
        <StatTile compact label="Speed" value={formatSpeed(liveSpeedMps)} />
      </View>
      <View style={styles.row}>
        <StatTile
          compact
          label="D+"
          value={formatElevation(stats.ascentM)}
          color={theme.colors.primary}
        />
        <StatTile
          compact
          label="D-"
          value={formatElevation(stats.descentM)}
          color={theme.colors.error}
        />
        <StatTile
          compact
          label="Max alt"
          value={stats.maxAltitudeM !== undefined ? formatElevation(stats.maxAltitudeM) : '--'}
        />
      </View>
    </Surface>
  );
}

const styles = StyleSheet.create({
  // Compact collapsed pill — small, left-aligned, content-width.
  pill: {
    borderRadius: 18,
    alignSelf: 'flex-start',
  },
  pillTouch: {
    borderRadius: 18,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  pillRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  mono: {
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
  // Expanded card — item 3: smaller than before and docked bottom-left, with
  // RecordControls' buttons stacked vertically to its right (see MapScreen).
  card: {
    borderRadius: 16,
    paddingVertical: 8,
    paddingHorizontal: 10,
    gap: 4,
    alignSelf: 'flex-start',
    maxWidth: 200,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingLeft: 2,
  },
  title: {
    flexShrink: 1,
    fontWeight: '700',
  },
  collapseBtn: {
    margin: 0,
    width: 24,
    height: 24,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  gpsWarn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  row: {
    flexDirection: 'row',
    gap: 10,
  },
});
