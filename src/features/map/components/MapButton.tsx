import { palette, target } from '@ui/tokens';
import { useChromeOutline } from '@ui/useChromeOutline';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { Children, Fragment, type ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Icon } from 'react-native-paper';

/**
 * A map-chrome button (revamp `Main.html`): 48 dp — the glove-sized minimum
 * target — stone at 92 % with paper ink, floating over the map. Replaces
 * Paper's `FAB size="small"` on the map (40 dp, lavender surface).
 *
 * `selected` is the pressed state of a toggle (the following target button):
 * solid chrome with the river-blue follow ink, announced as selected.
 * `grouped` drops the button's own fill and shadow so it can sit inside a
 * {@link MapButtonGroup} pill.
 */
export function MapButton({
  icon,
  accessibilityLabel,
  onPress,
  selected,
  shape = 'round',
  grouped = false,
  style,
}: {
  icon: string;
  accessibilityLabel: string;
  onPress: () => void;
  selected?: boolean;
  shape?: 'round' | 'square';
  grouped?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const tokens = useSchemeTokens();
  const outline = useChromeOutline();
  const fill = selected ? tokens.map.chromeActive : tokens.map.chrome;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={selected === undefined ? undefined : { selected }}
      android_ripple={{ color: 'rgba(255,255,255,0.18)', borderless: false }}
      style={({ pressed }) => [
        styles.button,
        shape === 'round' ? styles.round : styles.square,
        !grouped && [styles.shadow, { backgroundColor: fill }, outline],
        pressed && styles.pressed,
        style,
      ]}
    >
      <Icon
        source={icon}
        size={22}
        color={selected ? tokens.map.followInk : tokens.map.chromeInk}
      />
    </Pressable>
  );
}

/** Buttons joined in one stone pill with hairlines between them (Base map · Overlays). */
export function MapButtonGroup({ children }: { children: ReactNode }) {
  const tokens = useSchemeTokens();
  const outline = useChromeOutline();
  const items = Children.toArray(children);
  return (
    // Outer view carries the shadow, inner one clips the corners: on iOS a
    // view that clips its own bounds loses its shadow.
    <View style={[styles.group, styles.shadow, { backgroundColor: tokens.map.chrome }, outline]}>
      <View style={styles.groupClip}>
        {items.map((child, i) => (
          <Fragment key={i}>
            {i > 0 && (
              <View style={[styles.divider, { backgroundColor: tokens.map.chromeDivider }]} />
            )}
            {child}
          </Fragment>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    width: target.min,
    height: target.min,
    alignItems: 'center',
    justifyContent: 'center',
  },
  round: { borderRadius: target.min / 2 },
  square: { borderRadius: 16 },
  pressed: { opacity: 0.8 },
  shadow: {
    shadowColor: palette.shadow,
    shadowOpacity: 0.28,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  group: { width: target.min, borderRadius: 16 },
  groupClip: { borderRadius: 16, overflow: 'hidden' },
  divider: { height: 1, marginHorizontal: 10 },
});
