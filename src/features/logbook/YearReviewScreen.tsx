import { heroDistance } from '@core/dashboard/logbook';
import { createFormatters, formatSpan } from '@core/format';
import { activityChips, statsTracks } from '@core/stats/periods';
import {
  dayOfYear,
  heatmapStrip,
  reviewYears,
  yearReview,
  type ReviewMetric,
} from '@core/stats/yearReview';
import { useDashboardClock } from '@features/dashboard/useDashboardClock';
import { useLibraryStore } from '@state/libraryStore';
import { useSettingsStore } from '@state/settingsStore';
import { HeaderContours } from '@ui/components/ContourTexture';
import { ScreenHeader } from '@ui/components/ScreenHeader';
import { tabularNums } from '@ui/fonts';
import { space, target } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { IconButton, Text, useTheme } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Rect, Text as SvgText } from 'react-native-svg';

import { ActivityChips, Segmented, StatsCard } from './StatsControls';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const METRICS: { value: ReviewMetric; label: string }[] = [
  { value: 'distance', label: 'Distance' },
  { value: 'time', label: 'Time' },
];

/**
 * Logbook › Year in review (owner-approved mockup, board 4): a year
 * selector, a calendar heatmap — one cell per day, Monday rows, four shades
 * by the day's distance or moving time, in a strip that scrolls sideways — and month-by-month distance bars
 * with the best month darker.
 */
export function YearReviewScreen() {
  const theme = useTheme();
  const tokens = useSchemeTokens();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const tracks = useLibraryStore((s) => s.tracks);
  const customCategories = useLibraryStore((s) => s.customCategories);
  const units = useSettingsStore((s) => s.units);
  const now = useDashboardClock();

  const performed = useMemo(() => statsTracks(tracks, null), [tracks]);
  const chips = useMemo(() => activityChips(performed), [performed]);
  const [activity, setActivity] = useState<string | null>(null);
  const effectiveActivity = activity !== null && chips.includes(activity) ? activity : null;
  const shown = useMemo(
    () => statsTracks(performed, effectiveActivity),
    [performed, effectiveActivity],
  );
  const years = useMemo(() => reviewYears(performed, now), [performed, now]);
  const [year, setYear] = useState(() => new Date(now).getFullYear());
  const [metric, setMetric] = useState<ReviewMetric>('distance');
  const review = useMemo(() => yearReview(shown, year, metric), [shown, year, metric]);

  const yearIndex = years.indexOf(year);
  const older = years[yearIndex + 1];
  const newer = yearIndex > 0 ? years[yearIndex - 1] : undefined;
  const total = heroDistance(review.totalDistanceM, units);
  const f = createFormatters(units);

  return (
    <View style={[styles.fill, { backgroundColor: theme.colors.background }]}>
      <HeaderContours />
      <View style={{ paddingTop: insets.top }}>
        <ScreenHeader title="Year in review" onBack={() => router.back()} />
      </View>
      <ScrollView
        style={styles.fill}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xl }]}
      >
        <View style={styles.yearRow}>
          <IconButton
            icon="chevron-left"
            disabled={older === undefined}
            onPress={() => older !== undefined && setYear(older)}
            accessibilityLabel={older !== undefined ? `Show ${older}` : 'No earlier year'}
            style={styles.yearButton}
          />
          <Text
            accessibilityRole="header"
            accessibilityLiveRegion="polite"
            style={[styles.year, tabularNums, { color: tokens.ink }]}
          >
            {year}
          </Text>
          <IconButton
            icon="chevron-right"
            disabled={newer === undefined}
            onPress={() => newer !== undefined && setYear(newer)}
            accessibilityLabel={newer !== undefined ? `Show ${newer}` : 'No later year'}
            style={styles.yearButton}
          />
        </View>
        <ActivityChips
          ids={chips}
          selected={effectiveActivity}
          onSelect={setActivity}
          customCategories={customCategories}
        />

        <View style={styles.summary}>
          <Summary value={`${total.value} ${total.unit}`} label="distance" />
          <Summary
            value={String(review.outings)}
            label={review.outings === 1 ? 'outing' : 'outings'}
          />
          <Summary value={String(review.activeDays)} label="active days" />
        </View>

        <StatsCard>
          <View style={styles.cardHead}>
            <Text accessibilityRole="header" style={[styles.title, { color: tokens.ink }]}>
              Every day
            </Text>
          </View>
          <Segmented value={metric} options={METRICS} onChange={setMetric} label="Shade by" />
          <CalendarHeatmap
            year={year}
            levels={review.levels}
            firstWeekday={review.firstWeekday}
            now={now}
            accessibilityLabel={`${year} calendar: ${review.activeDays} active days`}
          />
          <Legend />
          <Text style={[styles.hint, { color: tokens.inkMuted }]}>
            Shaded by each day’s {metric === 'distance' ? 'distance' : 'moving time'}, in four
            steps. Swipe for earlier months.
          </Text>
        </StatsCard>

        <StatsCard>
          <Text accessibilityRole="header" style={[styles.title, { color: tokens.ink }]}>
            Distance by month
          </Text>
          <MonthBars
            months={review.monthDistanceM}
            best={review.bestMonth}
            format={(m) => f.formatDistance(m)}
          />
          {review.bestMonth !== null && (
            <Text style={[styles.hint, tabularNums, { color: tokens.inkMuted }]}>
              Best month: {MONTHS[review.bestMonth]} ·{' '}
              {f.formatDistance(review.monthDistanceM[review.bestMonth] ?? 0)}
            </Text>
          )}
        </StatsCard>
        {metric === 'time' && review.outings > 0 && (
          <Text style={[styles.hint, { color: tokens.inkMuted }]}>
            Moving time this year: {formatSpan(review.days.reduce((a, b) => a + b, 0))}
          </Text>
        )}
      </ScrollView>
    </View>
  );
}

