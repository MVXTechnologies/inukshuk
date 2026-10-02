import { createFormatters, formatDuration } from '@core/format';
import {
  biggestRecords,
  fastestRecords,
  inFamily,
  type RecordFamily,
  type RecordRow,
} from '@core/stats/records';
import { useDashboardClock } from '@features/dashboard/useDashboardClock';
import { useLibraryStore } from '@state/libraryStore';
import { useSettingsStore } from '@state/settingsStore';
import { HeaderContours } from '@ui/components/ContourTexture';
import { ScreenHeader } from '@ui/components/ScreenHeader';
import { tabularNums } from '@ui/fonts';
import { radius, space } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Text, useTheme } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SectionLabel, Segmented, StatsCard } from './StatsControls';
import { useTrailStats } from './useTrailStats';

const FAMILIES: { value: RecordFamily; label: string }[] = [
  { value: 'run', label: 'Run' },
  { value: 'hike', label: 'Hike' },
  { value: 'bike', label: 'Bike' },
];

const FASTEST_TITLE: Record<RecordFamily, string> = {
  run: 'FASTEST',
  hike: 'FASTEST CLIMBS',
  bike: 'FASTEST',
};

function dateLabel(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Logbook › Personal records (owner-approved mockup, board 3): per activity
 * (Run · Hike · Bike), the fastest continuous stretches — 1 km to marathon,
 * 5–40 km on the bike, 100–1000 m climbs on foot — and the biggest outings.
 * Each record names its trail and date, wears "NEW" for 14 days, and opens
 * the trail.
 */
export function RecordsScreen() {
  const theme = useTheme();
  const tokens = useSchemeTokens();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const tracks = useLibraryStore((s) => s.tracks);
  const units = useSettingsStore((s) => s.units);
  const { summaries, progress } = useTrailStats();
  const now = useDashboardClock();
  // Open on the family the user has most of.
  const [family, setFamily] = useState<RecordFamily>(() => {
    const counts = FAMILIES.map((f) => tracks.filter((t) => inFamily(t, f.value)).length);
    const best = counts.indexOf(Math.max(...counts));
    return FAMILIES[best]?.value ?? 'run';
  });

  const fastest = useMemo(
    () => fastestRecords(family, tracks, summaries, now),
    [family, tracks, summaries, now],
  );
  const biggest = useMemo(() => biggestRecords(family, tracks, now), [family, tracks, now]);
  const f = createFormatters(units);

  const valueText = (r: RecordRow): string => {
    if (r.value === null) return '—';
    switch (r.kind) {
      case 'time':
      case 'duration':
        return formatDuration(r.value);
      case 'distance':
        return f.formatDistance(r.value);
      case 'climb':
      case 'altitude':
        return f.formatElevation(r.value);
    }
  };

  const renderRow = (r: RecordRow, i: number) => {
    const value = valueText(r);
    const has = r.value !== null && r.trackId !== undefined;
    const meta = has ? `${r.trackName ?? ''} · ${dateLabel(r.startedAt ?? 0)}` : r.emptyText;
    return (
      <View key={r.key}>
        {i > 0 && <View style={[styles.divider, { backgroundColor: tokens.divider }]} />}
        <Pressable
          disabled={!has}
          onPress={() => has && router.push(`/trail3d/${r.trackId}`)}
          accessibilityRole={has ? 'button' : undefined}
          accessibilityLabel={`${r.label}: ${has ? value : 'no record'}. ${meta}${r.isNew ? '. New record' : ''}`}
          style={({ pressed }) => [styles.row, pressed && styles.pressed]}
        >
          <View style={styles.rowText}>
            <View style={styles.labelLine}>
              <Text style={[styles.label, { color: tokens.ink }]}>{r.label}</Text>
              {r.isNew && (
                <View style={[styles.badge, { backgroundColor: tokens.stats.newBadge }]}>
                  <Text style={[styles.badgeText, { color: tokens.stats.onNewBadge }]}>NEW</Text>
                </View>
              )}
            </View>
            <Text numberOfLines={1} style={[styles.meta, { color: tokens.inkMuted }]}>
              {meta}
            </Text>
          </View>
          <Text style={[styles.value, tabularNums, { color: has ? tokens.ink : tokens.inkMuted }]}>
            {value}
          </Text>
        </Pressable>
      </View>
    );
  };

  return (
    <View style={[styles.fill, { backgroundColor: theme.colors.background }]}>
      <HeaderContours />
      <View style={{ paddingTop: insets.top }}>
        <ScreenHeader title="Personal records" onBack={() => router.back()} />
      </View>
      <ScrollView
        style={styles.fill}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xl }]}
      >
        <Segmented value={family} options={FAMILIES} onChange={setFamily} label="Activity" />
        {progress.running && (
          <View style={[styles.computing, { backgroundColor: tokens.elevation.level3 }]}>
            <ActivityIndicator size="small" color={tokens.inkMuted} />
            <Text style={[styles.computingText, tabularNums, { color: tokens.inkMuted }]}>
              Computing… {progress.done}/{progress.total}
            </Text>
          </View>
        )}
        <SectionLabel>{FASTEST_TITLE[family]}</SectionLabel>
        <StatsCard style={styles.list}>{fastest.map(renderRow)}</StatsCard>
        <SectionLabel>BIGGEST OUTINGS</SectionLabel>
        <StatsCard style={styles.list}>{biggest.map(renderRow)}</StatsCard>
        <Text style={[styles.foot, { color: tokens.inkMuted }]}>
          Fastest times are the quickest continuous stretch of a recording, measured on its GPS
          track.
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { paddingHorizontal: space.lg, paddingTop: 2, gap: 10 },
  list: { paddingVertical: 4, gap: 0 },
  row: { minHeight: 60, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  pressed: { opacity: 0.7 },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  labelLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  label: { fontSize: 15, lineHeight: 20, fontWeight: '700' },
  meta: { fontSize: 12, lineHeight: 16 },
  value: { fontSize: 18, lineHeight: 24, fontWeight: '800' },
  badge: { borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 },
  badgeText: { fontSize: 10, lineHeight: 13, fontWeight: '800', letterSpacing: 0.5 },
  divider: { height: 1 },
  foot: { fontSize: 12, lineHeight: 16, marginTop: 4 },
  computing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  computingText: { fontSize: 13, lineHeight: 18, fontWeight: '700' },
});
