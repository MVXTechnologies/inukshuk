import { Platform, StyleSheet, View } from 'react-native';
import { Button, Icon, Surface, Text, useTheme } from 'react-native-paper';

interface Props {
  visible: boolean;
  /** The user's choice: true → proceed to the system permission prompt. */
  onRespond: (allow: boolean) => void;
}

/**
 * Rationale shown before the "Allow all the time" system prompt. Android 11+
 * requires background location to be requested separately from foreground, and
 * Play policy expects an in-app explanation first; iOS shows its own upgrade
 * prompt but benefits from the same heads-up.
 *
 * Deliberately NOT a paper `<Portal>`/`<Dialog>`: this sits on the recording
 * path, and paper's Portal animations can leave an invisible touch-swallowing
 * overlay behind on devices with animations disabled (the #108 soft-lock,
 * seen on Samsung One UI). A conditionally-mounted absolute overlay has no
 * animation to get stuck; theme colors come from paper so it renders correctly
 * in light and dark mode.
 */
export function BackgroundLocationRationale({ visible, onRespond }: Props) {
  const theme = useTheme();
  if (!visible) return null;
  return (
    <View style={styles.scrim}>
      <Surface style={[styles.card, { backgroundColor: theme.colors.elevation.level3 }]}>
        <View style={styles.icon}>
          <Icon source="map-marker-path" size={28} color={theme.colors.secondary} />
        </View>
        <Text variant="headlineSmall" style={styles.title}>
          Record with the screen off
        </Text>
        <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
          {Platform.OS === 'android'
            ? 'To keep recording your trail while the screen is off or you switch apps, set ' +
              'location access to “Allow all the time” on the next screen.'
            : 'To keep recording your trail while the screen is off or you switch apps, allow ' +
              '“Always” location access on the next prompt.'}
          {' Your location is only used while a recording is running and never leaves your device.'}
        </Text>
        <View style={styles.actions}>
          <Button onPress={() => onRespond(false)}>Not now</Button>
          <Button mode="contained" onPress={() => onRespond(true)}>
            Continue
          </Button>
        </View>
      </Surface>
    </View>
  );
}

const styles = StyleSheet.create({
  scrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    justifyContent: 'center',
    padding: 24,
  },
  card: { borderRadius: 28, padding: 24 },
  icon: { alignItems: 'center', marginBottom: 12 },
  title: { textAlign: 'center', marginBottom: 12 },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 8,
    marginTop: 20,
  },
});
