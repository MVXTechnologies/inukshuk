/**
 * Settings → Extensions: layers you add to the map on purpose, each installed
 * on its own — every published extension of the registry
 * (`@features/extensions/settingsModules`), in registry order, each drawing its own
 * entry in the shared frame (`ExtensionSettingsShell`).
 */
import { availableExtensions } from '@features/extensions/availability';
import { EXTENSION_SETTINGS } from '@features/extensions/settingsModules';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';

export function ExtensionsSection() {
  const tokens = useSchemeTokens();
  const available = availableExtensions();
  if (available.length === 0) {
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
    </>
  );
}

const styles = StyleSheet.create({
  pad: { paddingHorizontal: 16, paddingVertical: 8 },
});
