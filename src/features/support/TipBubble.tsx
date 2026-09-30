import { factText } from '@core/support/funFacts';
import { BUBBLE_VISIBLE_MS } from '@core/support/tipJar';
import { useTipMascotStore } from '@state/tipMascotStore';
import { palette, space, target } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

function deviceLocale(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return null;
  }
}

/**
 * The coffee mascot's speech bubble (#476, round 4): a fun fact up and to the
 * left of the Map's tip button, with a small (x). Drawn by the Map at its
 * root — a touchable that overflows its parent gets no taps on Android — at
 * `right`/`bottom` offsets that put it beside the button's corner.
 *
 * - Tapping the bubble opens Support at "Leave a tip".
 * - (x) closes it and snoozes bubbles for the rest of the session.
 * - Untouched, it folds away after {@link BUBBLE_VISIBLE_MS}.
 * - The text is announced by screen readers; both targets are ≥ 44 dp.
 * - Reduce motion: it appears and goes without the pop.
 */
export function TipBubble({
  right,
  bottom,
  visibleMs = BUBBLE_VISIBLE_MS,
}: {
  right: number;
  bottom: number;
  /** Test hook: how long it stays up untouched. */
  visibleMs?: number;
}) {
  const router = useRouter();
  const t = useSchemeTokens();
  const reduceMotion = useReducedMotion();
  const fact = useTipMascotStore((s) => s.bubbleFact);
  const pop = useSharedValue(0);

  useEffect(() => {
    if (fact === null) return;
    pop.set(
      reduceMotion ? 1 : withTiming(1, { duration: 220, easing: Easing.out(Easing.back(1.6)) }),
    );
    const timer = setTimeout(() => useTipMascotStore.getState().hide(), visibleMs);
    return () => {
      clearTimeout(timer);
      pop.set(0);
    };
  }, [fact, reduceMotion, visibleMs, pop]);

  const style = useAnimatedStyle(() => ({
    opacity: Math.min(1, pop.value * 1.5),
    transform: [{ scale: 0.85 + 0.15 * pop.value }],
  }));

  if (fact === null) return null;
  const text = factText(fact, deviceLocale());

  return (
    <View pointerEvents="box-none" style={[styles.anchor, { right, bottom }]}>
      <Animated.View
        style={[
          styles.bubble,
          { backgroundColor: t.surface, borderColor: t.outlineVariant },
          style,
        ]}
        testID="tip-bubble"
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${text} Opens Support Inukshuk.`}
          accessibilityLiveRegion="polite"
          onPress={() => {
            useTipMascotStore.getState().hide();
            router.push({ pathname: '/support', params: { from: 'jar' } });
          }}
          style={({ pressed }) => [styles.textArea, pressed && styles.pressed]}
          testID="tip-bubble-open"
        >
          <Text style={[styles.text, { color: t.ink }]}>{text}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          accessibilityHint="No more of these for now"
          onPress={() => useTipMascotStore.getState().snooze()}
          hitSlop={4}
          style={({ pressed }) => [styles.close, pressed && styles.pressed]}
          testID="tip-bubble-close"
        >
          <Icon source="close" size={18} color={t.inkMuted} />
        </Pressable>
        {/* The tail, pointing down-right at the mug. */}
        <View
          style={[styles.tail, { backgroundColor: t.surface, borderColor: t.outlineVariant }]}
        />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  anchor: { position: 'absolute', alignItems: 'flex-end' },
  bubble: {
    maxWidth: 250,
    minHeight: target.min,
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderRadius: 16,
    borderWidth: 1,
    paddingLeft: space.md,
    shadowColor: palette.shadow,
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 6,
  },
  textArea: { flexShrink: 1, minHeight: 44, justifyContent: 'center', paddingVertical: 10 },
  text: { fontSize: 14, lineHeight: 19 },
  close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  tail: {
    position: 'absolute',
    right: -5,
    bottom: 10,
    width: 12,
    height: 12,
    borderRightWidth: 1,
    borderBottomWidth: 1,
    transform: [{ rotate: '-45deg' }],
  },
  pressed: { opacity: 0.75 },
});
