import { Platform, StyleSheet } from 'react-native';
import { Button, Dialog, Portal, Text } from 'react-native-paper';

interface Props {
  visible: boolean;
  /** The user's choice: true → proceed to the system permission prompt. */
  onRespond: (allow: boolean) => void;
}

/**
 * Rationale shown before the "Allow all the time" system prompt. Android 11+
 * requires background location to be requested separately from foreground, and
 * Play policy expects an in-app explanation first; iOS shows its own upgrade
 * prompt but benefits from the same heads-up. Paper's Dialog follows the
 * active Paper theme, so this renders correctly in light and dark mode.
 */
export function BackgroundLocationRationaleDialog({ visible, onRespond }: Props) {
  return (
    <Portal>
      <Dialog visible={visible} onDismiss={() => onRespond(false)}>
        <Dialog.Icon icon="map-marker-path" />
        <Dialog.Title style={styles.title}>Record with the screen off</Dialog.Title>
        <Dialog.Content>
          <Text variant="bodyMedium">
            {Platform.OS === 'android'
              ? 'To keep recording your trail while the screen is off or you switch apps, set ' +
                'location access to “Allow all the time” on the next screen.'
              : 'To keep recording your trail while the screen is off or you switch apps, allow ' +
                '“Always” location access on the next prompt.'}
            {
              ' Your location is only used while a recording is running and never leaves your device.'
            }
          </Text>
        </Dialog.Content>
        <Dialog.Actions>
          <Button onPress={() => onRespond(false)}>Not now</Button>
          <Button mode="contained" onPress={() => onRespond(true)}>
            Continue
          </Button>
        </Dialog.Actions>
      </Dialog>
    </Portal>
  );
}

const styles = StyleSheet.create({
  title: { textAlign: 'center' },
});
