import { palette, target } from '@ui/tokens';
import { useChromeOutline } from '@ui/useChromeOutline';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Icon } from '@ui/paper';
import { useScaledStyles } from '@ui/displayScale';

/** The drawn disc (dp at 100 %): Google Maps' size, owner decision #760. */
export const MAP_BUTTON_VISUAL = 40;
/** The touch box around it, which is also the button's layout footprint. */
export const MAP_BUTTON_TOUCH = target.min;

/**
 * A map-chrome button (revamp `Main.html`): a 40 dp disc, stone at 92 % with
 * paper ink, floating over the map, centred in a 48 dp touch box (#760; it
 * was a 48 dp disc). The footprint stays 48, so the rail, the lanes and the
 * SOS column keep their geometry; only the drawn disc is smaller. Both scale
 * with the Display size, the touch box never below 48.
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
      style={[styles.touch, style]}
    >
      {({ pressed }) => (
        <View
          testID="map-button-disc"
          style={[
            styles.disc,
            shape === 'round' ? styles.round : styles.square,
            styles.shadow,
            { backgroundColor: fill },
            outline,
            pressed && styles.pressed,
          ]}
        >
          <Icon
            source={icon}
            size={20}
            color={selected ? tokens.map.followInk : tokens.map.chromeInk}
          />
        </View>
      )}
    </Pressable>
  );
}

const stylesSheet = StyleSheet.create({
  touch: {
    width: MAP_BUTTON_TOUCH,
    height: MAP_BUTTON_TOUCH,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disc: {
    width: MAP_BUTTON_VISUAL,
    height: MAP_BUTTON_VISUAL,
    alignItems: 'center',
    justifyContent: 'center',
  },
  round: { borderRadius: MAP_BUTTON_VISUAL / 2 },
  square: { borderRadius: 14 },
  pressed: { opacity: 0.8 },
  shadow: {
    shadowColor: palette.shadow,
    shadowOpacity: 0.28,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
});
