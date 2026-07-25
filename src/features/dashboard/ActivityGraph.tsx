import type { ActivityBucket } from '@core/dashboard/aggregate';
import { useMemo, useState } from 'react';
import {
  PanResponder,
  StyleSheet,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from 'react-native';
import { useTheme } from 'react-native-paper';
import Svg, { Circle, Polyline } from 'react-native-svg';

/**
 * The dashboard's period graph: one circle per bucket (day or week), y =
 * distance normalized to the period's max. Unselected buckets are hollow;
 * the selected one is filled with a paler aura of the same accent (the
 * Strava-circle idiom the user asked for). Touch or drag snaps selection to
 * the nearest bucket and — unlike the elevation profile's transient scrub —
 * the selection PERSISTS on release, so the readout always describes a bucket.
 */

const GRAPH_HEIGHT = 150;
/** Plot insets so aura circles and baseline dots never clip the card edge. */
const PAD_X = 18;
const PAD_TOP = 22;
const PAD_BOTTOM = 16;

/** Circle radius per bucket density (7 / 13 / 52 points across the width). */
function radiusFor(count: number): number {
  if (count <= 7) return 5;
  if (count <= 13) return 3.5;
  return 2;
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
  const maxDistance = Math.max(...buckets.map((b) => b.distanceM), 1);
  const xFor = (i: number) =>
    buckets.length <= 1 ? width / 2 : PAD_X + (i / (buckets.length - 1)) * (width - 2 * PAD_X);
  const yFor = (b: ActivityBucket) =>
    GRAPH_HEIGHT - PAD_BOTTOM - (b.distanceM / maxDistance) * (GRAPH_HEIGHT - PAD_TOP - PAD_BOTTOM);

  // Same responder recipe as ElevationProfile: claim the gesture and refuse to
  // yield so the parent ScrollView can't steal a drifting finger mid-drag.
  const pan = useMemo(() => {
    const pick = (e: GestureResponderEvent) => {
      if (width <= 0 || buckets.length === 0) return;
      const x = e.nativeEvent.locationX;
      const span = buckets.length <= 1 ? width : (width - 2 * PAD_X) / (buckets.length - 1);
      const i = Math.round((x - PAD_X) / span);
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

  return (
    <View
      style={[styles.chart, { backgroundColor: theme.colors.surfaceVariant }]}
      onLayout={onLayout}
      accessibilityLabel="Activity graph"
      {...pan.panHandlers}
    >
      {width > 0 && (
        <Svg width={width} height={GRAPH_HEIGHT}>
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
          {selectedIndex >= 0 && selectedIndex < buckets.length && (
            <>
              <Circle
                cx={xFor(selectedIndex)}
                cy={yFor(buckets[selectedIndex]!)}
                r={r * 2.2}
                fill={accent}
                opacity={0.22}
              />
              <Circle
                cx={xFor(selectedIndex)}
                cy={yFor(buckets[selectedIndex]!)}
                r={r}
                fill={accent}
              />
            </>
          )}
        </Svg>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  chart: { height: GRAPH_HEIGHT, borderRadius: 10, overflow: 'hidden' },
});
