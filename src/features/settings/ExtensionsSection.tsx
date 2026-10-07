/**
 * Settings → Extensions: layers you add to the map on purpose, each installed
 * on its own — every published extension of the registry
 * (`@features/extensions/settingsModules`), in registry order, each drawing its own
 * entry in the shared frame (`ExtensionSettingsShell`) — then, below a
 * divider, the device extensions this build can run (the external GNSS
 * receiver, #588).
 */
import { availableDeviceExtensions, availableExtensions } from '@features/extensions/availability';
import { EXTENSION_SETTINGS } from '@features/extensions/settingsModules';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';

export function ExtensionsSection() {
  const tokens = useSchemeTokens();
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
  return (
    <>
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
    </>
  );
}

const styles = StyleSheet.create({
  pad: { paddingHorizontal: 16, paddingVertical: 8 },
  divider: { height: StyleSheet.hairlineWidth, marginHorizontal: 16, marginVertical: 4 },
});
