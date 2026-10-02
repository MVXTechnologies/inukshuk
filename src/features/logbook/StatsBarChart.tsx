import { distanceUnitMeters } from '@core/dashboard/logbook';
import type { Units } from '@core/format';
import { tightAxis } from '@core/stats/axis';
import type { StatsBar, StatsPeriod } from '@core/stats/periods';
import { formatDistance } from '@state/formatters';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Text, useTheme } from 'react-native-paper';
import Svg, { Line, Rect, Text as SvgText } from 'react-native-svg';

import { StatsCard } from './StatsControls';

/**
 * The Statistics bar chart, following the period: day by day (Week), week by
 * week over 12 weeks (Month), month by month (Year), year by year (All
 * time). Sage bars; the bar holding today is the darker sage. Distance, with
 * an axis on the right that hugs the tallest bar (`tightAxis`: 3 to 5 ticks).
 */

const CHART_H = 128;
/** The top tick's gridline; the plot runs from here down to BASE_Y. */
const TOP_Y = 6;
const BASE_Y = 104;
const AXIS_W = 28;
const LABEL_Y = 122;
const FONT = 11;

const TITLE: Record<StatsPeriod, string> = {
  week: 'This week, day by day',
  month: 'Last 12 weeks',
  year: 'This year, month by month',
  all: 'Year by year',
};

/** Which bars get an x label (the rest stay readable as a rhythm). */
function labelled(period: StatsPeriod, count: number, i: number): boolean {
  if (period === 'month') return i % 4 === 3 || i === count - 1;
  if (period === 'all' && count > 6) return (count - 1 - i) % 2 === 0;
  return true;
}

function axisNumber(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

export function StatsBarChart({
  bars,
  period,
  units,
}: {
  bars: readonly StatsBar[];
  period: StatsPeriod;
  units: Units;
}) {
  const theme = useTheme();
  const tokens = useSchemeTokens();
  const [width, setWidth] = useState(0);
  const perUnit = distanceUnitMeters(units);
  const axis = tightAxis(Math.max(0, ...bars.map((b) => b.distanceM / perUnit)));
  const top = axis.max;
  const plotH = BASE_Y - TOP_Y;
  const tickY = (v: number) => BASE_Y - (v / top) * plotH;
  const plotW = Math.max(0, width - AXIS_W);
  const slot = bars.length > 0 ? plotW / bars.length : 0;
  const barW = Math.min(26, slot * 0.66);
  const fontFamily = theme.fonts.bodySmall.fontFamily;
  const empty = bars.every((b) => b.count === 0);
  const spoken = bars
    .filter((b) => b.count > 0)
    .map((b) => `${b.label}: ${formatDistance(b.distanceM)}`)
    .join(', ');

  return (
    <StatsCard>
      <Text accessibilityRole="header" style={[styles.title, { color: tokens.ink }]}>
        {TITLE[period]}
      </Text>
      <View
        style={styles.plot}
        accessible
        accessibilityLabel={
          empty ? `${TITLE[period]}: no activities` : `${TITLE[period]}. ${spoken}`
        }
        onLayout={(e: LayoutChangeEvent) => setWidth(Math.round(e.nativeEvent.layout.width))}
      >
        {width > 0 && (
          <Svg width={width} height={CHART_H}>
            {axis.ticks.map((v) => (
              <Line
                key={v}
                x1={0}
                x2={plotW}
                y1={Math.round(tickY(v)) + 0.5}
                y2={Math.round(tickY(v)) + 0.5}
                stroke={tokens.divider}
                strokeWidth={1}
              />
            ))}
            {bars.map((b, i) => {
              const h = Math.min(plotH, (b.distanceM / perUnit / top) * plotH);
              const zero = h < 2;
              return (
                <Rect
                  key={b.startMs}
                  x={i * slot + (slot - barW) / 2}
                  y={BASE_Y - (zero ? 2 : h)}
                  width={barW}
                  height={zero ? 2 : h}
                  rx={zero ? 1 : 3}
                  fill={b.current ? tokens.stats.barCurrent : tokens.stats.bar}
                  opacity={zero && !b.current ? 0.5 : 1}
                />
              );
            })}
            {axis.ticks.map((v) => (
              <SvgText
                key={`t${v}`}
                x={plotW + 5}
                y={tickY(v) + FONT * 0.35}
                fontSize={FONT}
                fontFamily={fontFamily}
                fill={tokens.inkMuted}
              >
                {axisNumber(v)}
              </SvgText>
            ))}
            {bars.map((b, i) =>
              labelled(period, bars.length, i) ? (
                <SvgText
                  key={`l${b.startMs}`}
                  x={i * slot + slot / 2}
                  y={LABEL_Y}
                  fontSize={FONT}
                  fontFamily={fontFamily}
                  fontWeight={b.current ? '700' : '400'}
                  textAnchor="middle"
                  fill={b.current ? tokens.ink : tokens.inkMuted}
                >
                  {b.label}
                </SvgText>
              ) : null,
            )}
          </Svg>
        )}
        {empty && (
          <View style={[styles.emptyOverlay, { width: plotW }]} pointerEvents="none">
            <Text style={[styles.emptyText, { color: tokens.inkMuted }]}>No activities</Text>
          </View>
        )}
      </View>
      <Text style={[styles.unit, { color: tokens.inkMuted }]}>
        Distance, {units === 'imperial' ? 'mi' : 'km'}
      </Text>
    </StatsCard>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 15, lineHeight: 20, fontWeight: '800' },
  plot: { height: CHART_H },
  unit: { fontSize: 11, lineHeight: 14, textAlign: 'right' },
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
