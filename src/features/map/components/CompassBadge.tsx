import { headingToCardinal } from '@lib/format';
import { StyleSheet, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Surface, Text, TouchableRipple, useTheme } from 'react-native-paper';
import { useCompass } from '../useCompass';

interface CompassBadgeProps {
  /** Called when the badge is tapped (used to reset the map to north). */
  onPress?: () => void;
}

/**
 * A small floating compass that rotates its needle to the device heading.
 * Tapping it resets the map to north (when `onPress` is provided).
 *
 * The badge owns its own `useCompass` subscription: compass events fire many
 * times a second, so subscribing here (instead of in MapScreen) means each
 * heading update re-renders only this small badge, not the whole map tree.
 * Camera rotation is separate — it uses `useHeadingCamera` / MapLibre's native
 * heading tracking, not this value.
 */
export function CompassBadge({ onPress }: CompassBadgeProps) {
  const heading = useCompass();
  const theme = useTheme();
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
          <View style={styles.needleWrap}>
            {/* The arrow points to NORTH: as the device heading increases (you
                turn clockwise), north sits counter-clockwise from you, so the
                needle counter-rotates by -heading. */}
            <MaterialCommunityIcons
              name="navigation"
              size={26}
              color={theme.colors.tertiary}
              style={{ transform: [{ rotate: `${-deg}deg` }] }}
            />
          </View>
          <Text variant="labelMedium" style={styles.label}>
            {heading === null ? '--' : `${Math.round(deg)}° ${headingToCardinal(deg)}`}
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
