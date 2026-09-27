import type { ActivityBucket } from '@core/dashboard/aggregate';
import {
  bucketLabel,
  distanceUnitMeters,
  labelledBars,
  niceAxisMax,
  type ChartGranularity,
} from '@core/dashboard/logbook';
import type { Units } from '@core/format';
import { formatDistance } from '@state/formatters';
import { tabularNums } from '@ui/fonts';
import { radius, space } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useState } from 'react';
import { Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Text, useTheme } from 'react-native-paper';
import Svg, { Line, Rect, Text as SvgText } from 'react-native-svg';

/**
 * "Distance per week" (revamp `After-Logbook.html`): stone bars for the last
 * 12 weeks — or 12 months, or 5 years via the Week/Month/Year segment — with
 * the current bar in sage and labelled "Now". A 0 / half / nice-max axis sits
 * on the right. Tapping a bar selects it (sage) and the subtitle reads that
 * bar out; tapping it again returns to the period total.
 */

const CHART_H = 132;
/** Baseline of the bars; the x labels live below it. */
const BASE_Y = 110;
/** Right gutter for the y labels (board: 300 of 326). */
const AXIS_W = 26;
const LABEL_Y = 128;
const FONT = 12;

const GRANULARITIES: { value: ChartGranularity; label: string }[] = [
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'year', label: 'Year' },
];

const TITLE: Record<ChartGranularity, string> = {
  week: 'Distance per week',
  month: 'Distance per month',
  year: 'Distance per year',
};

const PERIOD: Record<ChartGranularity, (n: number) => string> = {
  week: (n) => `Last ${n} weeks`,
  month: (n) => `Last ${n} months`,
  year: (n) => `Last ${n} years`,
};

