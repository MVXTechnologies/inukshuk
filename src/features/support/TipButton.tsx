import { nextFactIndex } from '@core/support/funFacts';
import {
  BUBBLE_CHECK_MS,
  bubbleDue,
  COFFEE_PHASES,
  DEFAULT_TIP_BUTTON_VARIANT,
  MASCOT_FACE_MS,
  MASCOT_FACE_PHASES,
  MUG_LAYOUT,
  mugPaths,
  TIP_BUTTON_MOTION,
  TIP_JAR_WOBBLE_INTERVAL_MS,
  tipJarAnimates,
  tipJarVisible,
  type TipButtonVariant,
} from '@core/support/tipJar';
import { useRecorderStore } from '@state/recorderStore';
import { useSettingsStore } from '@state/settingsStore';
import { useSupportStore } from '@state/supportStore';
import { useTipMascotStore } from '@state/tipMascotStore';
import { palette, space, target, type SchemeTokens } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { AppState, Pressable, StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';
import Animated, {
  cancelAnimation,
  Easing,
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

/**
 * The tip button, bottom-right of the Map only (#476). Opens Support
 * Inukshuk at "Leave a tip".
 *
 * Five looks from the owner's mockup, one component: `variant` picks the icon
 * and its animation; the default (`DEFAULT_TIP_BUTTON_VARIANT`, the coffee
 * mug) lives in `@core/support/tipJar` with every timing, so choosing is a
 * one-line change.
 *
 * - The loop: one short scene every 7 s; none with the OS "reduce motion"
 *   setting or after a tip; held (a tick is skipped, the schedule kept)
 *   while the person pans or zooms, while the Map tab is not in front and
 *   while the app is in the background.
 * - The mascot (round 4): about once a minute, when `bubbleDue` allows, the
 *   mug shows a face and the Map's `TipBubble` pops a fun fact. This
 *   component decides and animates the face; the bubble is drawn by the Map
 *   at its root (so it can be tapped on Android) from `tipMascotStore`.
 * - Hidden while recording, following a destination, when the map's corner
 *   is taken, when switched off in Settings, and for 12 months after a tip or
 *   a verified "I already donated". Long-press offers "Hide".
 */
export function TipButton({
  variant = DEFAULT_TIP_BUTTON_VARIANT,
  navigating = false,
  blocked = false,
  bubbleBlocked = false,
  paused = false,
  focused = true,
  onAnimate,
  intervalMs = TIP_JAR_WOBBLE_INTERVAL_MS,
  bubbleCheckMs = BUBBLE_CHECK_MS,
  clock = Date.now,
}: {
  variant?: TipButtonVariant;
  navigating?: boolean;
  /** Something owns the corner: the button hides. */
  blocked?: boolean;
  /** A sheet, dialog, menu or search is open: no bubble (the button stays). */
  bubbleBlocked?: boolean;
  /** The person is panning or zooming the map. */
  paused?: boolean;
  /** The Map tab is in front. */
  focused?: boolean;
  /** Test hooks: called at each loop scene; the loop and bubble-check periods; the clock. */
  onAnimate?: () => void;
  intervalMs?: number;
  bubbleCheckMs?: number;
  clock?: () => number;
}) {
  const router = useRouter();
  const t = useSchemeTokens();
  const enabled = useSettingsStore((s) => s.showTipJar);
  const restingUntil = useSettingsStore((s) => s.tipJarRestingUntil);
  const setSetting = useSettingsStore((s) => s.set);
  const recording = useRecorderStore((s) => s.status !== 'idle');
  const hasTipped = useSupportStore((s) => s.tipCount > 0);
  const bubbleUp = useTipMascotStore((s) => s.bubbleFact !== null);
  const reduceMotion = useReducedMotion();
  const [menuOpen, setMenuOpen] = useState(false);
  // Mount time: the 12-month window, and "the Map opened" for the bubble.
  const [openedAt] = useState(clock);
  const steps = TIP_BUTTON_MOTION[variant];
  const rest = steps[steps.length - 1]?.to ?? 0;
  const progress = useSharedValue(rest);
  const face = useSharedValue(0);
  const faceOn = useSharedValue(0);
  const onAnimateRef = useRef(onAnimate);
  useEffect(() => {
    onAnimateRef.current = onAnimate;
  }, [onAnimate]);

  // Backgrounded apps don't animate (and resume on return).
  const [foreground, setForeground] = useState(AppState.currentState !== 'background');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setForeground(s === 'active'));
    return () => sub.remove();
  }, []);

  const visible = tipJarVisible({
    enabled,
    recording,
    navigating,
    blocked,
    restingUntil,
    now: openedAt,
  });
  const animates = visible && tipJarAnimates({ reduceMotion, hasTipped });
  const active = focused && foreground;
  const held = paused || !active;
  const heldRef = useRef(held);
  useEffect(() => {
    heldRef.current = held;
  }, [held]);

  // When the person's last map gesture ended (for the 5 s calm before a bubble).
  const lastGestureEndAt = useRef<number | null>(null);
  const wasPaused = useRef(paused);
  useEffect(() => {
    if (wasPaused.current && !paused) lastGestureEndAt.current = clock();
    wasPaused.current = paused;
  }, [paused, clock]);

  // Holding (a pan or zoom, another tab, the background) stops a scene at
  // once and puts the icon back at rest — without touching the loop's
  // schedule, so a burst of short pans cannot keep postponing it forever.
  useEffect(() => {
    if (!held) return;
    cancelAnimation(progress);
    progress.set(rest);
  }, [held, progress, rest]);

  // The loop: one JS timer per scene (every 7 s); the scene itself runs on
  // the UI thread. A tick that lands while held is simply skipped.
  useEffect(() => {
    if (!animates) {
      cancelAnimation(progress);
      progress.set(rest);
      return;
    }
    const timer = setInterval(() => {
      if (heldRef.current) return;
      const [first, ...others] = steps.map((step) =>
        withTiming(step.to, {
          duration: step.ms,
          easing: step.easing === 'linear' ? Easing.linear : Easing.inOut(Easing.quad),
        }),
      );
      if (first !== undefined) progress.set(withSequence(first, ...others));
      onAnimateRef.current?.();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [animates, intervalMs, progress, rest, steps]);

  // The mascot bubble: a cheap 1 s check against `bubbleDue`. Thanked people
  // (who have tipped before) are not nudged, so they get no bubble either.
  const mayBubble = visible && !hasTipped;
  const bubbleInputs = useRef({ active, bubbleBlocked, paused, mayBubble });
  useEffect(() => {
    bubbleInputs.current = { active, bubbleBlocked, paused, mayBubble };
  }, [active, bubbleBlocked, paused, mayBubble]);
  useEffect(() => {
    if (!mayBubble) return;
    const timer = setInterval(() => {
      const store = useTipMascotStore.getState();
      if (store.bubbleFact !== null) return;
      const input = bubbleInputs.current;
      const now = clock();
      const due = bubbleDue({
        now,
        buttonVisible: input.mayBubble,
        active: input.active,
        blocked: input.bubbleBlocked,
        gestureActive: input.paused,
        lastGestureEndAt: lastGestureEndAt.current,
        mapOpenedAt: openedAt,
        lastBubbleAt: store.lastBubbleAt,
        snoozed: store.snoozed,
      });
      if (due) store.show(nextFactIndex(store.lastFact), now);
    }, bubbleCheckMs);
    return () => clearInterval(timer);
  }, [mayBubble, bubbleCheckMs, clock, openedAt]);

  // A bubble never outlives the conditions that allowed it.
  useEffect(() => {
    if (bubbleUp && (!mayBubble || !active || bubbleBlocked || paused)) {
      useTipMascotStore.getState().hide();
    }
  }, [bubbleUp, mayBubble, active, bubbleBlocked, paused]);

  // The face: eyes, a blink, then happy arcs while the bubble is up. Reduce
  // motion: no face at all (the bubble still appears).
  useEffect(() => {
    if (bubbleUp && !reduceMotion) {
      face.set(0);
      faceOn.set(1);
      face.set(withTiming(1, { duration: MASCOT_FACE_MS, easing: Easing.linear }));
    } else {
      cancelAnimation(face);
      faceOn.set(withTiming(0, { duration: reduceMotion ? 0 : 200 }));
    }
  }, [bubbleUp, reduceMotion, face, faceOn]);

  useEffect(() => {
    if (!menuOpen) return;
    const timer = setTimeout(() => setMenuOpen(false), 5000);
    return () => clearTimeout(timer);
  }, [menuOpen]);

  if (!visible) return null;
  const look = LOOKS[variant];

  return (
    <View style={styles.row} pointerEvents="box-none">
      {menuOpen && (
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            setMenuOpen(false);
            setSetting('showTipJar', false);
          }}
          style={({ pressed }) => [
            styles.hide,
            { backgroundColor: t.surface, borderColor: t.outlineVariant },
            pressed && styles.pressed,
          ]}
        >
          <Text style={[styles.hideLabel, { color: t.ink }]}>Hide tip button</Text>
        </Pressable>
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Support Inukshuk"
        accessibilityHint="Opens the tip jar. Long-press to hide."
        onPress={() => {
          setMenuOpen(false);
          useTipMascotStore.getState().hide();
          router.push({ pathname: '/support', params: { from: 'jar' } });
        }}
        onLongPress={() => setMenuOpen(true)}
        style={({ pressed }) => [
          styles.button,
          { backgroundColor: look.background(t) },
          pressed && styles.pressed,
        ]}
        testID={`tip-button-${variant}`}
      >
        <look.Glyph t={t} p={progress} f={face} faceOn={faceOn} />
      </Pressable>
    </View>
  );
}

interface GlyphProps {
  t: SchemeTokens;
  p: SharedValue<number>;
  /** Mascot face progress (0 → 1) and visibility (0/1); the coffee mug uses them. */
  f: SharedValue<number>;
  faceOn: SharedValue<number>;
}

/** 1 · A jar with a coin; the whole jar wobbles (p = degrees). */
function JarCoin({ t, p }: GlyphProps) {
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${p.value}deg` }] }));
  return (
    <Animated.View style={style}>
      <Svg width={26} height={26} viewBox="0 0 24 24" fill="none">
        <Path
          d="M8 3h8M9 3v2.5C6.5 6.5 5.5 8.5 5.5 11v6.5A3.5 3.5 0 009 21h6a3.5 3.5 0 003.5-3.5V11c0-2.5-1-4.5-3.5-5.5V3"
          stroke={t.support.onAccent}
          strokeWidth={1.9}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <Circle cx={12} cy={14} r={2.6} stroke={t.support.onAccent} strokeWidth={1.9} />
      </Svg>
    </Animated.View>
  );
}

/** 2 · A gold coin drops onto three stones (p: 0 → 0.7 lands → 1 fades). */
function CairnCoin({ t, p }: GlyphProps) {
  const coin = useAnimatedStyle(() => ({
    opacity: interpolate(p.value, [0, 0.05, 0.85, 1], [0, 1, 1, 0]),
    transform: [{ translateY: interpolate(p.value, [0, 0.7, 1], [-14, 3, 3]) }],
  }));
  return (
    <View style={styles.glyphBox}>
      <Svg width={28} height={28} viewBox="0 0 24 24">
        <Rect x={5} y={15} width={14} height={4.5} rx={2} fill={t.support.cairnLight} />
        <Rect x={7} y={11} width={10} height={4} rx={1.8} fill={t.support.cairnMid} />
        <Rect x={9} y={7.5} width={6} height={3.5} rx={1.5} fill={t.support.cairnLight} />
      </Svg>
      <Animated.View style={[styles.coin, { backgroundColor: t.support.coin }, coin]} />
    </View>
  );
}

/** 3 · A granite heart that beats twice (p = scale). */
function StoneHeart({ t, p }: GlyphProps) {
  const style = useAnimatedStyle(() => ({ transform: [{ scale: p.value }] }));
  return (
    <Animated.View style={style}>
      <Svg width={26} height={26} viewBox="0 0 24 24">
        <Path
          d="M12 20.5c-1.2-.9-8-5.4-8-10.6A4.3 4.3 0 0112 7.6a4.3 4.3 0 018 2.3c0 5.2-6.8 9.7-8 10.6z"
          fill={t.support.stone}
        />
        <Path
          d="M7 9.5l2.5-1.2M13.5 11.5l3-1.5M9 14l2.2 1"
          stroke={t.support.stoneDeep}
          strokeWidth={1.1}
          strokeLinecap="round"
        />
      </Svg>
    </Animated.View>
  );
}

/**
 * 4 · Coffee at the trailhead (owner's pick). The loop scene (p: 0 → 1): two
 * thick, soft smoke puffs swell, drift up and fade, then a heart rises out of
 * the mug and fades. With the mascot bubble up the mug gets a face: two oval
 * eyes appear, blink, then close into happy arcs with a small smile.
 */
function CoffeeSteam({ t, p, f, faceOn }: GlyphProps) {
  const ink = t.support.onAccent;
  return (
    <View style={styles.glyphBox}>
      <Svg
        width={MUG_LAYOUT.box}
        height={MUG_LAYOUT.box}
        viewBox={`0 0 ${MUG_LAYOUT.box} ${MUG_LAYOUT.box}`}
        fill="none"
      >
        <Path
          d={MUG_PATHS.cup}
          stroke={ink}
          strokeWidth={MUG_LAYOUT.stroke}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Svg>
      {COFFEE_PHASES.puffs.map((window, i) => (
        <SmokePuff key={i} p={p} window={window} index={i} ink={ink} />
      ))}
      <RisingHeart p={p} ink={ink} />
      <MugFace f={f} on={faceOn} ink={ink} />
    </View>
  );
}

/** The mug and face outlines, built once from {@link MUG_LAYOUT}. */
const MUG_PATHS = mugPaths();

/**
 * One soft smoke puff: a rounded blob that swells, drifts up with a slight
 * wobble and fades — no thin squiggles (owner, round 4).
 */
function SmokePuff({
  p,
  window,
  index,
  ink,
}: {
  p: SharedValue<number>;
  window: readonly [number, number];
  index: number;
  ink: string;
}) {
  const [from, to] = window;
  const side = index === 0 ? -1 : 1;
  const style = useAnimatedStyle(() => {
    const c = p.value;
    if (c <= from || c >= to) return { opacity: 0 };
    const local = (c - from) / (to - from);
    return {
      opacity: 0.9 * interpolate(local, [0, 0.25, 0.7, 1], [0, 1, 0.7, 0], Extrapolation.CLAMP),
      transform: [
        { translateY: 3 - local * 11 },
        {
          translateX:
            side *
            (local * MUG_LAYOUT.puff.drift +
              Math.sin(local * 2 * Math.PI) * MUG_LAYOUT.puff.wobble),
        },
        { scale: interpolate(local, [0, 1], [0.55, 1.3], Extrapolation.CLAMP) },
      ],
    };
  });
  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.puff, { left: MUG_LAYOUT.puff.left, backgroundColor: ink }, style]}
      testID="tip-smoke-puff"
    />
  );
}

/** The heart that rises out of the mug after the puffs, then fades. */
function RisingHeart({ p, ink }: { p: SharedValue<number>; ink: string }) {
  const [from, to] = COFFEE_PHASES.heart;
  const style = useAnimatedStyle(() => {
    const c = p.value;
    if (c <= from || c >= to) return { opacity: 0 };
    const local = (c - from) / (to - from);
    return {
      opacity: interpolate(local, [0, 0.2, 0.75, 1], [0, 1, 1, 0], Extrapolation.CLAMP),
      transform: [
        { translateY: interpolate(local, [0, 1], [5, -7], Extrapolation.CLAMP) },
        { scale: interpolate(local, [0, 0.3], [0.5, 1], Extrapolation.CLAMP) },
      ],
    };
  });
  return (
    <Animated.View pointerEvents="none" style={[styles.heart, style]} testID="tip-steam-heart">
      <Svg width={MUG_LAYOUT.heart.width} height={MUG_LAYOUT.heart.height} viewBox="0 0 24 22">
        <Path
          d="M12 21.5c-1.4-1-11-7.3-11-14A6 6 0 0112 4a6 6 0 0111 3.5c0 6.7-9.6 13-11 14z"
          fill={ink}
        />
      </Svg>
    </Animated.View>
  );
}

/** The mascot face on the mug: eyes in, one blink, then happy arcs and a smile. */
function MugFace({ f, on, ink }: { f: SharedValue<number>; on: SharedValue<number>; ink: string }) {
  const { eyesIn, blink, happy } = MASCOT_FACE_PHASES;
  const eyes = useAnimatedStyle(() => ({
    opacity:
      on.value *
      interpolate(
        f.value,
        [eyesIn[0], eyesIn[1], happy[0], happy[1]],
        [0, 1, 1, 0],
        Extrapolation.CLAMP,
      ),
    transform: [
      {
        scaleY: interpolate(
          f.value,
          [blink[0], blink[1], blink[2]],
          [1, 0.12, 1],
          Extrapolation.CLAMP,
        ),
      },
    ],
  }));
  const smile = useAnimatedStyle(() => ({
    opacity: on.value * interpolate(f.value, [happy[0], happy[1]], [0, 1], Extrapolation.CLAMP),
  }));
  return (
    <>
      <Animated.View pointerEvents="none" style={[styles.eyes, eyes]} testID="tip-mascot-eyes">
        <View style={[styles.eye, { backgroundColor: ink }]} />
        <View style={[styles.eye, { backgroundColor: ink }]} />
      </Animated.View>
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, smile]}
        testID="tip-mascot-smile"
      >
        <Svg
          width={MUG_LAYOUT.box}
          height={MUG_LAYOUT.box}
          viewBox={`0 0 ${MUG_LAYOUT.box} ${MUG_LAYOUT.box}`}
          fill="none"
        >
          <Path d={MUG_PATHS.face} stroke={ink} strokeWidth={1.1} strokeLinecap="round" />
        </Svg>
      </Animated.View>
    </>
  );
}

/** 5 · The inukshuk with a heart; a soft ring pulses out (p: 0 → 1). */
function InukshukHeart({ t, p }: GlyphProps) {
  const ring = useAnimatedStyle(() => ({
    opacity: interpolate(p.value, [0, 0.01, 1], [0, 0.55, 0]),
    transform: [{ scale: interpolate(p.value, [0, 1], [1, 1.6]) }],
  }));
  return (
    <View style={styles.glyphBox}>
      <Animated.View
        pointerEvents="none"
        style={[styles.ring, { borderColor: t.support.accent }, ring]}
      />
      <Svg width={28} height={28} viewBox="0 0 24 24">
        <Rect x={10} y={3} width={4.5} height={3.5} rx={1} fill={t.support.stoneDeep} />
        <Rect x={5} y={7} width={14} height={3} rx={1.2} fill={t.support.stoneDeep} />
        <Rect x={8} y={10.8} width={8} height={3} rx={1.1} fill={t.support.stone} />
        <Rect x={8} y={14.5} width={3.2} height={6} rx={1} fill={t.support.stoneDeep} />
        <Rect x={12.8} y={14.5} width={3.2} height={6} rx={1} fill={t.support.stoneDeep} />
        <Path
          d="M19.5 3.2c-.9-.7-2.3-.3-2.3.9 0 1 1.3 1.8 2.3 2.6 1-.8 2.3-1.6 2.3-2.6 0-1.2-1.4-1.6-2.3-.9z"
          fill={t.support.heart}
        />
      </Svg>
    </View>
  );
}

const LOOKS: Record<
  TipButtonVariant,
  { background: (t: SchemeTokens) => string; Glyph: (props: GlyphProps) => React.JSX.Element }
> = {
  jarCoin: { background: (t) => t.support.accent, Glyph: JarCoin },
  // Stone chrome, like the map's other buttons, so the pale stones read.
  cairnCoin: { background: () => palette.stone, Glyph: CairnCoin },
  stoneHeart: { background: (t) => t.surface, Glyph: StoneHeart },
  coffeeSteam: { background: (t) => t.support.accent, Glyph: CoffeeSteam },
  inukshukHeart: { background: (t) => t.surface, Glyph: InukshukHeart },
};

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  button: {
    width: target.min,
    height: target.min,
    borderRadius: target.min / 2,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: palette.shadow,
    shadowOpacity: 0.3,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
    elevation: 5,
  },
  glyphBox: {
    width: MUG_LAYOUT.box,
    height: MUG_LAYOUT.box,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Puffs, heart and face all sit on the cup body's axis (MUG_LAYOUT).
  puff: {
    position: 'absolute',
    top: MUG_LAYOUT.puff.top,
    width: MUG_LAYOUT.puff.width,
    height: MUG_LAYOUT.puff.height,
    borderRadius: MUG_LAYOUT.puff.width / 2,
  },
  heart: { position: 'absolute', top: MUG_LAYOUT.heart.top, left: MUG_LAYOUT.heart.left },
  eyes: {
    position: 'absolute',
    left: MUG_LAYOUT.eyes.left,
    top: MUG_LAYOUT.eyes.top,
    width: MUG_LAYOUT.eyes.width,
    height: MUG_LAYOUT.eyes.height,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  eye: { width: MUG_LAYOUT.eye.width, height: MUG_LAYOUT.eye.height, borderRadius: 1 },
  coin: {
    position: 'absolute',
    left: 11,
    top: 2,
    width: 9,
    height: 9,
    borderRadius: 5,
  },
  ring: {
    position: 'absolute',
    width: target.min,
    height: target.min,
    borderRadius: target.min / 2,
    borderWidth: 3,
  },
  hide: {
    minHeight: 40,
    paddingHorizontal: 14,
    borderRadius: 20,
    borderWidth: 1,
    justifyContent: 'center',
    elevation: 3,
  },
  hideLabel: { fontSize: 14, fontWeight: '700' },
  pressed: { opacity: 0.8 },
});
