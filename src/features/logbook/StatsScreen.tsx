import { heroClimb, heroDistance, heroTime, type HeroValue } from '@core/dashboard/logbook';
import { createFormatters } from '@core/format';
import { estimateMaxHrForLibrary, histogramsIn, zoneBreakdown } from '@core/stats/hrZones';
import {
  activityChips,
  averageKind,
  averageValue,
  comparisonLine,
  periodBars,
  periodWindow,
  statsTracks,
  totalsIn,
  type StatsPeriod,
} from '@core/stats/periods';
import { weekStreaks } from '@core/stats/streaks';
import { findCategory } from '@core/library/categories';
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
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';
import { Icon, Text, useTheme } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { HrZonesCard } from './HrZonesCard';
import { StatsBarChart } from './StatsBarChart';
import { ActivityChips, LinkRow, Segmented, StatsCard } from './StatsControls';
import { useTrailStats } from './useTrailStats';

const PERIODS: { value: StatsPeriod; label: string }[] = [
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'year', label: 'Year' },
  { value: 'all', label: 'All time' },
];

const PERIOD_CAPS: Record<StatsPeriod, string> = {
  week: 'THIS WEEK',
  month: 'THIS MONTH',
  year: 'THIS YEAR',
  all: 'ALL TIME',
};

/**
 * Logbook › Statistics (owner-approved mockup, board 2): activity chips and
 * a Week / Month / Year / All time period; the period's totals with a
 * comparison line, its bar chart, the week streak and the activity's natural
 * average, effort by heart-rate zone, and the ways into Personal records and
 * Year in review. Totals come from the library index; best efforts and
 * heart rate from the per-trail cache (`@data/trailStatsStore`), so opening
 * this screen never reads a GPX.
 */