function axisNumber(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/** Readout name for one bar. */
function barName(startMs: number, granularity: ChartGranularity): string {
  if (granularity === 'week') return `Week of ${bucketLabel(startMs, 'week')}`;
  if (granularity === 'month') {
    return `${bucketLabel(startMs, 'month')} ${new Date(startMs).getFullYear()}`;
  }
  return bucketLabel(startMs, 'year');
}

export function DistanceChart({
  buckets,
  granularity,
  onGranularityChange,
  units,
}: {
  buckets: readonly ActivityBucket[];
  granularity: ChartGranularity;
  onGranularityChange: (g: ChartGranularity) => void;
  units: Units;
}) {
  const theme = useTheme();
  const tokens = useSchemeTokens();
  const [width, setWidth] = useState(0);
  // Counted from the newest bar so a selection means the same bar after the
  // clock rolls over; null = no selection (the period total).
  const [selectedFromEnd, setSelectedFromEnd] = useState<number | null>(null);
  const selectedIndex = selectedFromEnd === null ? null : buckets.length - 1 - selectedFromEnd;
  const selected = selectedIndex === null ? undefined : buckets[selectedIndex];

  const perUnit = distanceUnitMeters(units);
  const total = buckets.reduce((sum, b) => sum + b.distanceM, 0);
  const empty = buckets.every((b) => b.trackIds.length === 0);
  const top = niceAxisMax(Math.max(0, ...buckets.map((b) => b.distanceM / perUnit)));

  const subtitle =
    selected !== undefined
      ? `${barName(selected.startMs, granularity)} · ${formatDistance(selected.distanceM)}`
      : `${PERIOD[granularity](buckets.length)} · ${formatDistance(total)}`;

  const plotW = Math.max(0, width - AXIS_W);
  const slot = buckets.length > 0 ? plotW / buckets.length : 0;
  const barW = Math.min(28, slot * 0.72);
  const fontFamily = theme.fonts.bodySmall.fontFamily;
  const now = buckets.length - 1;

  const setGranularity = (g: ChartGranularity) => {
    setSelectedFromEnd(null);
    onGranularityChange(g);
  };

  return (
    <View
      style={[styles.card, { backgroundColor: tokens.surface, borderColor: tokens.outlineVariant }]}
    >
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text accessibilityRole="header" style={[styles.title, { color: tokens.ink }]}>
            {TITLE[granularity]}
          </Text>
          <Text
            numberOfLines={1}
            accessibilityLiveRegion="polite"
            style={[styles.subtitle, tabularNums, { color: tokens.inkMuted }]}
          >
            {subtitle}
          </Text>
        </View>
        <View
          accessibilityRole="radiogroup"
          accessibilityLabel="Period"
          style={[styles.segment, { backgroundColor: tokens.elevation.level3 }]}
        >
          {GRANULARITIES.map((g) => {
            const active = g.value === granularity;
            return (
              <Pressable
                key={g.value}
                onPress={() => setGranularity(g.value)}
                accessibilityRole="radio"
                accessibilityState={{ selected: active }}
                style={[styles.segmentButton, active && { backgroundColor: theme.colors.primary }]}
              >
                <Text
                  style={[
                    styles.segmentText,
                    { color: active ? theme.colors.onPrimary : tokens.ink },
                  ]}
                >
                  {g.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <View
        style={styles.plot}
        onLayout={(e: LayoutChangeEvent) => setWidth(Math.round(e.nativeEvent.layout.width))}
      >
        {width > 0 && (
          <Svg
            width={width}
            height={CHART_H}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            {[0.5, BASE_Y / 2 + 0.5, BASE_Y + 0.5].map((y) => (
              <Line
                key={y}
                x1={0}
                x2={plotW}
                y1={y}
                y2={y}
                stroke={tokens.divider}
                strokeWidth={1}
              />
            ))}
            {buckets.map((b, i) => {
              const h = Math.min(BASE_Y, (b.distanceM / perUnit / top) * BASE_Y);
              const zero = h < 2;
              const isHighlight = selectedIndex === null ? i === now : i === selectedIndex;
              return (
                <Rect
                  key={b.startMs}
                  x={i * slot + (slot - barW) / 2}
                  y={BASE_Y - (zero ? 2 : h)}
                  width={barW}
                  height={zero ? 2 : h}
                  rx={zero ? 1 : 3}
                  fill={isHighlight ? theme.colors.secondary : theme.colors.primary}
                />
              );
            })}
            <SvgText
              x={plotW + 6}
              y={4 + FONT * 0.8}
              fontSize={FONT}
              fontFamily={fontFamily}
              fill={tokens.inkMuted}
            >
              {axisNumber(top)}
            </SvgText>
            <SvgText
              x={plotW + 6}
              y={BASE_Y / 2 + FONT * 0.35}
              fontSize={FONT}
              fontFamily={fontFamily}
              fill={tokens.inkMuted}
            >
              {axisNumber(top / 2)}
            </SvgText>
            <SvgText
              x={plotW + 6}
              y={BASE_Y + FONT * 0.35}
              fontSize={FONT}
              fontFamily={fontFamily}
              fill={tokens.inkMuted}
            >
              0
            </SvgText>
            {labelledBars(buckets.length, granularity).map((i) => {
              const b = buckets[i];
              if (b === undefined) return null;
              return (
                <SvgText
                  key={b.startMs}
                  x={i * slot + (slot - barW) / 2}
                  y={LABEL_Y}
                  fontSize={FONT}
                  fontFamily={fontFamily}
                  fill={tokens.inkMuted}
                >
                  {bucketLabel(b.startMs, granularity)}
                </SvgText>
              );
            })}
            <SvgText
              x={now * slot + (slot + barW) / 2}
              y={LABEL_Y}
              fontSize={FONT}
              fontFamily={fontFamily}
              fontWeight="700"
              textAnchor="end"
              fill={theme.colors.secondary}
            >
              Now
            </SvgText>
          </Svg>
        )}
        {/* One tap target per bar, over the plot (the SVG itself is hidden
            from assistive tech; these carry the readout). */}
        <View style={[styles.hitRow, { width: plotW }]}>
          {buckets.map((b, i) => (
            <Pressable
              key={b.startMs}
              style={styles.hit}
              onPress={() =>
                setSelectedFromEnd(selectedIndex === i ? null : buckets.length - 1 - i)
              }
              accessibilityRole="button"
              accessibilityState={{ selected: selectedIndex === i }}
              accessibilityLabel={`${barName(b.startMs, granularity)}: ${formatDistance(b.distanceM)}`}
            />
          ))}
        </View>
        {empty && (
          <View style={[styles.emptyOverlay, { width: plotW }]} pointerEvents="none">
            <Text style={[styles.emptyText, { color: tokens.inkMuted }]}>No activities</Text>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    borderWidth: 1,
    paddingTop: space.md,
    paddingHorizontal: space.lg,
    paddingBottom: 10,
    gap: 6,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  headerText: { flex: 1, minWidth: 0 },
  title: { fontSize: 15, lineHeight: 20, fontWeight: '800' },
  subtitle: { fontSize: 12, lineHeight: 16 },
  segment: { flexDirection: 'row', borderRadius: radius.md, padding: 2 },
  segmentButton: {
    height: 44,
    borderRadius: 10,
    paddingHorizontal: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentText: { fontSize: 13, lineHeight: 18, fontWeight: '700' },
  plot: { height: CHART_H },
  hitRow: { position: 'absolute', left: 0, top: 0, height: BASE_Y, flexDirection: 'row' },
  hit: { flex: 1 },
  emptyOverlay: {
    position: 'absolute',
    left: 0,
    top: 0,
    height: BASE_Y,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyText: { fontSize: 14, lineHeight: 20, fontWeight: '700' },
});
