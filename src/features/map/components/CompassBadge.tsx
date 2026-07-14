import { unwrapDeg } from '@core/signal/heading';
import { headingToCardinal } from '@lib/format';
import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View, useAnimatedValue } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Surface, Text, TouchableRipple, useTheme } from 'react-native-paper';
import { useCompass } from '../useCompass';

interface CompassBadgeProps {
  /** Called when the badge is tapped (used to reset the map to north). */
  onPress?: () => void;
}

/** How long the needle eases toward a new heading. Short enough to feel live,
 * long enough to swallow the gap between throttled updates. */
const NEEDLE_ANIM_MS = 180;

/**
 * A small floating compass that rotates its needle to the device heading.
 * Tapping it resets the map to north (when `onPress` is provided).
 *
 * The badge owns its own `useCompass` subscription: compass events fire many
 * times a second, so subscribing here (instead of in MapScreen) means each
 * heading update re-renders only this small badge, not the whole map tree.
 * Camera rotation is separate — it uses `useHeadingCamera` / MapLibre's native
 * heading tracking, not this value.
 *
 * The needle animates on the native driver toward an **unwrapped** continuous
 * angle (349° → 361°, not → 1°), so crossing north eases through the boundary
 * instead of spinning 350° the wrong way.
 */
export function CompassBadge({ onPress }: CompassBadgeProps) {
  const sample = useCompass();
  const theme = useTheme();
  const heading = sample?.headingDeg ?? null;

  // Continuous (unwrapped) heading the needle is animating toward.
  const continuousRef = useRef<number | null>(null);
  const rotationAnim = useAnimatedValue(0);

  useEffect(() => {
    if (heading === null) return;
    const prev = continuousRef.current;
    if (prev === null) {
      continuousRef.current = heading;
      rotationAnim.setValue(heading);
      return;
    }
    const next = unwrapDeg(prev, heading);
    continuousRef.current = next;
    Animated.timing(rotationAnim, {
      toValue: next,
      duration: NEEDLE_ANIM_MS,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  }, [heading, rotationAnim]);

  // The arrow points to NORTH: as the device heading increases (you turn
  // clockwise), north sits counter-clockwise from you, so the needle
  // counter-rotates. Linear extrapolation makes this valid for any continuous
  // angle, including negatives and multiples of 360.
  const rotate = rotationAnim.interpolate({
    inputRange: [0, 360],
    outputRange: ['0deg', '-360deg'],
  });

  const deg = heading ?? 0;
  return (
    <Surface style={styles.surface} elevation={3}>
      <TouchableRipple
        onPress={onPress}
        disabled={!onPress}
        borderless
        style={styles.touch}
        accessibilityRole="button"
        accessibilityLabel="Reset map to north"
      >
        <View style={styles.content}>
          <Animated.View style={[styles.needleWrap, { transform: [{ rotate }] }]}>
            <MaterialCommunityIcons name="navigation" size={26} color={theme.colors.tertiary} />
          </Animated.View>
          <Text variant="labelMedium" style={styles.label}>
            {heading === null ? '--' : `${Math.round(deg) % 360}° ${headingToCardinal(deg)}`}
          </Text>
        </View>
      </TouchableRipple>
    </Surface>
  );
}

const styles = StyleSheet.create({
  surface: {
    borderRadius: 16,
  },
  touch: {
    borderRadius: 16,
  },
  content: {
    paddingVertical: 8,
    paddingHorizontal: 10,
    alignItems: 'center',
    gap: 2,
  },
  needleWrap: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontVariant: ['tabular-nums'],
  },
});
