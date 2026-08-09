import {
  daySegments,
  formatTimelineLabel,
  isHourMark,
  nearestFrameIndex,
  type WeatherTimeline,
} from '@core/geo/weatherTimeline';
import { frameX, msForTrackRatio, spacedIndices } from '@core/weather/modelTimeline';
import { useMemo, useState } from 'react';
import { PanResponder, StyleSheet, View } from 'react-native';
import { IconButton, Text } from 'react-native-paper';
import { weatherChrome as wc } from './weatherChrome';

/**
 * Bottom time scrubber (weather UX M1, the Windy idiom): one floating dark
 * translucent pill over the map — round white play disc at the left, a thin
 * tick track with a floating accent time chip ("Sat 14:00", pointer tail)
 * riding the selection, small-caps day labels at day boundaries, and the
 * model-picker chevron at the far right. Radar layers scrub their ~3 h past
 * window, model layers the model's forecast horizon; the micro caption by
 * the chevron names the active model ("HRDPS 48 H"). Scrubbing calls
 * `onScrub` per move; the caller throttles the actual WMS TIME swaps (see
 * useWeatherTimeline).
 *
 * M2: track geometry is linear in TIME, not frame index — GDPS's 1 h → 3 h
 * cadence change shows as wider tick spacing on the 3-hourly tail, and dense
 * heads are thinned to a minimum pixel gap (`spacedIndices`) so long
 * timelines stay readable. Even timelines render identically to M1.
 *
 * Fixed dark chrome in BOTH themes (see weatherChrome.ts — the edgePill
 * precedent), and a plain View, not a paper Surface (the absolutely-
 * positioned Surface flex collapse on iOS).
 */
export function WeatherTimeScrubber({
  timeline,
  selectedIdx,
  selectedMs,
  onScrub,
  playing,
  onTogglePlay,
  onOpenModelPicker,
  modelPickerOpen = false,
  modelCaption,
}: {
  timeline: WeatherTimeline;
  selectedIdx: number;
  selectedMs: number | null;
  onScrub: (idx: number) => void;
  playing: boolean;
  onTogglePlay: () => void;
  onOpenModelPicker?: () => void;
  /** Flips the chevron while the model sheet is up (label stays stable). */
  modelPickerOpen?: boolean;
  /** Micro caption by the chevron, e.g. "HRDPS 48 H"; falls back to kind. */
  modelCaption?: string;
}) {
  const [trackWidth, setTrackWidth] = useState(0);
  const frames = timeline.framesMs;
  const segments = useMemo(() => daySegments(frames), [frames]);

  // Track geometry: the timeline maps linearly onto the padded track in
  // TIME (uneven GDPS steps land where their time says, not their index).
  const innerWidth = Math.max(trackWidth - 2 * TRACK_PAD, 1);
  const xFor = (idx: number): number => TRACK_PAD + frameX(frames, idx, innerWidth);

  // Hour-mark tick candidates, thinned to a minimum pixel gap so the GDPS
  // hourly head (85 frames) reads as a fine comb, not a smear. Day-boundary
  // ticks always survive the thinning (their labels need an anchor).
  const ticks = useMemo(() => {
    const candidates: { idx: number; x: number }[] = [];
    for (let i = 0; i < frames.length; i++) {
      const ms = frames[i];
      if (ms === undefined || !isHourMark(ms)) continue;
      candidates.push({ idx: i, x: frameX(frames, i, innerWidth) });
    }
    const kept = new Set(
      spacedIndices(
        candidates.map((c) => c.x),
        MIN_TICK_GAP,
      ).map((i) => candidates[i]?.idx ?? 0),
    );
    for (const s of segments) if (s.startIdx > 0) kept.add(s.startIdx);
    return [...kept].sort((a, b) => a - b);
  }, [frames, innerWidth, segments]);

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (e) => {
          const ratio = (e.nativeEvent.locationX - TRACK_PAD) / innerWidth;
          onScrub(nearestFrameIndex(timeline, msForTrackRatio(frames, ratio)));
        },
        onPanResponderMove: (e) => {
          const ratio = (e.nativeEvent.locationX - TRACK_PAD) / innerWidth;
          onScrub(nearestFrameIndex(timeline, msForTrackRatio(frames, ratio)));
        },
      }),
    [innerWidth, frames, timeline, onScrub],
  );

  const cursorX = xFor(selectedIdx);
  const chipLeft = Math.max(0, Math.min(cursorX - CHIP_W / 2, Math.max(trackWidth - CHIP_W, 0)));

  return (
    <View style={styles.bar} pointerEvents="auto">
      <IconButton
        icon={playing ? 'pause' : 'play'}
        size={20}
        style={styles.playDisc}
        iconColor={wc.onPlayDisc}
        onPress={onTogglePlay}
        accessibilityLabel={playing ? 'Pause weather timeline' : 'Play weather timeline'}
      />
      <View
        style={styles.track}
        onLayout={(e) => setTrackWidth(e.nativeEvent.layout.width)}
        accessibilityLabel="Weather timeline"
        {...responder.panHandlers}
      >
        {trackWidth > 0 && (
          <>
            <View style={styles.baseline} />
            {/* Hour ticks (density-guarded); day boundaries get a taller
                tick + small-caps label. */}
            {ticks.map((i) => {
              const dayStart = segments.some((s) => s.startIdx === i && s.startIdx > 0);
              return (
                <View
                  key={frames[i] ?? i}
                  style={[dayStart ? styles.dayTick : styles.hourTick, { left: xFor(i) - 0.5 }]}
                />
              );
            })}
            {segments
              .filter((s) => s.startIdx > 0)
              .map((s) => (
                <Text key={s.startIdx} style={[styles.dayLabel, { left: xFor(s.startIdx) + 4 }]}>
                  {s.label.toUpperCase()}
                </Text>
              ))}
            {/* Selection: accent cursor + the floating time chip with tail. */}
            <View style={[styles.cursor, { left: cursorX - 1 }]} />
            <View style={[styles.chipTail, { left: cursorX - 4 }]} />
            <View style={[styles.chip, { left: chipLeft }]}>
              <Text style={styles.chipText} numberOfLines={1}>
                {selectedMs !== null ? formatTimelineLabel(selectedMs) : ''}
              </Text>
            </View>
          </>
        )}
      </View>
      <View style={styles.rightRail}>
        <Text style={styles.kindHint} numberOfLines={1}>
          {modelCaption ?? (timeline.kind === 'past' ? 'PAST 3 H' : 'FORECAST')}
        </Text>
        {/* M2: the forecast-model picker. Faint + inert for model-less
            (radar) timelines; the a11y label never changes (Maestro). */}
        <IconButton
          icon={modelPickerOpen ? 'chevron-down' : 'chevron-up'}
          size={18}
          style={styles.chevron}
          iconColor={onOpenModelPicker === undefined ? wc.inkFaint : wc.ink}
          onPress={onOpenModelPicker}
          accessibilityState={{ disabled: onOpenModelPicker === undefined }}
          accessibilityLabel="Choose forecast model"
        />
      </View>
    </View>
  );
}

