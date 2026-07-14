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

/**
 * How long the needle eases toward a new heading. Sized to just outrun the
 * sensor's own cadence (~7–10 Hz on Android) so each animation is still running
 * when the next update replaces it — the needle then glides continuously rather
 * than landing and re-starting.
 */
const NEEDLE_ANIM_MS = 200;

/**
 * A small floating compass that rotates its needle to the device heading.
 * Tapping it resets the map to north (when `onPress` is provided).
 *
 * The heading it renders is the shared, filtered one (see `useCompass` and
 * `@core/signal/heading`): perfectly still while the phone is, so both the
 * needle and the degree readout stop trembling on a table.
 *
 * The badge owns its own `useCompass` subscription: compass events fire many
 * times a second, so subscribing here (instead of in MapScreen) means each
 * heading update re-renders only this small badge, not the whole map tree.
 * Camera rotation is separate — it uses `useHeadingCamera` — but reads from the
 * same shared filtered stream, so the needle, the heading cone and the map
 * bearing can never disagree.
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
      // Linear, not eased: successive updates interrupt each other, and an
      // ease-out restarts its deceleration every time, which reads as a stutter
      // while you turn. Linear segments chain into one smooth sweep.
      easing: Easing.linear,
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
