import { EXTENSIONS } from '@core/extensions/registry';
import { StyleSheet, View } from 'react-native';

import { NavRow, SectionTitle, SubPanelHeader, SwitchRow } from '../../map/components/mapSheet';
import { TideLegend } from '../../map/components/TideLegend';
import { setExtensionPrefs, useExtensionPrefs } from '../prefs';
import type { ExtensionSubPanelProps } from '../types';
import { TideSources, useTideCoverage } from './TideSources';
import { useScaledStyles } from '@ui/displayScale';

/**
 * Map overlays › Extensions › Tide stations (#668): the switch, the gauge
 * symbols, Coverage & sources (each opens its licence; the same rows as in
 * Settings) and, with Geodetic points installed, the way to the tidal
 * benchmarks, which are a Geodetic points filter.
 */
export function TideSubPanel({ onBack, openSubPanel }: ExtensionSubPanelProps) {
  const styles = useScaledStyles(stylesSheet);

  const { show } = useExtensionPrefs('tides');
  const geodeticInstalled = useExtensionPrefs('geodetic').installedAt > 0;
  const coverage = useTideCoverage();
  const { label, summary } = EXTENSIONS.tides;
  return (
    <>
      <SubPanelHeader title={label} backLabel="Back to extensions" onBack={onBack} />
      <SwitchRow
        icon="waves"
        label="Show tide stations"
        hint={summary}
        value={show}
        onToggle={() => setExtensionPrefs('tides', { show: !show })}
      />
      <SectionTitle>Symbols</SectionTitle>
      <View style={styles.pad}>
        <TideLegend />
      </View>
      <SectionTitle>Coverage & sources</SectionTitle>
      <TideSources coverage={coverage} />
      {geodeticInstalled && (
        <NavRow
          icon="map-marker-radius-outline"
          label="Tidal benchmarks"
          hint="In Geodetic points › Tidal"
          onPress={() => openSubPanel('geodetic')}
        />
      )}
    </>
  );
}

const stylesSheet = StyleSheet.create({
  pad: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 6 },
});
