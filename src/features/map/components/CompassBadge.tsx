import { isNorthUp, normalizeBearingDeg } from '@core/geo/northSnap';
import { unwrapDeg } from '@core/signal/heading';
import { palette, target } from '@ui/tokens';
import { useChromeOutline } from '@ui/useChromeOutline';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, StyleSheet, useAnimatedValue } from 'react-native';
import Svg, { Path } from 'react-native-svg';

interface CompassBadgeProps {
  /** Called when the badge is tapped (used to reset the map to north). */
  onPress?: () => void;
  /**
   * Current **map** bearing in degrees (clockwise, 0 = north-up), from the
   * camera settle path. `null`/omitted means north-up.
   */
  mapBearing?: number | null;
}

/**
 * How long the needle eases toward a new map bearing. Map bearing arrives on
 * camera *settle* (a handful of events per gesture, not a stream), so this is
 * a single visible move, and it should read as a glide.
 */
const NORTH_ANIM_MS = 250;

/** Side of the square the needle rotates inside, in dp. */
const NEEDLE_BOX = 26;

/**
 * The map compass (revamp decision 1, `Main.html`): a 48 dp stone-92 % puck,
 * top-left, whose needle points at **north on screen** — red tip north, paper
 * tail south. Tapping it realigns the map to north.
 *
 * It shows the MAP's orientation only. The device heading lives on the map
 * itself, in the location puck's heading cone; the old badge's heading needle
 * and "214° SW" readout are gone, and with them the reason the north arrow
 * had to be told apart from another needle (#266) — so the needle is always
 * drawn, and simply points up at north-up.
 *
 * The needle is drawn rotated by `−mapBearing` (the map turned clockwise puts
 * north counter-clockwise of the screen's up), eased toward an **unwrapped**
 * continuous angle so a bearing crossing 0° never spins the long way round.
 */
export function CompassBadge({ onPress, mapBearing }: CompassBadgeProps) {
  const tokens = useSchemeTokens();
  const outline = useChromeOutline();

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

  const northRotate = northAnim.interpolate({
    inputRange: [0, 360],
    outputRange: ['0deg', '-360deg'],
  });

  const offNorth = Math.round(Math.abs(bearing));
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole="button"
      accessibilityLabel={rotated ? `Map rotated ${offNorth}°, realign north` : 'Compass'}
      style={({ pressed }) => [
        styles.puck,
        { backgroundColor: tokens.map.chrome },
        outline,
        pressed && styles.pressed,
      ]}
    >
      <Animated.View
        testID="compass-north-needle"
        pointerEvents="none"
        style={[styles.needle, { transform: [{ rotate: northRotate }] }]}
      >
        <Svg width={NEEDLE_BOX} height={NEEDLE_BOX} viewBox="0 0 24 24">
          <Path d="M12 2.5 16.2 12H7.8Z" fill={tokens.map.compassNorth} />
          <Path d="M12 21.5 7.8 12h8.4Z" fill={tokens.map.compassSouth} />
        </Svg>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  puck: {
    width: target.min,
    height: target.min,
    borderRadius: target.min / 2,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: palette.shadow,
    shadowOpacity: 0.28,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  pressed: { opacity: 0.8 },
  needle: { width: NEEDLE_BOX, height: NEEDLE_BOX },
});
