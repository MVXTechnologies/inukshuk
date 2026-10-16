import { palette, target } from '@ui/tokens';
import { useChromeOutline } from '@ui/useChromeOutline';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { Icon } from '@ui/paper';
import { useScaledStyles } from '@ui/displayScale';

/**
 * A map-chrome button (revamp `Main.html`): 48 dp — the glove-sized minimum
 * target — stone at 92 % with paper ink, floating over the map. Replaces
 * Paper's `FAB size="small"` on the map (40 dp, lavender surface).
 *
 * `selected` is the pressed state of a toggle (the following target button):
 * solid chrome with the river-blue follow ink, announced as selected.
 */
export function MapButton({
  icon,
  accessibilityLabel,
  onPress,
  selected,
  shape = 'round',
  style,
}: {
  icon: string;
  accessibilityLabel: string;
  onPress: () => void;
  selected?: boolean;
  shape?: 'round' | 'square';
  style?: StyleProp<ViewStyle>;
}) {
  const styles = useScaledStyles(stylesSheet);

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
        styles.shadow,
        { backgroundColor: fill },
        outline,
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

const stylesSheet = StyleSheet.create({
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
});
