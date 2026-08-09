import {
  daySegments,
  formatTimelineLabel,
  isHourMark,
  type WeatherTimeline,
} from '@core/geo/weatherTimeline';
import { useMemo, useState } from 'react';
import { PanResponder, StyleSheet, View } from 'react-native';
import { IconButton, Text, useTheme } from 'react-native-paper';

/**
 * Bottom time scrubber (weather UX M1, the Windy idiom): visible whenever a
 * weather layer is draped. One draggable track spanning the layer's whole
 * timeline — the ~3 h radar past for radar layers, the ~48 h HRDPS forecast
 * for model layers — with hour ticks, taller day-boundary ticks + weekday
 * labels, a live "Sat 14:00" readout, and a play/pause head for the existing
 * animate flag. Scrubbing calls `onScrub` per move; the caller throttles the
 * actual WMS TIME swaps (see useWeatherTimeline).
 *
 * A plain themed View, not a paper Surface — the absolutely-positioned
 * Surface flex collapse on iOS (see WaypointViewerCard's note).
 *
 * M2 seam: the chevron at the far right is the reserved model-picker
 * affordance — a disabled placeholder until model-compare lands; pass
 * `onOpenModelPicker` then. The timeline prop itself is model-agnostic.
 */
export function WeatherTimeScrubber({
  timeline,
  selectedIdx,
  selectedMs,
  onScrub,
  playing,
  onTogglePlay,
  onOpenModelPicker,
}: {
  timeline: WeatherTimeline;
  selectedIdx: number;
  selectedMs: number | null;
  onScrub: (idx: number) => void;
  playing: boolean;
  onTogglePlay: () => void;
  onOpenModelPicker?: () => void;
}) {
  const theme = useTheme();
  const [trackWidth, setTrackWidth] = useState(0);
  const frames = timeline.framesMs;
  const n = frames.length;
  const segments = useMemo(() => daySegments(frames), [frames]);

  // Track geometry: the full timeline maps linearly onto the padded track.
  const innerWidth = Math.max(trackWidth - 2 * TRACK_PAD, 1);
  const xFor = (idx: number): number => TRACK_PAD + (idx / Math.max(n - 1, 1)) * innerWidth;

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (e) => {
          const ratio = (e.nativeEvent.locationX - TRACK_PAD) / innerWidth;
          onScrub(ratio * (n - 1));
        },
        onPanResponderMove: (e) => {
          const ratio = (e.nativeEvent.locationX - TRACK_PAD) / innerWidth;
          onScrub(ratio * (n - 1));
        },
      }),
    [innerWidth, n, onScrub],
  );

  const tickColor = theme.colors.onSurfaceVariant;

  return (
    <View
      style={[styles.bar, { backgroundColor: theme.colors.elevation.level2 }]}
      pointerEvents="auto"
    >
      <View style={styles.topRow}>
        <IconButton
          icon={playing ? 'pause' : 'play'}
          size={18}
          style={styles.headButton}
          onPress={onTogglePlay}
          accessibilityLabel={playing ? 'Pause weather timeline' : 'Play weather timeline'}
        />
        <Text variant="labelLarge">
          {selectedMs !== null ? formatTimelineLabel(selectedMs) : ''}
        </Text>
        <Text variant="labelSmall" style={[styles.kindHint, { color: tickColor }]}>
          {timeline.kind === 'past' ? 'Radar - past 3 h' : 'Forecast'}
        </Text>
        <View style={styles.spacer} />
        {/* M2 placeholder: the forecast-model picker affordance. Disabled
            until model-compare ships — visual seam only. */}
        <IconButton
          icon="chevron-up"
          size={18}
          style={styles.headButton}
          disabled={onOpenModelPicker === undefined}
          onPress={onOpenModelPicker}
          accessibilityLabel="Choose forecast model"
        />
      </View>
      <View
        style={styles.track}
        onLayout={(e) => setTrackWidth(e.nativeEvent.layout.width)}
        accessibilityLabel="Weather timeline"
        {...responder.panHandlers}
      >
        {trackWidth > 0 && (
          <>
            {/* Baseline */}
            <View style={[styles.baseline, { backgroundColor: tickColor }]} />
            {frames.map((ms, i) => {
              const dayStart = segments.some((s) => s.startIdx === i && s.startIdx > 0);
              const height = dayStart ? 16 : isHourMark(ms) ? 10 : 5;
              return (
                <View
                  key={ms}
                  style={[
                    styles.tick,
                    {
                      left: xFor(i) - 0.5,
                      height,
                      backgroundColor: tickColor,
                      opacity: dayStart ? 0.9 : 0.45,
                    },
                  ]}
                />
              );
            })}
            {/* Weekday labels at each day boundary (the first segment's day is
                already in the readout). */}
            {segments
              .filter((s) => s.startIdx > 0)
              .map((s) => (
                <Text
                  key={s.startIdx}
                  variant="labelSmall"
                  style={[styles.dayLabel, { left: xFor(s.startIdx) + 3, color: tickColor }]}
                >
                  {s.label}
                </Text>
              ))}
            {/* Selection head */}
            <View
              style={[
                styles.cursor,
                { left: xFor(selectedIdx) - 1, backgroundColor: theme.colors.primary },
              ]}
            />
            <View
              style={[
                styles.knob,
                { left: xFor(selectedIdx) - 5, backgroundColor: theme.colors.primary },
              ]}
            />
          </>
        )}
      </View>
    </View>
  );
}

const TRACK_PAD = 10;

const styles = StyleSheet.create({
  bar: { borderRadius: 14, paddingHorizontal: 8, paddingTop: 2, paddingBottom: 8 },
  topRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headButton: { margin: 0 },
  kindHint: { opacity: 0.8 },
  spacer: { flex: 1 },
  track: { height: 40, justifyContent: 'flex-end' },
  baseline: {
    position: 'absolute',
    left: TRACK_PAD,
    right: TRACK_PAD,
    bottom: 6,
    height: 1,
    opacity: 0.35,
  },
  tick: { position: 'absolute', bottom: 6, width: 1 },
  dayLabel: { position: 'absolute', top: 0, fontSize: 10, lineHeight: 12 },
  cursor: { position: 'absolute', bottom: 2, top: 12, width: 2, borderRadius: 1 },
  knob: { position: 'absolute', bottom: 20, width: 10, height: 10, borderRadius: 5 },
});
