import { isNorthUp, normalizeBearingDeg } from '@core/geo/northSnap';
import { unwrapDeg } from '@core/signal/heading';
import { headingToCardinal } from '@core/format';
import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View, useAnimatedValue } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Surface, Text, TouchableRipple, useTheme } from 'react-native-paper';
import { useCompass } from '../useCompass';

interface CompassBadgeProps {
  /** Called when the badge is tapped (used to reset the map to north). */
  onPress?: () => void;
  /**
   * Current **map** bearing in degrees (clockwise, 0 = north-up), from the
   * camera settle path. `null`/omitted means north-up. Anything past
   * `NORTH_UP_EPSILON_DEG` draws the red north needle.
   */
  mapBearing?: number | null;
}

/**
 * How long the needle eases toward a new heading. Sized to just outrun the
 * sensor's own cadence (~7–10 Hz on Android) so each animation is still running
 * when the next update replaces it — the needle then glides continuously rather
 * than landing and re-starting.
 */
const NEEDLE_ANIM_MS = 200;

/**
 * How long the red north needle eases toward a new map bearing. Longer than
 * the heading needle's: map bearing arrives on camera *settle* (a handful of
 * events per gesture, not a stream), so this is a single visible move rather
 * than a link in a chain, and it should read as a glide.
 */
const NORTH_ANIM_MS = 250;

/** Side of the square both needles rotate inside, in pt. */
const NEEDLE_BOX = 40;

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
 *
 * ## The red north arrow (#248, #266)
 *
 * While the map is rotated, a red arrow — shaft from the centre, head, and an
 * **N** at its tip — points at **true north on screen**. It is layered OVER
 * the heading needle so the needle can never hide it, and it is the only thing
 * that says "the map is turned, and tapping here straightens it". It is drawn
 * rotated by `−mapBearing` (the map turned clockwise puts north
 * counter-clockwise of the screen's up), eased the same unwrapped way so a
 * bearing crossing 0° never spins the long way round. At north-up it is
 * hidden: nothing to point out. (#257 shipped this as a bare rim tick; the
 * owner could not tell it from the needle in the field — hence the arrow and
 * the letter.)
 *
 * With "rotate map with heading" on, the map bearing tracks the device, so the
 * red needle shows constantly. That is correct — under heading-follow it is the
 * only north reference on the screen.
 */
export function CompassBadge({ onPress, mapBearing }: CompassBadgeProps) {
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

  // Same treatment for the map bearing: signed (-180, 180] so a bearing of 350°
  // reads as -10°, then unwrapped against the last value so the tick eases
  // across north the short way.
  const bearing = normalizeBearingDeg(mapBearing ?? 0);
  const rotated = !isNorthUp(bearing);
  const northContinuousRef = useRef<number | null>(null);
  const northAnim = useAnimatedValue(0);

  useEffect(() => {
    const prev = northContinuousRef.current;
    if (prev === null) {
      northContinuousRef.current = bearing;
      northAnim.setValue(bearing);
      return;
    }
    const next = unwrapDeg(prev, bearing);
    northContinuousRef.current = next;
    Animated.timing(northAnim, {
      toValue: next,
      duration: NORTH_ANIM_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [bearing, northAnim]);

  // The arrow points to NORTH: as the device heading increases (you turn
  // clockwise), north sits counter-clockwise from you, so the needle
  // counter-rotates. Linear extrapolation makes this valid for any continuous
  // angle, including negatives and multiples of 360.
  const rotate = rotationAnim.interpolate({
    inputRange: [0, 360],
    outputRange: ['0deg', '-360deg'],
  });
  // Identical relationship, for the same reason: the map bearing turns the
  // world clockwise, so north on screen is at −bearing.
  const northRotate = northAnim.interpolate({
    inputRange: [0, 360],
    outputRange: ['0deg', '-360deg'],
  });

  const deg = heading ?? 0;
  const offNorth = Math.round(Math.abs(bearing));
  return (
    <Surface
      style={[styles.surface, { backgroundColor: theme.colors.elevation?.level2 }]}
      elevation={3}
    >
      <TouchableRipple
        onPress={onPress}
        disabled={!onPress}
        borderless
        style={styles.touch}
        accessibilityRole="button"
        accessibilityLabel={rotated ? `Map rotated ${offNorth}°, realign north` : 'Compass'}
      >
        <View style={styles.content}>
          <View style={styles.needleBox}>
            <Animated.View style={[styles.needleWrap, { transform: [{ rotate }] }]}>
              <MaterialCommunityIcons name="navigation" size={26} color={theme.colors.tertiary} />
            </Animated.View>
            {/* Rendered AFTER the heading needle so it paints on top (#266):
                a red arrow from the box centre to the rim, N at the tip. The
                stack is laid out from the top of the box downward — letter,
                head, shaft — so the shaft's foot lands just past the centre
                and the whole thing pivots about the badge's middle. */}
            {rotated && (
              <Animated.View
                testID="compass-north-needle"
                pointerEvents="none"
                style={[
                  styles.needleWrap,
                  styles.northWrap,
                  { transform: [{ rotate: northRotate }] },
                ]}
              >
                <Text
                  style={[styles.northLetter, { color: theme.colors.error }]}
                  allowFontScaling={false}
                >
                  N
                </Text>
                <View style={[styles.northHead, { borderBottomColor: theme.colors.error }]} />
                <View style={[styles.northShaft, { backgroundColor: theme.colors.error }]} />
              </Animated.View>
            )}
          </View>
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
  // 40-pt square: the 26-pt heading needle sits centred, and the north arrow
  // (letter 11 + head 7 + shaft 6 = 24 pt from the top edge) reaches 4 pt past
  // the centre, so it reads as an arrow FROM the middle, not a floating tick.
  needleBox: {
    width: NEEDLE_BOX,
    height: NEEDLE_BOX,
  },
  needleWrap: {
    width: NEEDLE_BOX,
    height: NEEDLE_BOX,
    alignItems: 'center',
    justifyContent: 'center',
  },
  northWrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    // Top-aligned inside the same square the heading needle fills, so the
    // arrow runs centre→rim while still rotating about the badge's centre.
    justifyContent: 'flex-start',
    // Android paints siblings in order, but be explicit: nothing in the
    // heading needle may cover the north arrow.
    zIndex: 1,
    elevation: 1,
  },
  northLetter: {
    fontSize: 10,
    lineHeight: 11,
    fontWeight: '800',
    includeFontPadding: false,
    textAlign: 'center',
  },
  northHead: {
    width: 0,
    height: 0,
    borderLeftWidth: 4.5,
    borderRightWidth: 4.5,
    borderBottomWidth: 7,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
  },
  northShaft: {
    width: 3,
    height: 6,
    borderBottomLeftRadius: 1.5,
    borderBottomRightRadius: 1.5,
  },
  label: {
    fontVariant: ['tabular-nums'],
  },
});
