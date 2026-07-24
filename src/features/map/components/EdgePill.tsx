import { useState } from 'react';
import { Animated, Pressable, StyleSheet } from 'react-native';
import { Icon, useTheme } from 'react-native-paper';

/**
 * The 'edge' UI style's plain action button: a half-pill flush against the
 * right screen edge (rounded only on its left side). Static width — action
 * pills (locate, fit, 3D) have nothing to choose from, so they don't expand;
 * menus use {@link EdgeExpandingMenu} instead. Press feedback is a small
 * squeeze toward the edge.
 */

interface Props {
  icon: string;
  label: string;
  onPress: () => void;
  /** Highlight as engaged (e.g. 3D mode active). */
  active?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
}

const HEIGHT = 42;
const WIDTH = 52;

export function EdgePill({ icon, label, onPress, active, disabled, accessibilityLabel }: Props) {
  const theme = useTheme();
  const [squeeze] = useState(() => new Animated.Value(0));

  const spring = (to: number) =>
    Animated.spring(squeeze, {
      toValue: to,
      speed: 30,
      bounciness: 6,
      useNativeDriver: true,
    }).start();

  const background = active ? theme.colors.primaryContainer : theme.colors.surface;
  const ink = active ? theme.colors.onPrimaryContainer : theme.colors.onSurface;
  const scale = squeeze.interpolate({ inputRange: [0, 1], outputRange: [1, 0.92] });

  return (
    <Animated.View style={[styles.pill, { backgroundColor: background, transform: [{ scale }] }]}>
      <Pressable
        style={styles.press}
        disabled={disabled}
        onPressIn={() => spring(1)}
        onPressOut={() => spring(0)}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label}
      >
        <Icon source={icon} size={22} color={disabled ? theme.colors.outline : ink} />
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  pill: {
    height: HEIGHT,
    width: WIDTH,
    borderTopLeftRadius: HEIGHT / 2,
    borderBottomLeftRadius: HEIGHT / 2,
    borderTopRightRadius: 0,
    borderBottomRightRadius: 0,
    elevation: 3,
    shadowOpacity: 0.18,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    overflow: 'hidden',
    alignSelf: 'flex-end',
  },
  press: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingRight: 3,
  },
});