const TRACK_PAD = 8;
const CHIP_W = 84;
/** Minimum px between minor ticks before thinning kicks in. */
const MIN_TICK_GAP = 3;

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: wc.panel,
    borderRadius: 27,
    paddingVertical: 6,
    paddingLeft: 8,
    paddingRight: 4,
  },
  playDisc: {
    margin: 0,
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: wc.playDisc,
  },
  track: { flex: 1, height: 54 },
  baseline: {
    position: 'absolute',
    left: TRACK_PAD,
    right: TRACK_PAD,
    bottom: 8,
    height: 2,
    borderRadius: 1,
    backgroundColor: wc.hairline,
  },
  hourTick: { position: 'absolute', bottom: 8, width: 1, height: 6, backgroundColor: wc.inkFaint },
  dayTick: { position: 'absolute', bottom: 8, width: 1, height: 13, backgroundColor: wc.inkMuted },
  dayLabel: {
    position: 'absolute',
    bottom: 22,
    fontSize: 9,
    lineHeight: 11,
    letterSpacing: 0.8,
    color: wc.inkMuted,
  },
  cursor: {
    position: 'absolute',
    bottom: 4,
    height: 22,
    width: 2,
    borderRadius: 1,
    backgroundColor: wc.accent,
  },
  chip: {
    position: 'absolute',
    top: 0,
    width: CHIP_W,
    height: 22,
    borderRadius: 11,
    backgroundColor: wc.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipTail: {
    position: 'absolute',
    top: 17,
    width: 8,
    height: 8,
    borderRadius: 1.5,
    backgroundColor: wc.accent,
    transform: [{ rotate: '45deg' }],
  },
  chipText: {
    fontSize: 12,
    lineHeight: 15,
    fontWeight: '700',
    color: wc.onAccent,
    fontVariant: ['tabular-nums'],
  },
  rightRail: { alignItems: 'center', maxWidth: 64 },
  kindHint: { fontSize: 8, lineHeight: 10, letterSpacing: 0.6, color: wc.inkFaint },
  chevron: { margin: 0, width: 28, height: 24 },
});
