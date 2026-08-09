import {
  daySegments,
  formatTimelineLabel,
  isHourMark,
  type WeatherTimeline,
} from '@core/geo/weatherTimeline';
import { frameX, spacedIndices } from '@core/weather/modelTimeline';
import {
  displayedScrubIndex,
  dragIndexForPageX,
  SCRUB_DRAG_IDLE,
  scrubDragEnd,
  scrubDragMove,
  type ScrubDragState,
} from '@core/weather/scrubDrag';
import { useEffect, useMemo, useRef, useState } from 'react';
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
 * the chevron names the active model ("HRDPS 48 H"). While a drag is in
 * flight the thumb/chip follow LOCAL gesture state (see the drag block
 * below); `onScrub` commits exactly once on release, and the caller
 * throttles the actual WMS TIME swap (see useWeatherTimeline).
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

  // --- Drag state (wave A item 4, the snap-back fix) ---------------------
  // While a drag is in flight the thumb/chip follow LOCAL gesture state
  // exclusively; the committed selection (which the playback tick and the
  // throttled TIME refetch keep re-rendering) is ignored until release,
  // which commits exactly once. The old per-move `onScrub(locationX)` had
  // two failure modes seen in the field: RN reports `locationX` relative to
  // whichever CHILD view the touch is over — the accent chip rides the
  // selection, so the finger crossing it collapsed the x to a chip-local
  // value and the thumb snapped to the start — and the committed-state
  // display let every external update yank the thumb back to "now" mid-drag.
  // Pure logic in @core/weather/scrubDrag; position comes from the touch's
  // pageX against the track's measured window origin (child-independent).
  const [drag, setDrag] = useState<ScrubDragState>(SCRUB_DRAG_IDLE);
  const dragRef = useRef<ScrubDragState>(SCRUB_DRAG_IDLE);
  const trackRef = useRef<View>(null);
  const trackLeftRef = useRef(0);
  // Live geometry/callback mirrors so the PanResponder (created once) never
  // closes over stale values — recreating it mid-gesture drops the gesture.
  // Written from an effect, never during render (the propsRef idiom).
  const geomRef = useRef({ timeline, innerWidth });
  const onScrubRef = useRef(onScrub);
  useEffect(() => {
    geomRef.current = { timeline, innerWidth };
    onScrubRef.current = onScrub;
  });
  // A timeline re-key mid-drag (model swap tears the session down) must not
  // leave a stale drag showing: reset local drag state when the timeline
  // object is replaced. Timeout(0) keeps setState out of the effect body.
  useEffect(() => {
    const t = setTimeout(() => {
      if (dragRef.current.dragIdx !== null) {
        dragRef.current = SCRUB_DRAG_IDLE;
        setDrag(SCRUB_DRAG_IDLE);
      }
    }, 0);
    return () => clearTimeout(t);
  }, [timeline]);

  const measureTrack = () => {
    trackRef.current?.measureInWindow((x) => {
      trackLeftRef.current = x;
    });
  };

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

  // Created ONCE: every per-event value is read through refs, so the
  // responder is never recreated mid-gesture (which drops the gesture).
  // pageX (window space) instead of locationX — see the drag-state comment.
  // The initializer only CAPTURES the stable ref objects; every `.current`
  // access happens inside responder callbacks (never during render). Same
  // pattern as RangeSlider.
  // eslint-disable-next-line react-hooks/refs
  const [responder] = useState(() => {
    const moveTo = (pageX: number) => {
      const { timeline: tl, innerWidth: w } = geomRef.current;
      const idx = dragIndexForPageX(tl, pageX, trackLeftRef.current, TRACK_PAD, w);
      const next = scrubDragMove(dragRef.current, idx);
      if (next !== dragRef.current) {
        dragRef.current = next;
        setDrag(next);
      }
    };
    const end = () => {
      const { state: next, commitIdx } = scrubDragEnd(dragRef.current);
      dragRef.current = next;
      setDrag(next);
      if (commitIdx !== null) onScrubRef.current(commitIdx);
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      // Never hand the gesture to a parent mid-drag (map pan must not steal it).
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => {
        // Re-measure at grant: the dock can have moved (recording bar mounts,
        // keyboard insets) since the last layout pass.
        measureTrack();
        moveTo(e.nativeEvent.pageX);
      },
      onPanResponderMove: (e) => moveTo(e.nativeEvent.pageX),
      onPanResponderRelease: end,
      onPanResponderTerminate: end,
    });
  });

  // The rendered position: local drag while in flight, committed otherwise.
  const shownIdx = displayedScrubIndex(drag, selectedIdx, frames.length);
  const shownMs = drag.dragIdx !== null ? (frames[shownIdx] ?? selectedMs) : selectedMs;

  const cursorX = xFor(shownIdx);
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
        ref={trackRef}
        style={styles.track}
        onLayout={(e) => {
          setTrackWidth(e.nativeEvent.layout.width);
          measureTrack();
        }}
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
                {shownMs !== null ? formatTimelineLabel(shownMs) : ''}
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