function Summary({ value, label }: { value: string; label: string }) {
  const tokens = useSchemeTokens();
  return (
    <View style={styles.summaryCell} accessible accessibilityLabel={`${value} ${label}`}>
      <Text
        numberOfLines={1}
        adjustsFontSizeToFit
        style={[styles.summaryValue, tabularNums, { color: tokens.ink }]}
      >
        {value}
      </Text>
      <Text style={[styles.summaryLabel, { color: tokens.inkMuted }]}>{label}</Text>
    </View>
  );
}

const GAP = 3;
const LABEL_H = 18;

/**
 * One cell per day in Monday-start week columns, as a horizontally scrollable
 * strip: about 26 weeks fill the card (so a day is a finger-readable square
 * rather than a speck), opening on the most recent weeks, with month names
 * above. Empty days carry a hairline so the grid reads on a dark card.
 */
function CalendarHeatmap({
  year,
  levels,
  firstWeekday,
  now,
  accessibilityLabel,
}: {
  year: number;
  levels: readonly number[];
  firstWeekday: number;
  now: number;
  accessibilityLabel: string;
}) {
  const theme = useTheme();
  const tokens = useSchemeTokens();
  const [width, setWidth] = useState(0);
  const scroller = useRef<ScrollView>(null);
  const { cell, contentWidth, offsetX } = heatmapStrip({
    year,
    firstWeekday,
    dayCount: levels.length,
    now,
    width,
    gap: GAP,
  });
  const height = LABEL_H + 7 * cell + 6 * GAP;
  const shades = [tokens.stats.dayEmpty, ...tokens.stats.dayShades];
  const monthStarts = MONTHS.map((_, m) =>
    Math.floor((firstWeekday + dayOfYear(new Date(year, m, 1).getTime(), year)) / 7),
  );
  // Open on the most recent weeks; again when the year (or the card) changes.
  useEffect(() => {
    if (width > 0) scroller.current?.scrollTo({ x: offsetX, animated: false });
  }, [width, offsetX, year]);
  return (
    <View
      accessible
      accessibilityLabel={accessibilityLabel}
      accessibilityHint="Scrolls sideways through the year"
      onLayout={(e: LayoutChangeEvent) => setWidth(Math.floor(e.nativeEvent.layout.width))}
      style={{ height: width > 0 ? height : 120 }}
    >
      {width > 0 && (
        <ScrollView
          ref={scroller}
          horizontal
          showsHorizontalScrollIndicator={false}
          contentOffset={{ x: offsetX, y: 0 }}
          testID="year-heatmap-strip"
        >
          <Svg width={contentWidth} height={height}>
            {monthStarts.map((col, m) => (
              <SvgText
                key={m}
                x={col * (cell + GAP)}
                y={12}
                fontSize={12}
                fontFamily={theme.fonts.bodySmall.fontFamily}
                fill={tokens.inkMuted}
              >
                {MONTHS[m]}
              </SvgText>
            ))}
            {levels.map((level, day) => {
              const slot = firstWeekday + day;
              const col = Math.floor(slot / 7);
              const row = slot % 7;
              const empty = level === 0;
              return (
                <Rect
                  key={day}
                  x={col * (cell + GAP) + (empty ? 0.5 : 0)}
                  y={LABEL_H + row * (cell + GAP) + (empty ? 0.5 : 0)}
                  width={cell - (empty ? 1 : 0)}
                  height={cell - (empty ? 1 : 0)}
                  rx={Math.min(3, cell / 4)}
                  fill={shades[level] ?? shades[0]}
                  stroke={empty ? tokens.stats.dayEmptyOutline : undefined}
                  strokeWidth={empty ? 1 : 0}
                />
              );
            })}
          </Svg>
        </ScrollView>
      )}
    </View>
  );
}

