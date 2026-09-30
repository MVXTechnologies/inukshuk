import {
  contactLine,
  CYCLE_MS,
  landingAt,
  OP,
  PLAY_ONCE_END_MS,
  REF_HEIGHT,
  ROT,
  SETTLED_MS,
  sinceLanding,
  SPECK_OPACITY,
  SPECKS,
  STONE_ORDER,
  STONE_TRACKS,
  SX,
  SY,
  TX,
  TY,
  type Rect,
  type Speck,
} from '@core/anim/inukshukTimeline';
import { EASE_IN_OUT, sampleTrack, type Track } from '@core/anim/keyframes';
import { memo, useEffect, useId, useMemo } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from 'react-native-paper';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import Svg from 'react-native-svg';
import { StoneArt } from './InukshukGlyph';
import {
  FIGURE_H,
  FIGURE_W,
  nightTone,
  STONE_RECTS,
  STONES,
  type StoneShape,
} from './inukshukStones';

export interface InukshukLoaderProps {
  /** Height of the figure in dp (its width follows, ~0.9×). Default 96. */
  size?: number;
  /** Loop forever (default) or play once and hold the finished figure. */
  loop?: boolean;
  /** Announced by screen readers. Default 'Loading'. */
  accessibilityLabel?: string;
  testID?: string;
  /**
   * Stone colours: 'day' is the approved charcoal granite; 'night' lifts it so
   * it reads on dark surfaces. 'auto' (default) follows the Paper theme.
   */
  tone?: 'auto' | 'day' | 'night';
  style?: StyleProp<ViewStyle>;
}

/** Below this the dust specks are too small to read, so they are skipped. */
const DUST_MIN_SIZE = 64;
// The clip box around the figure: room for squash and dust at the sides, a
// little headroom for the drop to be seen, a sliver below for ground dust.
// Layout still only takes the figure's own size (the box overhangs it).
const PAD_X = 0.08;
const PAD_TOP = 0.25;
const PAD_BOTTOM = 0.05;

const PULSE_HALF_MS = CYCLE_MS / 2;
const PULSE_LOW = 0.55;

interface Placed extends Rect {
  shape: StoneShape;
}

interface PlacedSpeck {
  key: string;
  speck: Speck;
  landing: number;
  left: number;
  top: number;
  w: number;
  h: number;
}

/**
 * Marc's five granite stones drop into place, puff dust, hold, fade and loop
 * (3.4 s). One shared clock runs on the UI thread; every stone and speck is a
 * `useAnimatedStyle` sampling the pure timeline in `@core/anim`, so React
 * never re-renders per frame. With Reduce Motion on, the finished figure just
 * pulses its opacity, with no dust.
 */
