/**
 * Settings → Extensions: layers you add to the map on purpose, each installed
 * on its own — every published extension of the registry
 * (`@features/extensions/settingsModules`), in registry order, each drawing its own
 * entry in the shared frame (`ExtensionSettingsShell`): a one-line row that
 * expands to its details, one at a time (`@features/extensions/expansion`) —
 * then, below a divider, the device extensions this build can run (the
 * external GNSS receiver, #588), in the same accordion.
 */
import { availableDeviceExtensions, availableExtensions } from '@features/extensions/availability';
import { ExtensionExpansionProvider } from '@features/extensions/expansion';
import { EXTENSION_SETTINGS } from '@features/extensions/settingsModules';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';
import { useReducedMotion } from 'react-native-reanimated';

export function ExtensionsSection({
  openExtension,
}: {
  /** The extension a deep link opens (`extensionSettingsHref`); others start collapsed. */
  openExtension?: string;
}) {
  const tokens = useSchemeTokens();
  const reduceMotion = useReducedMotion();
  const available = availableExtensions();
  const devices = availableDeviceExtensions();
  if (available.length === 0 && devices.length === 0) {
    return (
      <View style={styles.pad}>
        <Text variant="bodySmall" style={{ color: tokens.inkVariant }}>
          No extensions yet.
        </Text>
      </View>
    );
  }
  const initialOpen = [...available, ...devices].find((k) => k === openExtension) ?? null;
  return (
    <ExtensionExpansionProvider initialOpen={initialOpen} reduceMotion={reduceMotion}>
      {available.map((key) => {
        const { Settings } = EXTENSION_SETTINGS[key];
        return <Settings key={key} />;
      })}
      {devices.length > 0 && available.length > 0 && (
        <View style={[styles.divider, { backgroundColor: tokens.outlineVariant }]} />
      )}
      {devices.map((key) => {
        const { Settings } = EXTENSION_SETTINGS[key];
        return <Settings key={key} />;
      })}
    </ExtensionExpansionProvider>
  );
}

const styles = StyleSheet.create({
  pad: { paddingHorizontal: 16, paddingVertical: 8 },
  divider: { height: StyleSheet.hairlineWidth, marginHorizontal: 16, marginVertical: 4 },
});
