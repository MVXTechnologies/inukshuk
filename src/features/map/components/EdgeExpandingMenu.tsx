import { edgePill } from '@ui/theme';
import { useEffect, useState, type ReactNode } from 'react';
import { Animated, LayoutAnimation, Pressable, StyleSheet, View } from 'react-native';
import { Icon, Text, useTheme } from 'react-native-paper';

/**
 * The edge rail's menu idiom: tapping the half-pill expands it HORIZONTALLY
 * (label slides in), then its choices unfold VERTICALLY beneath it as an
 * edge-anchored panel — one coherent structure growing out of the pill, in
 * place of a detached popup. A transparent full-screen backdrop closes it.
 */

const HEIGHT = 42;
const COLLAPSED = 52;
const EXPANDED = 168;

export function EdgeExpandingMenu({
  icon,
  label,
  accessibilityLabel,
  children,
  open,
  onToggle,
  panelColor,
}: {
  icon: string;
  label: string;
  accessibilityLabel?: string;
  children: ReactNode;
  open: boolean;
  onToggle: (open: boolean) => void;
  /** Panel slab override (defaults to the themed elevation surface) — the
   * overlays drill-down passes the fixed dark weather chrome. */
  panelColor?: string;
}) {
  const theme = useTheme();
  const [width] = useState(() => new Animated.Value(0));
  const [rendered, setRendered] = useState(open);

  // Animations are driven by the PROP, not the tap handler: the host closes
  // the menu from outside too (backdrop tap, a row being picked). The panel's
  // growth uses a LayoutAnimation so the pills BELOW slide in sync with the
  // unfold — mounting it at full height shoved them down ahead of the fade,
  // opening an ugly empty gap. Kept tight (~150 ms) so it reads as one move.
  // Mounting is adjusted during render (the sanctioned pattern — a setState
  // inside the effect would cascade); unmounting waits for the collapse
  // animation's completion callback.
  if (open && !rendered) setRendered(true);
  useEffect(() => {
    LayoutAnimation.configureNext(LayoutAnimation.create(150, 'easeInEaseOut', 'opacity'));
    Animated.spring(width, {
      toValue: open ? 1 : 0,
      speed: 30,
      bounciness: 4,
      useNativeDriver: false,
    }).start(({ finished }) => {
      if (finished && !open) setRendered(false);
    });
  }, [open, width]);

  const toggle = () => onToggle(!open);

  const pillWidth = width.interpolate({ inputRange: [0, 1], outputRange: [COLLAPSED, EXPANDED] });
  const labelOpacity = width.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0, 0, 1] });

  const surface = panelColor ?? theme.colors.elevation?.level2 ?? theme.colors.surface;
  // The pill matches the action pills' fixed dark slab; open state shows in
  // the pastel-river ink (the "+" dial blue), not a fill change.
  const ink = open ? edgePill.active : edgePill.ink;

  return (
    <View style={styles.host}>
      <Animated.View
        style={[styles.pill, { width: pillWidth, backgroundColor: edgePill.background }]}
      >
        <Pressable
          style={styles.press}
          onPress={toggle}
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel ?? label}
        >
          <Animated.View style={{ opacity: labelOpacity }}>
            <Text variant="labelLarge" numberOfLines={1} style={{ color: ink }}>
              {label}
            </Text>
          </Animated.View>
          <Icon source={icon} size={22} color={ink} />
        </Pressable>
      </Animated.View>
      {rendered && <View style={[styles.panel, { backgroundColor: surface }]}>{children}</View>}
    </View>
  );
}

const styles = StyleSheet.create({
  host: { alignItems: 'flex-end' },
  pill: {
    height: HEIGHT,
    borderTopLeftRadius: HEIGHT / 2,
    borderBottomLeftRadius: HEIGHT / 2,
    elevation: 3,
    shadowOpacity: 0.18,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    overflow: 'hidden',
    zIndex: 2,
  },
  press: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingRight: 15,
    gap: 8,
  },
  panel: {
    marginTop: 3,
    borderTopLeftRadius: 14,
    borderBottomLeftRadius: 14,
    paddingVertical: 2,
    minWidth: 300,
    elevation: 5,
    shadowOpacity: 0.22,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
});
