import { installedExtensions } from '@core/extensions/state';
import { EXTENSION_PANEL_ENTRIES } from '@features/extensions/panelEntries';
import { useExtensionsState } from '@features/extensions/prefs';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { Button, Icon, Text } from 'react-native-paper';
import { NavRow, useSheetAccent } from './mapSheet';

/**
 * Map overlays › Extensions tab (`@core/extensions/state`): each installed
 * extension's row (`@features/extensions/panelEntries`: switch and legend — Geodetic points with
 * its filter funnel and badge), in registry order, then "Get more extensions"
 * (Settings → Extensions). With none installed, a short empty state and a
 * button to Settings → Extensions.
 */
export function ExtensionsPanel({
  onOpenGeodeticFilter,
  onClose,
}: {
  onOpenGeodeticFilter: () => void;
  /** Close the overlays sheet (when leaving for Settings). */
  onClose: () => void;
}) {
  const tokens = useSchemeTokens();
  const { accent, onAccent } = useSheetAccent();
  const router = useRouter();
  const ext = useExtensionsState();
  const installed = installedExtensions(ext);
  const toSettings = () => {
    onClose();
    router.push({ pathname: '/settings', params: { open: 'extensions' } });
  };

  if (installed.length === 0) {
    return (
      <View style={styles.empty}>
        <Icon source="puzzle-outline" size={32} color={tokens.inkMuted} />
        <Text style={[styles.emptyTitle, { color: tokens.ink }]}>No extensions yet</Text>
        <Text style={[styles.emptyText, { color: tokens.inkMuted }]}>
          Add survey marks and benchmarks, or tide stations with their tidal levels, to the map.
        </Text>
        <Button
          mode="contained"
          icon="puzzle-plus-outline"
          onPress={toSettings}
          buttonColor={accent}
          textColor={onAccent}
          accessibilityLabel="Get extensions"
        >
          Get extensions
        </Button>
      </View>
    );
  }

  return (
    <>
      {installed.map((key) => {
        const PanelEntry = EXTENSION_PANEL_ENTRIES[key];
        return <PanelEntry key={key} onOpenGeodeticFilter={onOpenGeodeticFilter} />;
      })}
      <NavRow
        icon="puzzle-plus-outline"
        label="Get more extensions"
        hint="Settings › Extensions"
        onPress={toSettings}
      />
    </>
  );
}

const styles = StyleSheet.create({
  empty: { alignItems: 'center', gap: 8, paddingHorizontal: 24, paddingVertical: 20 },
  emptyTitle: { fontSize: 16, fontWeight: '700' },
  emptyText: { fontSize: 13, lineHeight: 18, textAlign: 'center', marginBottom: 6 },
});
