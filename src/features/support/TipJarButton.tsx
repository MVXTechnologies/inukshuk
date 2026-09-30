import {
  TIP_JAR_WOBBLE,
  TIP_JAR_WOBBLE_INTERVAL_MS,
  tipJarAnimates,
  tipJarVisible,
} from '@core/support/tipJar';
import { useRecorderStore } from '@state/recorderStore';
import { useSettingsStore } from '@state/settingsStore';
import { useSupportStore } from '@state/supportStore';
import { palette, space, target } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Text } from 'react-native-paper';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Path } from 'react-native-svg';

/**
 * The small round tip jar on the main tabs (#476, round 2). Opens Support
 * Inukshuk at "Leave a tip". Rules (when it shows, when it moves) live in
 * `@core/support/tipJar`; this only applies them.
 *
 * - Hidden by Settings › App settings › "Show the tip jar button", while
 *   recording, while following a destination (`navigating`), and whenever the
 *   host says its corner is taken (`blocked`).
 * - A gentle wobble every 15 s, never with the OS "reduce motion" setting and
 *   never once the person has tipped.
 * - Long-press offers "Hide tip jar" (the same setting).
 *
 * Placement is the host's job (see `FloatingTipJar` for the list tabs; the
 * map stacks it in its bottom-right column).
 */
export function TipJarButton({
  navigating = false,
  blocked = false,
  onWobble,
  intervalMs = TIP_JAR_WOBBLE_INTERVAL_MS,
}: {
  navigating?: boolean;
  blocked?: boolean;
  /** Test hooks: called at each wobble, and the wobble period. */
  onWobble?: () => void;
  intervalMs?: number;
}) {
  const router = useRouter();
  const t = useSchemeTokens();
  const enabled = useSettingsStore((s) => s.showTipJar);
  const setSetting = useSettingsStore((s) => s.set);
  const recording = useRecorderStore((s) => s.status !== 'idle');
  const hasTipped = useSupportStore((s) => s.tipCount > 0);
  const reduceMotion = useReducedMotion();
  const [menuOpen, setMenuOpen] = useState(false);
  const rotation = useSharedValue(0);
  const onWobbleRef = useRef(onWobble);
  useEffect(() => {
    onWobbleRef.current = onWobble;
  }, [onWobble]);

  const visible = tipJarVisible({ enabled, recording, navigating, blocked });
  const animates = visible && tipJarAnimates({ reduceMotion, hasTipped });

  useEffect(() => {
    if (!animates) return;
    const timer = setInterval(() => {
      const [first, ...rest] = TIP_JAR_WOBBLE.map((step) =>
        withTiming(step.deg, { duration: step.ms, easing: Easing.inOut(Easing.quad) }),
      );
      if (first !== undefined) rotation.value = withSequence(first, ...rest);
      onWobbleRef.current?.();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [animates, intervalMs, rotation]);

  // The "Hide" offer folds itself away after a few seconds.
  useEffect(() => {
    if (!menuOpen) return;
    const timer = setTimeout(() => setMenuOpen(false), 5000);
    return () => clearTimeout(timer);
  }, [menuOpen]);

  const wobble = useAnimatedStyle(() => ({ transform: [{ rotate: `${rotation.value}deg` }] }));

  if (!visible) return null;

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
          <Text style={[styles.hideLabel, { color: t.ink }]}>Hide tip jar</Text>
        </Pressable>
      )}
      <Animated.View style={wobble}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Tip jar: support Inukshuk"
          accessibilityHint="Long-press to hide"
          onPress={() => {
            setMenuOpen(false);
            router.push({ pathname: '/support', params: { from: 'jar' } });
          }}
          onLongPress={() => setMenuOpen(true)}
          style={({ pressed }) => [
            styles.button,
            { backgroundColor: t.support.accent },
            pressed && styles.pressed,
          ]}
          testID="tip-jar"
        >
          <JarGlyph color={t.support.onAccent} />
        </Pressable>
      </Animated.View>
    </View>
  );
}

/** A glass jar with a coin, drawn to sit in the 48 dp button. */
function JarGlyph({ color }: { color: string }) {
  return (
    <Svg width={24} height={24} viewBox="0 0 24 24" fill="none" accessibilityElementsHidden>
      <Path d="M7 3.5h10" stroke={color} strokeWidth={2} strokeLinecap="round" />
      <Path
        d="M8 5.5h8v1.2c1.8.9 3 2.7 3 4.8v6.5a2.5 2.5 0 01-2.5 2.5h-9A2.5 2.5 0 015 18v-6.5c0-2.1 1.2-3.9 3-4.8V5.5z"
        stroke={color}
        strokeWidth={2}
        strokeLinejoin="round"
      />
      <Circle cx={12} cy={15} r={2.6} stroke={color} strokeWidth={1.8} />
    </Svg>
  );
}

/** Bottom padding a list under the floating jar needs so its last row can scroll clear. */
export const TIP_JAR_CLEARANCE = target.min + space.lg;

/**
 * The jar floating in the bottom-right corner of a list tab (Library,
 * Explore, Logbook): 16 dp from the edge, above the tab bar the scene
 * already ends at.
 */
export function FloatingTipJar({
  style,
  blocked = false,
}: {
  style?: StyleProp<ViewStyle>;
  blocked?: boolean;
}) {
  return (
    <View style={[styles.floating, style]} pointerEvents="box-none">
      <TipJarButton blocked={blocked} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  button: {
    width: target.min,
    height: target.min,
    borderRadius: target.min / 2,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: palette.shadow,
    shadowOpacity: 0.22,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
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
  floating: { position: 'absolute', right: space.lg, bottom: space.lg },
  pressed: { opacity: 0.8 },
});