export function StatsScreen() {
  const theme = useTheme();
  const tokens = useSchemeTokens();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const tracks = useLibraryStore((s) => s.tracks);
  const customCategories = useLibraryStore((s) => s.customCategories);
  const units = useSettingsStore((s) => s.units);
  const maxHrSetting = useSettingsStore((s) => s.maxHeartRateBpm);
  const { summaries, progress } = useTrailStats();
  const now = useDashboardClock();

  const [period, setPeriod] = useState<StatsPeriod>('month');
  const [activity, setActivity] = useState<string | null>(null);

  const performed = useMemo(() => statsTracks(tracks, null), [tracks]);
  const chips = useMemo(() => activityChips(performed), [performed]);
  // A chip whose last trail was deleted falls back to All.
  const effectiveActivity = activity !== null && chips.includes(activity) ? activity : null;
  const shown = useMemo(
    () => statsTracks(performed, effectiveActivity),
    [performed, effectiveActivity],
  );

  const span = useMemo(() => periodWindow(period, now), [period, now]);
  const totals = useMemo(() => totalsIn(shown, span), [shown, span]);
  const comparison = useMemo(() => comparisonLine(shown, period, now), [shown, period, now]);
  const bars = useMemo(() => periodBars(shown, period, now), [shown, period, now]);
  const streaks = useMemo(
    () =>
      weekStreaks(
        shown.map((t) => t.startedAt),
        now,
      ),
    [shown, now],
  );
  const avgKind = averageKind(effectiveActivity);
  const avg = averageValue(totals, avgKind);

  const estimate = useMemo(
    () => estimateMaxHrForLibrary(performed, summaries, now),
    [performed, summaries, now],
  );
  const maxHr = maxHrSetting > 0 ? maxHrSetting : estimate;
  const histograms = useMemo(
    () => histogramsIn(shown, summaries, span.startMs, span.endMs),
    [shown, summaries, span],
  );
  const zones = useMemo(
    () => (maxHr === null ? null : zoneBreakdown(histograms, maxHr)),
    [histograms, maxHr],
  );

  const f = createFormatters(units);
  const category = findCategory(effectiveActivity, customCategories);
  const caps = [PERIOD_CAPS[period], category?.name.toUpperCase()].filter(Boolean).join(' · ');
  const avgText =
    avg === null
      ? '—'
      : avgKind === 'pace'
        ? f.formatPace(avg)
        : avgKind === 'speed'
          ? f.formatSpeed(avg)
          : avgKind === 'climb'
            ? f.formatElevation(avg)
            : f.formatDistance(avg);
  const avgLabel =
    avgKind === 'pace'
      ? 'Average pace'
      : avgKind === 'speed'
        ? 'Average speed'
        : avgKind === 'climb'
          ? 'Climb per outing'
          : 'Distance per outing';

  return (
    <View style={[styles.fill, { backgroundColor: theme.colors.background }]}>
      <HeaderContours />
      <View style={{ paddingTop: insets.top }}>
        <ScreenHeader title="Statistics" onBack={() => router.back()} />
      </View>
      <ScrollView
        style={styles.fill}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xl }]}
      >
        <ActivityChips
          ids={chips}
          selected={effectiveActivity}
          onSelect={setActivity}
          customCategories={customCategories}
        />
        <Segmented value={period} options={PERIODS} onChange={setPeriod} label="Period" />

        {progress.running && (
          <View
            style={[styles.computing, { backgroundColor: tokens.elevation.level3 }]}
            accessibilityLiveRegion="polite"
            accessibilityLabel={`Computing statistics, ${progress.done} of ${progress.total}`}
          >
            <ActivityIndicator size="small" color={tokens.inkMuted} />
            <Text style={[styles.computingText, tabularNums, { color: tokens.inkMuted }]}>
              Computing… {progress.done}/{progress.total}
            </Text>
          </View>
        )}

        <TotalsCard
          caps={caps}
          distance={heroDistance(totals.distanceM, units)}
          time={heroTime(totals.movingTimeS)}
          climb={heroClimb(totals.ascentM, units)}
          outings={totals.count}
          comparison={comparison}
        />

        <StatsBarChart bars={bars} period={period} units={units} />

        <View style={styles.pair}>
          <StatsCard
            style={styles.half}
            accessibilityLabel={`Current streak ${streaks.current} weeks, best ${streaks.best} weeks`}
          >
            <View style={styles.smallHead}>
              <Icon source="fire" size={18} color={tokens.stats.flame} />
              <Text style={[styles.smallLabel, { color: tokens.inkMuted }]}>Week streak</Text>
            </View>
            <Text style={[styles.smallValue, tabularNums, { color: tokens.ink }]}>
              {streaks.current}
              <Text style={[styles.smallUnit, { color: tokens.ink }]}>
                {streaks.current === 1 ? ' week' : ' weeks'}
              </Text>
            </Text>
            <Text style={[styles.smallSub, tabularNums, { color: tokens.inkMuted }]}>
              Best {streaks.best} {streaks.best === 1 ? 'week' : 'weeks'}
            </Text>
          </StatsCard>
          <StatsCard style={styles.half} accessibilityLabel={`${avgLabel} ${avgText}`}>
            <View style={styles.smallHead}>
              <Icon source="speedometer" size={18} color={tokens.inkMuted} />
              <Text style={[styles.smallLabel, { color: tokens.inkMuted }]}>{avgLabel}</Text>
            </View>
            <Text
              numberOfLines={1}
              adjustsFontSizeToFit
              style={[styles.smallValue, tabularNums, { color: tokens.ink }]}
            >
              {avgText}
            </Text>
            <Text style={[styles.smallSub, { color: tokens.inkMuted }]}>
              {PERIOD_CAPS[period].toLowerCase().replace(/^\w/, (c) => c.toUpperCase())}
            </Text>
          </StatsCard>
        </View>

        <HrZonesCard
          breakdown={zones}
          maxHr={maxHr}
          estimated={maxHrSetting === 0}
          trailsWithHr={histograms.length}
          onChangeMaxHr={() => router.push('/settings?open=training')}
        />

        <View style={styles.links}>
          <LinkRow
            icon="trophy-outline"
            title="Personal records"
            subtitle="Fastest efforts and biggest outings"
            onPress={() => router.push('/logbook/records')}
          />
          <LinkRow
            icon="calendar-month-outline"
            title="Year in review"
            subtitle="Every day of the year at a glance"
            onPress={() => router.push('/logbook/year')}
          />
        </View>
      </ScrollView>
    </View>
  );
}