function Legend() {
  const tokens = useSchemeTokens();
  const shades = [tokens.stats.dayEmpty, ...tokens.stats.dayShades];
  return (
    <View
      style={styles.legend}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Text style={[styles.legendText, { color: tokens.inkMuted }]}>Less</Text>
      {shades.map((c, i) => (
        <View
          key={c}
          style={[
            styles.legendCell,
            { backgroundColor: c },
            i === 0 && { borderWidth: 1, borderColor: tokens.stats.dayEmptyOutline },
          ]}
        />
      ))}
      <Text style={[styles.legendText, { color: tokens.inkMuted }]}>More</Text>
    </View>
  );
}

const BAR_H = 96;

function MonthBars({
  months,
  best,
  format,
}: {
  months: readonly number[];
  best: number | null;
  format: (m: number) => string;
}) {
  const tokens = useSchemeTokens();
  const max = Math.max(1, ...months);
  return (
    <View style={styles.months}>
      {months.map((m, i) => {
        const h = m > 0 ? Math.max(3, (m / max) * BAR_H) : 2;
        return (
          <View
            key={i}
            style={styles.monthCol}
            accessible
            accessibilityLabel={`${MONTHS[i]}: ${format(m)}${i === best ? ', best month' : ''}`}
          >
            <View style={styles.monthTrack}>
              <View
                style={{
                  height: h,
                  borderRadius: 3,
                  backgroundColor: i === best ? tokens.stats.barCurrent : tokens.stats.bar,
                  opacity: m > 0 ? 1 : 0.5,
                }}
              />
            </View>
            <Text
              style={[
                styles.monthLabel,
                { color: i === best ? tokens.ink : tokens.inkMuted },
                i === best && styles.bold,
              ]}
            >
              {MONTHS[i]!.charAt(0)}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { paddingHorizontal: space.lg, paddingTop: 2, gap: 12 },
  yearRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  yearButton: { margin: 0, width: target.min, height: target.min },
  year: { fontSize: 24, lineHeight: 30, fontWeight: '800', minWidth: 72, textAlign: 'center' },
  summary: { flexDirection: 'row', gap: 8 },
  summaryCell: { flex: 1, minWidth: 0, alignItems: 'center' },
  summaryValue: { fontSize: 20, lineHeight: 26, fontWeight: '800' },
  summaryLabel: { fontSize: 12, lineHeight: 16 },
  cardHead: { flexDirection: 'row', alignItems: 'center' },
  title: { fontSize: 15, lineHeight: 20, fontWeight: '800' },
  hint: { fontSize: 12, lineHeight: 16 },
  legend: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-end' },
  legendCell: { width: 12, height: 12, borderRadius: 3 },
  legendText: { fontSize: 11, lineHeight: 14 },
  months: { flexDirection: 'row', alignItems: 'flex-end', gap: 4, height: BAR_H + 20 },
  monthCol: { flex: 1, alignItems: 'stretch', gap: 4 },
  monthTrack: { height: BAR_H, justifyContent: 'flex-end' },
  monthLabel: { fontSize: 11, lineHeight: 14, textAlign: 'center' },
  bold: { fontWeight: '800' },
});
