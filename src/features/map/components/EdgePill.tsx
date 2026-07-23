import { useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet } from 'react-native';
import { Icon, Text, useTheme } from 'react-native-paper';

/**
 * The 'edge' UI style's map control: a half-pill flush against the right
 * screen edge (rounded only on its left side). At rest it shows just the
 * icon; touching it springs it open leftwards, revealing its label, and it
 * settles shut on release. Pills stack nearly edge-to-edge vertically so the
 * whole rail occupies a fraction of the map the classic FABs did.
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
const COLLAPSED = 52;
const EXPANDED = 150;

/** How long an expanded pill keeps showing its title before settling shut. */
const HOLD_OPEN_MS = 2600;

export function EdgePill({ icon, label, onPress, active, disabled, accessibilityLabel }: Props) {
  const theme = useTheme();
  const [anim] = useState(() => new Animated.Value(0));
  // Expansion springs live in callbacks only; the refs mirror mount state and
  // the pending auto-collapse so a press after unmount can't drive a dead
  // Animated node and re-presses restart the hold-open window.
  const mounted = useRef(true);
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (collapseTimer.current) clearTimeout(collapseTimer.current);
    };
  }, []);

  const spring = (to: number) =>
    Animated.spring(anim, {
      toValue: to,
      speed: 22,
      bounciness: to === 1 ? 7 : 2,
      // Width animation — layout property, JS driver required.
      useNativeDriver: false,
    }).start();

  // The title STAYS once expanded: the pill springs open on touch and holds
  // its label for a beat after release instead of snapping shut underneath
  // the finger — re-touching within the window restarts it.
  const scheduleCollapse = () => {
    if (collapseTimer.current) clearTimeout(collapseTimer.current);
    collapseTimer.current = setTimeout(() => {
      if (mounted.current) spring(0);
    }, HOLD_OPEN_MS);
  };

  const width = anim.interpolate({ inputRange: [0, 1], outputRange: [COLLAPSED, EXPANDED] });
  const labelOpacity = anim.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0, 0, 1] });

  const background = active ? theme.colors.primaryContainer : theme.colors.surface;
  const ink = active ? theme.colors.onPrimaryContainer : theme.colors.onSurface;

  return (
    <Animated.View style={[styles.pill, { width, backgroundColor: background }]}>
      <Pressable
        style={styles.press}
        disabled={disabled}
        onPressIn={() => {
          if (collapseTimer.current) clearTimeout(collapseTimer.current);
          spring(1);
        }}
        onPressOut={scheduleCollapse}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label}
      >
        <Animated.View style={[styles.labelBox, { opacity: labelOpacity }]}>
          <Text variant="labelLarge" style={{ color: ink }} numberOfLines={1}>
            {label}
          </Text>
        </Animated.View>
        <Icon source={icon} size={22} color={disabled ? theme.colors.outline : ink} />
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  pill: {
    height: HEIGHT,
    borderTopLeftRadius: HEIGHT / 2,
    borderBottomLeftRadius: HEIGHT / 2,
    // Flush with the screen edge: square on the right, soft on the left.
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
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingRight: 15,
    gap: 8,
  },
  labelBox: { flexShrink: 1 },
});