export function InukshukLoader({
  size = 96,
  loop = true,
  accessibilityLabel = 'Loading',
  testID,
  tone = 'auto',
  style,
}: InukshukLoaderProps) {
  const reduceMotion = useReducedMotion();
  const theme = useTheme();
  const night = tone === 'night' || (tone === 'auto' && theme.dark);
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, '');

  const k = size / FIGURE_H;
  const unit = size / REF_HEIGHT; // spec px -> dp
  const figW = FIGURE_W * k;
  const padX = figW * PAD_X;
  const padTop = size * PAD_TOP;
  const showDust = !reduceMotion && size >= DUST_MIN_SIZE;

  const placed = useMemo<Placed[]>(
    () =>
      STONES.map((shape) => ({
        shape,
        x: padX + shape.x * k,
        y: padTop + shape.y * k,
        w: shape.w * k,
        h: shape.h * k,
      })),
    [k, padX, padTop],
  );

  const specks = useMemo<PlacedSpeck[]>(() => {
    if (!showDust) return [];
    // Specks never shrink below ~60 % of their reference size, so they still
    // read at the 96 dp default.
    const dim = Math.max(0.6, unit);
    return STONE_ORDER.flatMap((id) => {
      const line = contactLine(id, STONE_RECTS);
      return SPECKS.map((speck, i) => {
        const w = speck.w * dim;
        const h = speck.h * dim;
        const cx = padX + (speck.side === 'left' ? line.left : line.right) * k + speck.dx * unit;
        const cy = padTop + line.y * k + speck.dy * unit;
        return {
          key: `${id}-${i}`,
          speck,
          landing: landingAt(id),
          left: cx - w / 2,
          top: cy - h / 2,
          w,
          h,
        };
      });
    });
  }, [showDust, unit, padX, padTop, k]);

  const clock = useSharedValue(reduceMotion ? SETTLED_MS : 0);
  const pulse = useSharedValue(1);

  useEffect(() => {
    if (reduceMotion) {
      clock.set(SETTLED_MS);
      if (loop) {
        const easing = Easing.bezier(...EASE_IN_OUT);
        pulse.set(
          withRepeat(
            withSequence(
              withTiming(PULSE_LOW, { duration: PULSE_HALF_MS, easing }),
              withTiming(1, { duration: PULSE_HALF_MS, easing }),
            ),
            -1,
          ),
        );
      }
    } else {
      clock.set(0);
      clock.set(
        loop
          ? withRepeat(withTiming(CYCLE_MS, { duration: CYCLE_MS, easing: Easing.linear }), -1)
          : withTiming(PLAY_ONCE_END_MS, { duration: PLAY_ONCE_END_MS, easing: Easing.linear }),
      );
    }
    return () => {
      cancelAnimation(clock);
      cancelAnimation(pulse);
      pulse.set(1);
    };
  }, [reduceMotion, loop, clock, pulse]);

  const pulseStyle = useAnimatedStyle(() => ({ opacity: pulse.get() }));

  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      style={[{ width: figW, height: size }, style]}
    >
      <Animated.View
        pointerEvents="none"
        style={[
          styles.clip,
          { left: -padX, right: -padX, top: -padTop, bottom: -size * PAD_BOTTOM },
          pulseStyle,
        ]}
      >
        {placed.map((p) => (
          <Stone
            key={p.shape.id}
            placed={p}
            track={STONE_TRACKS[p.shape.id]}
            clock={clock}
            unit={unit}
            night={night}
            clipId={`ink-${uid}-${p.shape.id}`}
          />
        ))}
        {specks.map((s) => (
          <DustSpeck key={s.key} placed={s} clock={clock} unit={unit} />
        ))}
      </Animated.View>
    </View>
  );
}

const Stone = memo(function Stone({
  placed,
  track,
  clock,
  unit,
  night,
  clipId,
}: {
  placed: Placed;
  track: Track;
  clock: SharedValue<number>;
  unit: number;
  night: boolean;
  clipId: string;
}) {
  const { shape } = placed;
  const animated = useAnimatedStyle(() => {
    const t = clock.get();
    return {
      opacity: sampleTrack(track, t, OP),
      transform: [
        { translateX: sampleTrack(track, t, TX) * unit },
        { translateY: sampleTrack(track, t, TY) * unit },
        { rotate: `${sampleTrack(track, t, ROT)}deg` },
        { scaleX: sampleTrack(track, t, SX) },
        { scaleY: sampleTrack(track, t, SY) },
      ],
    };
  });
  const tint = night ? nightTone : identity;
  return (
    <Animated.View
      style={[
        styles.stone,
        { left: placed.x, top: placed.y, width: placed.w, height: placed.h },
        animated,
      ]}
    >
      <Svg width={placed.w} height={placed.h} viewBox={`0 0 ${shape.w} ${shape.h}`}>
        <StoneArt shape={shape} tint={tint} clipId={clipId} />
      </Svg>
    </Animated.View>
  );
});

function identity(c: string): string {
  return c;
}

function DustSpeck({
  placed,
  clock,
  unit,
}: {
  placed: PlacedSpeck;
  clock: SharedValue<number>;
  unit: number;
}) {
  const { speck, landing } = placed;
  const motion = speck.motion;
  const animated = useAnimatedStyle(() => {
    const local = sinceLanding(clock.get(), landing);
    return {
      opacity: sampleTrack(SPECK_OPACITY, local, 0),
      transform: [
        { translateX: sampleTrack(motion, local, 0) * unit },
        { translateY: sampleTrack(motion, local, 1) * unit },
        { scale: sampleTrack(motion, local, 2) },
      ],
    };
  });
  return (
    <Animated.View
      style={[
        styles.speck,
        {
          left: placed.left,
          top: placed.top,
          width: placed.w,
          height: placed.h,
          borderRadius: Math.max(placed.w, placed.h) / 2,
          backgroundColor: speck.color,
        },
        animated,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  clip: { position: 'absolute', overflow: 'hidden' },
  // CSS transform-origin: 50% 100% — each stone pivots and squashes on its
  // contact edge, so it never sinks into the stone below.
  stone: { position: 'absolute', transformOrigin: '50% 100%' },
  speck: { position: 'absolute', opacity: 0 },
});
