import { HeaderContours } from '@ui/components/ContourTexture';
import {
  calendarIndex,
  matchesCategoryFilter,
  type CalendarDayEntry,
} from '@core/dashboard/aggregate';
import {
  countsByType,
  distanceSeries,
  recentActivities,
  type ChartGranularity,
} from '@core/dashboard/logbook';
import { findCategory } from '@core/library/categories';
import { weekStreaks } from '@core/stats/streaks';
import { LogbookHeaderActions } from '@features/logbook/LogbookHeaderActions';
import { useTrailStatsBackfill } from '@features/logbook/useTrailStats';
import { useLibraryStore } from '@state/libraryStore';
import { useSettingsStore } from '@state/settingsStore';
import { space } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Icon, Text, useTheme } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ScreenHeader } from '@ui/components/ScreenHeader';
import { ActivityTypeChips } from './ActivityTypeChips';
import { DayActivitiesDialog } from './DayActivitiesDialog';
import { DistanceChart } from './DistanceChart';
import { LifetimeCard } from './LifetimeCard';
import { MonthCalendar } from './MonthCalendar';
import { RecentActivityRow } from './RecentActivityRow';
import { useDashboardClock } from './useDashboardClock';

/** How many rows the Recent list shows. */
const RECENT_ROWS = 5;

/**
 * The Logbook tab (the old Dashboard; revamp `After-Logbook.html`, spec §7):
 * lifetime totals, "Distance per week" (Week/Month/Year), "Activities by type"
 * — which doubles as the type filter — the Recent list, and the month
 * calendar that taps through to each trail. Everything derives from the
 * library's TrackSummary index — pure aggregation in `@core/dashboard`,
 * nothing persisted.
 */
