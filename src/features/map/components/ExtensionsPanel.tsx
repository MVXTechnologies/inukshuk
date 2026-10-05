import { activeFilterCount } from '@core/geodetic/filter';
import { installedExtensions } from '@core/map/extensions';
import { useSettingsStore } from '@state/settingsStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { Icon, Text, TouchableRipple } from 'react-native-paper';
import { useExtensionsState } from '../hooks/useExtensions';
import { GeodeticFilterButton } from './GeodeticFilterPanel';
import { GeodeticLegend } from './GeodeticLegend';
import { NavRow, SwitchRow } from './mapSheet';
import { TideLegend } from './TideLegend';

/**
 * Map overlays › Extensions (`@core/map/extensions`): each installed
 * extension's switch and legend — Geodetic points with its filter funnel and
 * badge — then "Get more extensions" (Settings → Extensions).
 */
export function ExtensionsPanel({
  onBack,
  onOpenGeodeticFilter,
  onClose,
}: {
  onBack: () => void;
  onOpenGeodeticFilter: () => void;
  /** Close the overlays sheet (when leaving for Settings). */
  onClose: () => void;
}) {
  const tokens = useSchemeTokens();
  const router = useRouter();
  const ext = useExtensionsState();
  const installed = installedExtensions(ext);
  const set = useSettingsStore((s) => s.set);
  const geodeticFilter = useSettingsStore((s) => s.geodeticFilter);
  const filterCount = activeFilterCount(geodeticFilter);

  return (
    <>
      <TouchableRipple
        onPress={onBack}
        accessibilityLabel="Back to overlays"
        style={styles.backRow}
        borderless
      >
        <View style={styles.backInner}>
          <Icon source="chevron-left" size={24} color={tokens.ink} />
          <Text style={[styles.backTitle, { color: tokens.ink }]}>Extensions</Text>
        </View>
      </TouchableRipple>

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
        onPress={() => {
          onClose();
          router.push({ pathname: '/settings', params: { open: 'extensions' } });
        }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  backRow: { borderRadius: 12, marginHorizontal: 4 },
  backInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 48,
    paddingHorizontal: 8,
  },
  backTitle: { fontSize: 15, lineHeight: 20, fontWeight: '700' },
});
