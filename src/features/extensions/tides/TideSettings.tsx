/**
 * Settings → Extensions → Tide stations (`@core/map/tideStyle`):
 *
 * - not installed: what it is, and "Get";
 * - installed: the layer switch (also in Map overlays › Extensions), Coverage
 *   & sources (stations per source; Canada live from CHS), Remove.
 *
 * Tidal benchmarks belong to Geodetic points (its Tidal chip), not here.
 */
import { tideCoverageRows, tideCoverageSummary, type TideCoverage } from '@core/tides/coverage';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useEffect, useState } from 'react';
import { Linking, View } from 'react-native';
import { List, Text, TouchableRipple, useTheme } from 'react-native-paper';

import { TideLegend } from '../../map/components/TideLegend';
import { tideImage } from '../../map/tideImages';
import { ExtensionSettingsShell, extensionRowStyles as styles } from '../ExtensionSettingsShell';
import { fetchTideCoverage } from './coverage';

export function TideSettings() {
  const tokens = useSchemeTokens();
  const theme = useTheme();
  const [coverage, setCoverage] = useState<TideCoverage | null>(null);
  const [sourcesOpen, setSourcesOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    void fetchTideCoverage().then((c) => {
      if (alive && c) setCoverage(c);
    });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <ExtensionSettingsShell
      extKey="tides"
      badge={tideImage(theme.dark ? 'dark' : 'light', true)}
      badgeIconSize={20}
      description="Tide gauges with their published tidal levels in chart datum, the national datum and as ellipsoidal heights, and the live water level. Canada live from CHS."
      legend={<TideLegend />}
      note="Free · a few kB per offline region · not for navigation"
      showLabel="Show tide stations"
      removeDescription="Hides the layer"
      removeMessage="The stations leave the map. You can get them again any time."
    >
      <List.Item
        title="Tide coverage & sources"
        description={tideCoverageSummary(coverage)}
        descriptionNumberOfLines={2}
        onPress={() => setSourcesOpen((o) => !o)}
        right={(p) => <List.Icon {...p} icon={sourcesOpen ? 'chevron-up' : 'chevron-right'} />}
        accessibilityLabel="Tide coverage & sources"
      />
      {sourcesOpen && (
        <View style={styles.sources}>
          {tideCoverageRows(coverage).map(({ source, stations }) => (
            <TouchableRipple
              key={source.key}
              onPress={() => void Linking.openURL(source.licenceUrl)}
              accessibilityRole="link"
              accessibilityLabel={`${source.name}, ${source.licence}`}
            >
              <View style={styles.sourceRow}>
                <View style={styles.flex}>
                  <Text variant="bodyMedium">
                    {source.name}
                    <Text variant="bodySmall" style={{ color: tokens.inkVariant }}>
                      {` · ${source.network}`}
                    </Text>
                  </Text>
                  <Text variant="bodySmall" style={{ color: tokens.inkMuted }}>
                    {source.attribution}
                  </Text>
                </View>
                <Text variant="labelMedium" style={{ color: tokens.inkVariant }}>
                  {stations === null ? 'live' : stations.toLocaleString('en-US')}
                </Text>
              </View>
            </TouchableRipple>
          ))}
          <Text variant="bodySmall" style={[styles.note, { color: tokens.inkMuted }]}>
            Values are shown as each agency publishes them. Not for navigation.
          </Text>
        </View>
      )}
    </ExtensionSettingsShell>
  );
}