function TotalsCard({
  caps,
  distance,
  time,
  climb,
  outings,
  comparison,
}: {
  caps: string;
  distance: HeroValue;
  time: HeroValue;
  climb: HeroValue;
  outings: number;
  comparison: { text: string; delta: number | null } | null;
}) {
  const theme = useTheme();
  const bg = theme.colors.inverseSurface;
  const ink = theme.colors.inverseOnSurface;
  const arrow =
    comparison?.delta == null
      ? null
      : comparison.delta > 0
        ? 'arrow-up'
        : comparison.delta < 0
          ? 'arrow-down'
          : 'equal';
  const spoken = (v: HeroValue) => `${v.value} ${v.unit}`;
  return (
    <View
      accessible
      accessibilityLabel={`${caps}: ${spoken(distance)}, ${spoken(time)} moving, ${spoken(climb)} climbed, ${outings} ${outings === 1 ? 'outing' : 'outings'}${comparison ? `. ${comparison.text}` : ''}`}
      style={[styles.totals, { backgroundColor: bg }]}
    >
      <Text numberOfLines={1} style={[styles.caps, styles.dim, { color: ink }]}>
        {caps}
      </Text>
      <View style={styles.grid}>
        <Hero value={distance} label="DISTANCE" ink={ink} />
        <Hero value={time} label="MOVING TIME" ink={ink} />
      </View>
      <View style={styles.grid}>
        <Hero value={climb} label="↑ CLIMB" ink={ink} />
        <Hero
          value={{ value: String(outings), unit: '' }}
          label={outings === 1 ? 'OUTING' : 'OUTINGS'}
          ink={ink}
        />
      </View>
      {comparison && (
        <View style={styles.compare}>
          {arrow && <Icon source={arrow} size={16} color={ink} />}
          <Text style={[styles.compareText, tabularNums, { color: ink }]}>{comparison.text}</Text>
        </View>
      )}
    </View>
  );
}

function Hero({ value, label, ink }: { value: HeroValue; label: string; ink: string }) {
  return (
    <View style={styles.cell}>
      <Text
        numberOfLines={1}
        adjustsFontSizeToFit
        maxFontSizeMultiplier={1.4}
        style={[styles.value, tabularNums, { color: ink }]}
      >
        {value.value}
        {value.unit !== '' && <Text style={[styles.unit, { color: ink }]}> {value.unit}</Text>}
      </Text>
      <Text numberOfLines={1} style={[styles.caps, styles.dim, { color: ink }]}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { paddingHorizontal: space.lg, paddingTop: 2, gap: 12 },
  computing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  computingText: { fontSize: 13, lineHeight: 18, fontWeight: '700' },
  totals: { borderRadius: radius.lg, paddingVertical: 14, paddingHorizontal: space.lg, gap: 10 },
  grid: { flexDirection: 'row', gap: 12 },
  cell: { flex: 1, minWidth: 0, gap: 1 },
  caps: { fontSize: 12, lineHeight: 16, fontWeight: '700', letterSpacing: 1 },
  dim: { opacity: 0.82 },
  value: { fontSize: 26, lineHeight: 30, fontWeight: '800' },
  unit: { fontSize: 15, fontWeight: '700' },
  compare: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  compareText: { fontSize: 13, lineHeight: 18, fontWeight: '700' },
  pair: { flexDirection: 'row', gap: 12 },
  half: { flex: 1, minWidth: 0, gap: 2 },
  smallHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  smallLabel: { fontSize: 12, lineHeight: 16, fontWeight: '700' },
  smallValue: { fontSize: 24, lineHeight: 30, fontWeight: '800' },
  smallUnit: { fontSize: 14, fontWeight: '700' },
  smallSub: { fontSize: 12, lineHeight: 16 },
  links: { gap: 8 },
});