export function DashboardScreen() {
  const theme = useTheme();
  const tokens = useSchemeTokens();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const tracks = useLibraryStore((s) => s.tracks);
  const customCategories = useLibraryStore((s) => s.customCategories);
  const units = useSettingsStore((s) => s.units);

  const [granularity, setGranularity] = useState<ChartGranularity>('week');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const now = useDashboardClock();
  // Statistics' per-trail summaries are computed in the background from here,
  // so a first-run backfill is usually done before Statistics is opened.
  useTrailStatsBackfill();
  // Following the current month is the default; explicit browsing pins it.
  const [browsedMonth, setBrowsedMonth] = useState<{ year: number; month: number } | null>(null);
  const visibleMonth = useMemo(() => {
    const d = new Date(now);
    return browsedMonth ?? { year: d.getFullYear(), month: d.getMonth() };
  }, [browsedMonth, now]);
  const [dayPick, setDayPick] = useState<{ entry: CalendarDayEntry; dateMs: number } | null>(null);

  const buckets = useMemo(
    () => distanceSeries(tracks, granularity, now, categoryId),
    [tracks, granularity, now, categoryId],
  );

  const monthEntries = useMemo(
    () => calendarIndex(tracks, visibleMonth.year, visibleMonth.month, categoryId),
    [tracks, visibleMonth, categoryId],
  );

  const hasAnyActivity = useMemo(
    () => tracks.some((t) => matchesCategoryFilter(t, null)),
    [tracks],
  );
  const matching = useMemo(
    () => tracks.filter((t) => matchesCategoryFilter(t, categoryId)),
    [tracks, categoryId],
  );
  const typeCounts = useMemo(() => countsByType(tracks), [tracks]);
  // The header flame: consecutive weeks with an outing, every activity.
  const streak = useMemo(
    () =>
      weekStreaks(
        tracks.filter((t) => matchesCategoryFilter(t, null)).map((t) => t.startedAt),
        now,
      ).current,
    [tracks, now],
  );
  const recent = useMemo(
    () => recentActivities(tracks, categoryId, RECENT_ROWS),
    [tracks, categoryId],
  );
  // Back-navigation floor: the month of the oldest matching track.
  const oldest = useMemo(
    () => (matching.length > 0 ? Math.min(...matching.map((t) => t.startedAt)) : now),
    [matching, now],
  );

  const selectedCategory = findCategory(categoryId, customCategories);
  const dim = theme.colors.onSurfaceVariant;

  const openTrail = useCallback((id: string) => router.push(`/trail3d/${id}`), [router]);

  const canPrevMonth = () => {
    const floor = new Date(oldest);
    return (
      visibleMonth.year > floor.getFullYear() ||
      (visibleMonth.year === floor.getFullYear() && visibleMonth.month > floor.getMonth())
    );
  };
  const nowDate = new Date(now);
  const canNextMonth =
    visibleMonth.year < nowDate.getFullYear() ||
    (visibleMonth.year === nowDate.getFullYear() && visibleMonth.month < nowDate.getMonth());
  const shiftMonth = (delta: number) =>
    setBrowsedMonth((previous) => {
      const { year, month } = previous ?? visibleMonth;
      const d = new Date(year, month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });

  const onDayPress = (entry: CalendarDayEntry) => {
    if (entry.tracks.length === 1) router.push(`/trail3d/${entry.tracks[0]!.id}`);
    else {
      setDayPick({
        entry,
        dateMs: new Date(visibleMonth.year, visibleMonth.month, entry.day).getTime(),
      });
    }
  };
  const dayPickTracks = useMemo(() => {
    if (!dayPick) return [];
    const ids = new Set(dayPick.entry.tracks.map((t) => t.id));
    return tracks.filter((t) => ids.has(t.id));
  }, [dayPick, tracks]);

  // Logbook header (the old Dashboard): the shared tab header, so its title
  // and Settings gear sit exactly where the Library's and Explore's do.
  const header = (
    <View style={{ paddingTop: insets.top }}>
      <ScreenHeader title="Logbook">
        {hasAnyActivity && (
          <LogbookHeaderActions
            streakWeeks={streak}
            onOpenStats={() => router.push('/logbook/stats')}
          />
        )}
      </ScreenHeader>
    </View>
  );

  if (!hasAnyActivity) {
    return (
      <View style={[styles.fill, { backgroundColor: theme.colors.background }]}>
        <HeaderContours />
        {header}
        <View style={styles.empty}>
          <Icon source="chart-line-variant" size={48} color={dim} />
          <Text variant="titleMedium" style={styles.emptyTitle}>
            No activities yet
          </Text>
          <Text variant="bodyMedium" style={[styles.emptyBody, { color: dim }]}>
            Record a trail from the Map tab and it will show up here.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.fill, { backgroundColor: theme.colors.background }]}>
      <HeaderContours />
      {header}
      <ScrollView style={styles.fill} contentContainerStyle={styles.content}>
        <View style={styles.top}>
          <LifetimeCard tracks={matching} units={units} typeName={selectedCategory?.name ?? null} />
          <DistanceChart
            buckets={buckets}
            granularity={granularity}
            onGranularityChange={setGranularity}
            units={units}
          />
          <ActivityTypeChips
            counts={typeCounts}
            customCategories={customCategories}
            selectedId={categoryId}
            onSelect={setCategoryId}
          />
          <Text accessibilityRole="header" style={[styles.caps, { color: tokens.inkMuted }]}>
            RECENT
          </Text>
        </View>

        {recent.length === 0 ? (
          <Text style={[styles.none, { color: tokens.inkMuted }]}>
            {selectedCategory !== null
              ? `No ${selectedCategory.name} activities yet.`
              : 'No activities yet.'}
          </Text>
        ) : (
          recent.map((track, i) => (
            <View key={track.id}>
              {i > 0 && <View style={[styles.divider, { backgroundColor: tokens.divider }]} />}
              <RecentActivityRow
                track={track}
                units={units}
                customCategories={customCategories}
                onPress={openTrail}
              />
            </View>
          ))
        )}

        <View style={styles.calendar}>
          <Text accessibilityRole="header" style={[styles.caps, { color: tokens.inkMuted }]}>
            CALENDAR
          </Text>
          <MonthCalendar
            todayMs={now}
            year={visibleMonth.year}
            month={visibleMonth.month}
            entries={monthEntries}
            customCategories={customCategories}
            onPrev={() => shiftMonth(-1)}
            onNext={() => shiftMonth(1)}
            canPrev={canPrevMonth()}
            canNext={canNextMonth}
            onDayPress={onDayPress}
          />
        </View>

        <DayActivitiesDialog
          title={
            dayPick
              ? `Activities on ${new Date(dayPick.dateMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
              : null
          }
          tracks={dayPickTracks}
          customCategories={customCategories}
          onPick={(id) => {
            setDayPick(null);
            router.push(`/trail3d/${id}`);
          }}
          onDismiss={() => setDayPick(null)}
        />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { paddingTop: 2, paddingBottom: space.xl },
  top: { paddingHorizontal: space.lg, gap: 10 },
  caps: { fontSize: 12, lineHeight: 16, fontWeight: '800', letterSpacing: 1, marginTop: 4 },
  divider: { height: 1, marginLeft: 84 },
  none: { paddingHorizontal: space.lg, paddingVertical: space.lg, fontSize: 14, lineHeight: 20 },
  calendar: { paddingHorizontal: space.lg, paddingTop: space.lg, gap: space.sm },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 32,
  },
  emptyTitle: { marginTop: 8 },
  emptyBody: { textAlign: 'center' },
});
