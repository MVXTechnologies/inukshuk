import {
  aggregateBuckets,
  calendarIndex,
  matchesCategoryFilter,
  type CalendarDayEntry,
  type DashboardPeriod,
} from '@core/dashboard/aggregate';
import { allCategories, categoryColor, findCategory } from '@core/library/categories';
import { formatDistance, formatDuration, formatElevation } from '@state/formatters';
import { useLibraryStore } from '@state/libraryStore';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Chip, Icon, Menu, SegmentedButtons, Text, useTheme } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ActivityGraph } from './ActivityGraph';
import { DayActivitiesDialog } from './DayActivitiesDialog';
import { LifetimeSummary } from './LifetimeSummary';
import { MonthCalendar } from './MonthCalendar';

/**
 * The profile/dashboard view (1.5.0): a Strava-like period graph (7d/3m/1y)
 * of the recorded activities with a scrubbable readout, category filtering,
 * and a month calendar that taps through to each trail. Everything derives
 * from the library's TrackSummary index — pure aggregation in
 * `@core/dashboard/aggregate`, nothing persisted.
 */
export function DashboardScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const tracks = useLibraryStore((s) => s.tracks);
  const customCategories = useLibraryStore((s) => s.customCategories);

  const [period, setPeriod] = useState<DashboardPeriod>('7d');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  // The graph's selected bucket, counted FROM THE END (newest = 0) so the
  // default selection survives period switches without an effect. null =
  // "auto": the newest bucket WITH data (a fresh dashboard reading "No
  // activities" because today is empty was a terrible first impression),
  // falling back to the newest bucket.
  const [selectedFromEnd, setSelectedFromEnd] = useState<number | null>(null);
  const [categoryMenuOpen, setCategoryMenuOpen] = useState(false);
  // Frozen at mount: the aggregation window only shifts at midnight, and a
  // per-render Date.now() is impure under the render rules anyway.
  const [now] = useState(() => Date.now());
  const [visibleMonth, setVisibleMonth] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const [dayPick, setDayPick] = useState<CalendarDayEntry | null>(null);

  const buckets = useMemo(
    () => aggregateBuckets(tracks, period, now, categoryId),
    [tracks, period, now, categoryId],
  );
  const autoFromEnd = (() => {
    for (let i = buckets.length - 1; i >= 0; i--) {
      if (buckets[i]!.trackIds.length > 0) return buckets.length - 1 - i;
    }
    return 0;
  })();
  const selectedIndex = Math.max(0, buckets.length - 1 - (selectedFromEnd ?? autoFromEnd));
  const selected = buckets[selectedIndex];

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
  // Back-navigation floor: the month of the oldest matching track.
  const oldest = useMemo(
    () => (matching.length > 0 ? Math.min(...matching.map((t) => t.startedAt)) : now),
    [matching, now],
  );

  const accent = categoryColor(categoryId, customCategories) ?? theme.colors.primary;
  const selectedCategory = findCategory(categoryId, customCategories);
  const dim = theme.colors.onSurfaceVariant;

  const weeklyBuckets = period !== '7d';
  const bucketDateLabel = (startMs: number, endMs: number) => {
    if (!weeklyBuckets) {
      return new Date(startMs).toLocaleDateString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      });
    }
    const a = new Date(startMs);
    const b = new Date(endMs - 1);
    const aTxt = a.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const bTxt = b.toLocaleDateString(
      undefined,
      a.getMonth() === b.getMonth() ? { day: 'numeric' } : { month: 'short', day: 'numeric' },
    );
    return `${aTxt} – ${bTxt}`;
  };

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
    setVisibleMonth(({ year, month }) => {
      const d = new Date(year, month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });

  const onDayPress = (entry: CalendarDayEntry) => {
    if (entry.tracks.length === 1) router.push(`/trail3d/${entry.tracks[0]!.id}`);
    else setDayPick(entry);
  };
  const dayPickTracks = useMemo(() => {
    if (!dayPick) return [];
    const ids = new Set(dayPick.tracks.map((t) => t.id));
    return tracks.filter((t) => ids.has(t.id));
  }, [dayPick, tracks]);

  if (!hasAnyActivity) {
    return (
      <View style={[styles.empty, { paddingTop: insets.top }]}>
        <Icon source="chart-line-variant" size={48} color={dim} />
        <Text variant="titleMedium" style={styles.emptyTitle}>
          No activities yet
        </Text>
        <Text variant="bodyMedium" style={[styles.emptyBody, { color: dim }]}>
          Record a trail from the Map tab and it will show up here.
        </Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.fill}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 8 }]}
    >
      <Text variant="headlineSmall" style={styles.title}>
        Dashboard
      </Text>

      {/* Readout: the selected bucket's date, then distance · time · D+. */}
      <View style={styles.readout}>
        <Text variant="bodySmall" style={{ color: dim }}>
          {selected ? bucketDateLabel(selected.startMs, selected.endMs) : ''}
        </Text>
        {selected && selected.trackIds.length > 0 ? (
          <Text variant="titleMedium">
            <Text variant="titleMedium" style={{ color: accent }}>
              {formatDistance(selected.distanceM)}
            </Text>
            <Text variant="titleMedium" style={{ color: dim }}>
              {'  ·  '}
            </Text>
            <Text variant="titleMedium" style={{ color: accent }}>
              {selected.movingTimeS > 0 ? formatDuration(selected.movingTimeS) : '—'}
            </Text>
            <Text variant="titleMedium" style={{ color: dim }}>
              {'  ·  '}
            </Text>
            <Text variant="titleMedium" style={{ color: accent }}>
              ↑ {formatElevation(selected.ascentM)}
            </Text>
          </Text>
        ) : (
          <Text variant="titleMedium" style={{ color: dim }}>
            No activities
          </Text>
        )}
      </View>

      <ActivityGraph
        buckets={buckets}
        selectedIndex={selectedIndex}
        onSelect={(i) => setSelectedFromEnd(buckets.length - 1 - i)}
        accent={accent}
      />

      {/* Period bottom-left, category bottom-right. */}
      <View style={styles.selectorRow}>
        <SegmentedButtons
          value={period}
          onValueChange={(v) => {
            setPeriod(v as DashboardPeriod);
            setSelectedFromEnd(null);
          }}
          density="small"
          style={styles.periods}
          buttons={[
            { value: '7d', label: '7d', accessibilityLabel: 'Past 7 days' },
            { value: '3m', label: '3m', accessibilityLabel: 'Past 3 months' },
            { value: '1y', label: '1y', accessibilityLabel: 'Past year' },
          ]}
        />
        <Menu
          visible={categoryMenuOpen}
          onDismiss={() => setCategoryMenuOpen(false)}
          anchor={
            <Chip
              icon={selectedCategory?.icon ?? 'filter-variant'}
              compact
              onPress={() => setCategoryMenuOpen(true)}
              accessibilityLabel="Filter by category"
            >
              {selectedCategory?.name ?? 'All'}
            </Chip>
          }
        >
          <Menu.Item
            title="All"
            leadingIcon="filter-variant"
            onPress={() => {
              setCategoryId(null);
              setCategoryMenuOpen(false);
              setSelectedFromEnd(null);
            }}
          />
          {allCategories([...customCategories]).map((c) => (
            <Menu.Item
              key={c.id}
              title={c.name}
              leadingIcon={c.icon}
              onPress={() => {
                setCategoryId(c.id);
                setCategoryMenuOpen(false);
                setSelectedFromEnd(null);
              }}
            />
          ))}
        </Menu>
      </View>

      <MonthCalendar
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

      {/* Running totals for the same (category-filtered) set the graph and
          calendar show, with no 7d/3m/1y window. */}
      <LifetimeSummary tracks={matching} customCategories={customCategories} />

      <DayActivitiesDialog
        title={
          dayPick
            ? `Activities on ${new Date(visibleMonth.year, visibleMonth.month, dayPick.day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
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
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { paddingHorizontal: 16, paddingBottom: 24, gap: 12 },
  title: { fontWeight: '700' },
  readout: { minHeight: 52, gap: 2 },
  selectorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  periods: { maxWidth: 200 },
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
