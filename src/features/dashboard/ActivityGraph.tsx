import type { ActivityBucket } from '@core/dashboard/aggregate';
import { formatDistance } from '@lib/format';
import { useMemo, useState } from 'react';
import {
  PanResponder,
  StyleSheet,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from 'react-native';
import { useTheme } from 'react-native-paper';
import Svg, { Circle, Line, Polygon, Polyline, Rect, Text as SvgText } from 'react-native-svg';

/**
 * The dashboard's period graph: one circle per bucket (day or week), y =
 * distance normalized to the period's max. Unselected buckets are hollow;
 * the selected one is filled with a paler aura plus a full-height marker
 * line; activity days also fill a soft column down to the baseline. Distance
 * gridlines label the y axis in the left gutter; day/month labels run along
 * the x axis. Touch or drag snaps selection to the nearest bucket and — unlike
 * the elevation profile's transient scrub — the selection PERSISTS on release.
 */

const PLOT_HEIGHT = 150;
/** Band under the plot for the day / month x labels. */
const X_AXIS_H = 18;
/** Left gutter for the distance labels, clear of the plot. */
const AXIS_LEFT = 40;
/** Plot insets so aura circles and baseline dots never clip the card edge. */
const PAD_X = 14;
const PAD_TOP = 22;
const PAD_BOTTOM = 16;

/** Circle radius per bucket density (7 / 13 / 52 points across the width). */
function radiusFor(count: number): number {
  if (count <= 7) return 5;
  if (count <= 13) return 3.5;
  return 2;
}

/** Round-number distance gridlines below the period max (metres). */
function gridLevels(maxDistanceM: number): number[] {
  if (maxDistanceM <= 0) return [];
  const step = maxDistanceM / 3;
  const nice = 10 ** Math.floor(Math.log10(step));
  const inc = Math.max(nice, Math.ceil(step / nice) * nice);
  const out: number[] = [];
  for (let v = inc; v <= maxDistanceM; v += inc) out.push(v);
  return out.slice(0, 3);
}

export function ActivityGraph({
  buckets,
  selectedIndex,
  onSelect,
  accent,
}: {
  buckets: readonly ActivityBucket[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  accent: string;
}) {
  const theme = useTheme();
  const [width, setWidth] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  const r = radiusFor(buckets.length);
  const daily = buckets.length <= 7;
  const maxDistance = Math.max(...buckets.map((b) => b.distanceM), 1);
  const plotL = AXIS_LEFT + PAD_X;
  const plotR = width - PAD_X;
  const xFor = (i: number) =>
    buckets.length <= 1
      ? (plotL + plotR) / 2
      : plotL + (i / (buckets.length - 1)) * (plotR - plotL);
  const baseline = PLOT_HEIGHT - PAD_BOTTOM;
  const yFor = (b: ActivityBucket) =>
    baseline - (b.distanceM / maxDistance) * (PLOT_HEIGHT - PAD_TOP - PAD_BOTTOM);
  const yForDistance = (m: number) =>
    baseline - (m / maxDistance) * (PLOT_HEIGHT - PAD_TOP - PAD_BOTTOM);

  // Same responder recipe as ElevationProfile: claim the gesture and refuse to
  // yield so the parent ScrollView can't steal a drifting finger mid-drag.
  const pan = useMemo(() => {
    const pick = (e: GestureResponderEvent) => {
      if (width <= 0 || buckets.length === 0) return;
      const x = e.nativeEvent.locationX;
      const L = AXIS_LEFT + PAD_X;
      const span = buckets.length <= 1 ? width : (width - PAD_X - L) / (buckets.length - 1);
      const i = Math.round((x - L) / span);
      onSelect(Math.max(0, Math.min(buckets.length - 1, i)));
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onStartShouldSetPanResponderCapture: () => true,
      onMoveShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponderCapture: () => true,
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
      onPanResponderGrant: pick,
      onPanResponderMove: pick,
    });
  }, [width, buckets, onSelect]);

  const line = buckets.map((b, i) => `${xFor(i).toFixed(1)},${yFor(b).toFixed(1)}`).join(' ');
  const levels = gridLevels(maxDistance);
  const barW = Math.max(r * 1.6, daily ? 10 : buckets.length <= 13 ? 8 : 3);

  /**
   * X labels: daily periods label every day by day-of-month (month name on
   * the first and on month changes); weekly periods label the buckets where
   * the month changes (plus the first), by month name.
   */
  const xLabels: { i: number; text: string }[] = [];
  for (let i = 0; i < buckets.length; i++) {
    const d = new Date(buckets[i]!.startMs);
    const prev = i > 0 ? new Date(buckets[i - 1]!.startMs) : null;
    const monthChanged = prev === null || d.getMonth() !== prev.getMonth();
    if (daily) {
      xLabels.push({
        i,
        text: monthChanged
          ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
          : String(d.getDate()),
      });
    } else if (monthChanged) {
      xLabels.push({ i, text: d.toLocaleDateString(undefined, { month: 'short' }) });
    }
  }

  const dim = theme.colors.onSurfaceVariant;
  const selectedBucket =
    selectedIndex >= 0 && selectedIndex < buckets.length ? buckets[selectedIndex]! : null;

  return (
    <View
      style={[styles.chart, { backgroundColor: theme.colors.surfaceVariant }]}
      onLayout={onLayout}
      accessibilityLabel="Activity graph"
      {...pan.panHandlers}
    >
      {width > 0 && (
        <Svg width={width} height={PLOT_HEIGHT + X_AXIS_H}>
          {/* Distance gridlines, labelled in the left gutter. */}
          {levels.map((m) => (
            <Line
              key={`g${m}`}
              x1={AXIS_LEFT}
              y1={yForDistance(m)}
              x2={width}
              y2={yForDistance(m)}
              stroke={theme.colors.onSurface}
              strokeWidth={0.5}
              opacity={0.12}
            />
          ))}
          {levels.map((m) => (
            <SvgText
              key={`gl${m}`}
              x={AXIS_LEFT - 5}
              y={yForDistance(m) + 3}
              fontSize={9}
              fill={dim}
              textAnchor="end"
            >
              {formatDistance(m)}
            </SvgText>
          ))}
          <Line
            x1={AXIS_LEFT}
            y1={baseline}
            x2={width}
            y2={baseline}
            stroke={theme.colors.onSurface}
            strokeWidth={0.5}
            opacity={0.2}
          />

          {/* Selected bucket: full-height marker line behind everything. */}
          {selectedBucket && (
            <Line
              x1={xFor(selectedIndex)}
              y1={PAD_TOP - 12}
              x2={xFor(selectedIndex)}
              y2={baseline}
              stroke={accent}
              strokeWidth={3}
              strokeOpacity={0.35}
              strokeLinecap="round"
            />
          )}

          {/* The area under the trend line — the triangles the graph forms —
              filled softly, plus a slightly stronger column on activity days. */}
          {buckets.length >= 2 && (
            <Polygon
              points={`${line} ${xFor(buckets.length - 1).toFixed(1)},${baseline} ${xFor(0).toFixed(1)},${baseline}`}
              fill={accent}
              opacity={0.14}
            />
          )}
          {buckets.map((b, i) =>
            b.trackIds.length === 0 ? null : (
              <Rect
                key={`bar${b.startMs}`}
                x={xFor(i) - barW / 2}
                y={yFor(b)}
                width={barW}
                height={Math.max(0, baseline - yFor(b))}
                rx={barW / 3}
                fill={accent}
                opacity={0.16}
              />
            ),
          )}

          {/* Trend line under the circles so sparse periods still read. */}
          {buckets.length >= 2 && (
            <Polyline
              points={line}
              stroke={accent}
              strokeOpacity={0.3}
              strokeWidth={1}
              fill="none"
            />
          )}
          {buckets.map((b, i) =>
            i === selectedIndex ? null : (
              <Circle
                key={b.startMs}
                cx={xFor(i)}
                cy={yFor(b)}
                r={r}
                fill="none"
                stroke={accent}
                strokeWidth={1.5}
              />
            ),
          )}
          {/* Selected bucket drawn last so its aura sits above neighbours. */}
          {selectedBucket && (
            <>
              <Circle
                cx={xFor(selectedIndex)}
                cy={yFor(selectedBucket)}
                r={r * 2.2}
                fill={accent}
                opacity={0.22}
              />
              <Circle cx={xFor(selectedIndex)} cy={yFor(selectedBucket)} r={r} fill={accent} />
            </>
          )}

          {/* X labels: days (7d) or month starts (3m/1y). */}
          {xLabels.map(({ i, text }) => (
            <SvgText
              key={`x${i}`}
              x={xFor(i)}
              y={PLOT_HEIGHT + 12}
              fontSize={9}
              fill={dim}
              textAnchor={daily ? 'middle' : 'start'}
            >
              {text}
            </SvgText>
          ))}
        </Svg>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  chart: { height: PLOT_HEIGHT + X_AXIS_H, borderRadius: 10, overflow: 'hidden' },
});
