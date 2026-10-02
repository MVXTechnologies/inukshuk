import { formatSpan } from '@core/format';
import type { ZoneBreakdown } from '@core/stats/hrZones';
import { tabularNums } from '@ui/fonts';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text, useTheme } from 'react-native-paper';

import { StatsCard } from './StatsControls';

const ZONE_NAMES = ['Recovery', 'Endurance', 'Tempo', 'Threshold', 'Maximum'];

/**
 * "Effort by heart-rate zone" (owner request): time in Z1–Z5 for the period
 * and activity shown, as one stacked bar and a per-zone list. Only trails
 * with heart rate count; the max HR it zones against is the setting, or the
 * estimate from the activities, with a link to change it.
 */
export function HrZonesCard({
  breakdown,
  maxHr,
  estimated,
  trailsWithHr,
  onChangeMaxHr,
}: {
  breakdown: ZoneBreakdown | null;
  /** Null: no setting and not enough heart rate to estimate one. */
  maxHr: number | null;
  estimated: boolean;
  trailsWithHr: number;
  onChangeMaxHr: () => void;
}) {
  const theme = useTheme();
  const tokens = useSchemeTokens();
  const has = breakdown !== null && breakdown.totalS > 0 && maxHr !== null;

  return (
    <StatsCard>
      <Text accessibilityRole="header" style={[styles.title, { color: tokens.ink }]}>
        Effort by heart-rate zone
      </Text>
      <View style={styles.maxRow}>
        <Text style={[styles.sub, tabularNums, { color: tokens.inkMuted }]}>
          {maxHr === null
            ? 'Max heart rate not set'
            : `Max HR ${maxHr} bpm · ${estimated ? 'estimated from your activities' : 'set by you'}`}
          {' · '}
        </Text>
        <Pressable
          onPress={onChangeMaxHr}
          accessibilityRole="link"
          accessibilityLabel="Change max heart rate"
          hitSlop={14}
        >
          <Text style={[styles.link, { color: theme.colors.secondary }]}>change</Text>
        </Pressable>
      </View>

      {!has ? (
        <Text style={[styles.none, { color: tokens.inkMuted }]}>
          No heart-rate data in this period
        </Text>
      ) : (
        <>
          <View
            style={styles.stack}
            accessible
            accessibilityLabel={`Heart-rate zones over ${trailsWithHr} ${trailsWithHr === 1 ? 'activity' : 'activities'}: ${breakdown.zones
              .map((z) => `zone ${z.zone} ${Math.round(z.fraction * 100)} percent`)
              .join(', ')}`}
          >
            {breakdown.zones.map((z, i) =>
              z.fraction > 0 ? (
                <View
                  key={z.zone}
                  style={{ flex: z.fraction, backgroundColor: tokens.stats.zones[i] }}
                />
              ) : null,
            )}
          </View>
          {breakdown.zones.map((z, i) => (
            <View key={z.zone} style={styles.zoneRow}>
              <View style={[styles.swatch, { backgroundColor: tokens.stats.zones[i] }]} />
              <Text style={[styles.zoneName, { color: tokens.ink }]}>
                Z{z.zone}{' '}
                <Text style={[styles.zoneHint, { color: tokens.inkMuted }]}>{ZONE_NAMES[i]}</Text>
              </Text>
              <Text style={[styles.bpm, tabularNums, { color: tokens.inkMuted }]}>
                {z.zone === 5 ? `${z.fromBpm}+` : `${z.fromBpm}–${z.toBpm - 1}`}
              </Text>
              <Text style={[styles.time, tabularNums, { color: tokens.ink }]}>
                {z.seconds > 0 ? formatSpan(z.seconds) : '—'}
              </Text>
              <Text style={[styles.pct, tabularNums, { color: tokens.inkMuted }]}>
                {Math.round(z.fraction * 100)} %
              </Text>
            </View>
          ))}
          <Text style={[styles.foot, { color: tokens.inkMuted }]}>
            From {trailsWithHr} {trailsWithHr === 1 ? 'activity' : 'activities'} with heart rate
          </Text>
        </>
      )}
    </StatsCard>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 15, lineHeight: 20, fontWeight: '800' },
  maxRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
  sub: { fontSize: 12, lineHeight: 16 },
  link: { fontSize: 12, lineHeight: 16, fontWeight: '700', textDecorationLine: 'underline' },
  none: {
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '700',
    paddingVertical: 12,
    textAlign: 'center',
  },
  stack: {
    height: 14,
    borderRadius: 7,
    overflow: 'hidden',
    flexDirection: 'row',
    marginVertical: 4,
  },
  zoneRow: { flexDirection: 'row', alignItems: 'center', minHeight: 26, gap: 8 },
  swatch: { width: 10, height: 10, borderRadius: 5 },
  zoneName: { flex: 1, fontSize: 14, lineHeight: 18, fontWeight: '700' },
  zoneHint: { fontSize: 13, fontWeight: '400' },
  bpm: { width: 64, fontSize: 12, lineHeight: 16, textAlign: 'right' },
  time: { width: 76, fontSize: 14, lineHeight: 18, fontWeight: '700', textAlign: 'right' },
  pct: { width: 40, fontSize: 13, lineHeight: 18, textAlign: 'right' },
  foot: { fontSize: 11, lineHeight: 14 },
});
