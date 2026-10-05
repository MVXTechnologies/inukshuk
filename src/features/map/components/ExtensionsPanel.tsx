import { activeFilterCount } from '@core/geodetic/filter';
import { installedExtensions } from '@core/map/extensions';
import { useSettingsStore } from '@state/settingsStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { Button, Icon, Text } from 'react-native-paper';
import { useExtensionsState } from '../hooks/useExtensions';
import { GeodeticFilterButton } from './GeodeticFilterPanel';
import { GeodeticLegend } from './GeodeticLegend';
import { NavRow, SwitchRow, useSheetAccent } from './mapSheet';
import { TideLegend } from './TideLegend';

/**
 * Map overlays › Extensions tab (`@core/map/extensions`): each installed
 * extension's switch and legend — Geodetic points with its filter funnel and
 * badge — then "Get more extensions" (Settings → Extensions). With none
 * installed, a short empty state and a button to Settings → Extensions.
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
  const set = useSettingsStore((s) => s.set);
  const geodeticFilter = useSettingsStore((s) => s.geodeticFilter);
  const filterCount = activeFilterCount(geodeticFilter);
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
      {installed.includes('geodetic') && (
        <SwitchRow
          icon="map-marker-radius-outline"
          label="Geodetic points"
          hint={
            filterCount > 0
              ? `Filtered · ${filterCount} filter${filterCount === 1 ? '' : 's'}`
              : 'Survey marks and benchmarks'
          }
          value={ext.showGeodetic}
          onToggle={() => set('showGeodetic', !ext.showGeodetic)}
          accessory={<GeodeticFilterButton onPress={onOpenGeodeticFilter} />}
          below={
            <GeodeticLegend
              disabled={!ext.showGeodetic}
              types={geodeticFilter.types}
              tidal={geodeticFilter.tidal}
            />
          }
        />
      )}
      {installed.includes('tides') && (
        <SwitchRow
          icon="waves"
          label="Tide stations"
          hint="Gauges, tidal levels, chart datum"
          value={ext.showTideStations}
          onToggle={() => set('showTideStations', !ext.showTideStations)}
          below={<TideLegend disabled={!ext.showTideStations} />}
        />
      )}
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
