import {
  DEFAULT_TIP_BUTTON_VARIANT,
  TIP_BUTTON_MOTION,
  TIP_JAR_WOBBLE_INTERVAL_MS,
  tipJarAnimates,
  tipJarVisible,
  type TipButtonVariant,
} from '@core/support/tipJar';
import { useRecorderStore } from '@state/recorderStore';
import { useSettingsStore } from '@state/settingsStore';
import { useSupportStore } from '@state/supportStore';
import { palette, space, target, type SchemeTokens } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';
import Animated, {
  Easing,
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
 * The tip button, bottom-right of the Map only (#476, round 3). Opens Support
 * Inukshuk at "Leave a tip".
 *
 * Five looks from the owner's mockup (`TipButton.dc.html`), one component:
 * `variant` picks the icon and its animation, and the default lives in
 * `@core/support/tipJar` (`DEFAULT_TIP_BUTTON_VARIANT`), so choosing is a
 * one-line change. Every variant runs the same rules: one short animation
 * every 15 s, none with the OS "reduce motion" setting or after a tip; hidden
 * while recording, following a destination, when the map's corner is taken,
 * when switched off in Settings, and for 12 months after a tip or a verified
 * "I already donated". Long-press offers "Hide".
 */
export function TipButton({
  variant = DEFAULT_TIP_BUTTON_VARIANT,
  navigating = false,
  blocked = false,
  onAnimate,
  intervalMs = TIP_JAR_WOBBLE_INTERVAL_MS,
}: {
  variant?: TipButtonVariant;
  navigating?: boolean;
  blocked?: boolean;
  /** Test hooks: called at each animation, and the animation period. */
  onAnimate?: () => void;
  intervalMs?: number;
}) {
  const router = useRouter();
  const t = useSchemeTokens();
  const enabled = useSettingsStore((s) => s.showTipJar);
  const restingUntil = useSettingsStore((s) => s.tipJarRestingUntil);
  const setSetting = useSettingsStore((s) => s.set);
  const recording = useRecorderStore((s) => s.status !== 'idle');
  const hasTipped = useSupportStore((s) => s.tipCount > 0);
  const reduceMotion = useReducedMotion();
  const [menuOpen, setMenuOpen] = useState(false);
  // Mount time is precise enough for a 12-month window.
  const [now] = useState(Date.now);
  const steps = TIP_BUTTON_MOTION[variant];
  const rest = steps[steps.length - 1]?.to ?? 0;
  const progress = useSharedValue(rest);
  const onAnimateRef = useRef(onAnimate);
  useEffect(() => {
    onAnimateRef.current = onAnimate;
  }, [onAnimate]);

  const visible = tipJarVisible({ enabled, recording, navigating, blocked, restingUntil, now });
  const animates = visible && tipJarAnimates({ reduceMotion, hasTipped });

  useEffect(() => {
    if (!animates) return;
    const timer = setInterval(() => {
      const [first, ...others] = steps.map((step) =>
        withTiming(step.to, { duration: step.ms, easing: Easing.inOut(Easing.quad) }),
      );
      if (first !== undefined) progress.value = withSequence(first, ...others);
      onAnimateRef.current?.();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [animates, intervalMs, progress, steps]);

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
        <look.Glyph t={t} p={progress} />
      </Pressable>
    </View>
  );
}

interface GlyphProps {
  t: SchemeTokens;
  p: SharedValue<number>;
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

/** 4 · Coffee at the trailhead; steam rises (p: 0 → 1). */
function CoffeeSteam({ t, p }: GlyphProps) {
  const steam = useAnimatedStyle(() => ({
    opacity: interpolate(p.value, [0, 0.2, 1], [0, 0.9, 0]),
    transform: [{ translateY: interpolate(p.value, [0, 1], [4, -6]) }],
  }));
  const ink = t.support.onAccent;
  return (
    <View style={styles.glyphBox}>
      <Svg width={26} height={26} viewBox="0 0 24 24" fill="none">
        <Path
          d="M5 11h11v4.5a4.5 4.5 0 01-4.5 4.5h-2A4.5 4.5 0 015 15.5V11zM16 12.5h1.5a2 2 0 010 4H16"
          stroke={ink}
          strokeWidth={1.9}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Svg>
      <Animated.View style={[StyleSheet.absoluteFill, steam]}>
        <Svg width={26} height={26} viewBox="0 0 24 24" fill="none">
          <Path
            d="M8.5 8c-.8-1 .8-2 0-3M12 8c-.8-1 .8-2 0-3"
            stroke={ink}
            strokeWidth={1.6}
            strokeLinecap="round"
          />
        </Svg>
      </Animated.View>
    </View>
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
  glyphBox: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
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
