/**
 * Settings → Extensions → Geodetic points (`@core/map/geodeticStyle`):
 * - not installed: what it is, and "Get";
 * - installed: the layer switch (also in the overlays menu), "Offline in your
 *   regions" (companion packs for regions downloaded before the install; new
 *   regions carry the marks anyway), Coverage & sources (every source with
 *   its count, licence and credit), Remove.
 */
import { coverageRows, coverageSummary, formatCount } from '@core/geodetic/coverage';
import { formatBytes } from '@core/format';
import { refreshGeodeticCoverage } from '@data/geodeticCoverage';
import { useCompanionSync } from '@state/extensionSyncStore';
import { useGeodeticStore } from '@state/geodeticStore';
import { useOfflineStore } from '@state/offlineStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useEffect, useState } from 'react';
import { Linking, View } from 'react-native';
import { List, Switch, Text, TouchableRipple, useTheme } from 'react-native-paper';

import { GeodeticLegend } from '../../map/components/GeodeticLegend';
import { geodeticImage } from '../../map/geodeticImages';
import { setExtensionOffline } from '../actions';
import { refreshCompanions } from '../companions';
import { ExtensionSettingsShell, extensionRowStyles as styles } from '../ExtensionSettingsShell';
import { useExtensionPrefs } from '../prefs';

export function GeodeticSettings() {
  const tokens = useSchemeTokens();
  const theme = useTheme();
  const { offline } = useExtensionPrefs('geodetic');
  const coverage = useGeodeticStore((s) => s.coverage);
  const { companions, syncing, error } = useCompanionSync('geodetic');
  const regions = useOfflineStore((s) => s.regions);
  const [sourcesOpen, setSourcesOpen] = useState(false);

  useEffect(() => {
    void refreshGeodeticCoverage();
    void refreshCompanions('geodetic');
  }, []);

  const badge = geodeticImage(theme.dark ? 'dark' : 'light', '3d');
  const companionBytes = companions.reduce((n, c) => n + c.sizeBytes, 0);
  const covered = regions.filter(
    (r) =>
      (r.includes ?? []).includes('geodetic') || companions.some((c) => c.companionOf === r.id),
  );
  const offlineHint = syncing
    ? `Adding the marks to your regions… ${syncing.done}/${syncing.total}`
    : regions.length === 0
      ? 'New offline regions include the marks'
      : covered.length > 0
        ? `${covered.map((r) => r.label).join(', ')}${companionBytes > 0 ? ` · ${formatBytes(companionBytes)}` : ''}`
        : 'Your offline regions';

  return (
    <ExtensionSettingsShell
      extKey="geodetic"
      badge={badge}
      badgeIconSize={18}
      description="Every known survey mark and benchmark: 3D, horizontal, vertical and GNSS stations. Tap one for its summary and datasheet."
      legend={<GeodeticLegend />}
      note="Free · usually under 1 MB per offline region · included in the regions you download"
      showLabel="Show geodetic points"
      removeDescription={`Hides the layer${companionBytes > 0 ? ` and frees ${formatBytes(companionBytes)}` : ''}`}
      removeMessage="The marks leave the map and your offline regions. You can get them again any time."
    >
      <List.Item
        title="Offline in your regions"
        description={offlineHint}
        descriptionNumberOfLines={2}
        right={() => (
          <Switch
            value={offline}
            onValueChange={(v) => void setExtensionOffline('geodetic', v)}
            accessibilityLabel="Geodetic points offline in your regions"
          />
        )}
      />
      {error !== null && (
        <Text variant="bodySmall" style={[styles.pad, { color: theme.colors.error }]}>
          {error}
        </Text>
      )}
      <List.Item
        title="Coverage & sources"
        description={coverageSummary(coverage)}
        descriptionNumberOfLines={2}
        onPress={() => setSourcesOpen((o) => !o)}
        right={(p) => <List.Icon {...p} icon={sourcesOpen ? 'chevron-up' : 'chevron-right'} />}
        accessibilityLabel="Coverage & sources"
      />
      {sourcesOpen && (
        <View style={styles.sources}>
          {coverage === null ? (
            <Text variant="bodySmall" style={{ color: tokens.inkMuted }}>
              Counts load when you are online.
            </Text>
          ) : (
            coverageRows(coverage).map(({ source, marks }) => (
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
                    {formatCount(marks)}
                  </Text>
                </View>
              </TouchableRipple>
            ))
          )}
          <Text variant="bodySmall" style={[styles.note, { color: tokens.inkMuted }]}>
            Values are shown as each agency publishes them. Refreshed weekly.
          </Text>
        </View>
      )}
    </ExtensionSettingsShell>
  );
}
