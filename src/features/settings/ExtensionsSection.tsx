/**
 * Settings → Extensions: layers you add to the map on purpose, each installed
 * on its own (`@core/map/extensions`): Geodetic points, Tide stations and
 * Climbing crags (`@features/climbing/ClimbingExtension`).
 *
 * Geodetic points (`@core/map/geodeticStyle`):
 * - not installed: what it is, and "Get";
 * - installed: the layer switch (also in the overlays menu), "Offline in your
 *   regions" (companion packs for regions downloaded before the install; new
 *   regions carry the marks anyway), Coverage & sources (every source with
 *   its count, licence and credit), Remove.
 */
import { coverageRows, coverageSummary, formatCount } from '@core/geodetic/coverage';
import { formatBytes } from '@core/format';
import { geodeticTilesUrl, tideTilesUrl } from '@data/basemapTiles';
import { TideExtension } from './TideExtension';
import { cragTilesUrl } from '@data/climbing';
import { ClimbingExtension } from '../climbing/ClimbingExtension';
import { useGeodeticStore } from '@state/geodeticStore';
import { useOfflineStore } from '@state/offlineStore';
import { useSettingsStore } from '@state/settingsStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useEffect, useState } from 'react';
import { Alert, Image, Linking, StyleSheet, View } from 'react-native';
import { Button, List, Switch, Text, TouchableRipple, useTheme } from 'react-native-paper';
import { GeodeticLegend } from '../map/components/GeodeticLegend';
import { geodeticImage } from '../map/geodeticImages';
import {
  installGeodetic,
  refreshCompanions,
  refreshGeodeticCoverage,
  removeGeodetic,
  setGeodeticOffline,
} from './geodeticExtension';

export function ExtensionsSection() {
  const tokens = useSchemeTokens();
  if (geodeticTilesUrl() === null && tideTilesUrl() === null && cragTilesUrl() === null) {
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
      {geodeticTilesUrl() !== null && <GeodeticExtension />}
      {tideTilesUrl() !== null && <TideExtension />}
      {cragTilesUrl() !== null && <ClimbingExtension />}
    </>
  );
}

function GeodeticExtension() {
  const tokens = useSchemeTokens();
  const theme = useTheme();
  const installed = useSettingsStore((s) => s.geodeticInstalledAt > 0);
  const show = useSettingsStore((s) => s.showGeodetic);
  const offline = useSettingsStore((s) => s.geodeticOffline);
  const set = useSettingsStore((s) => s.set);
  const coverage = useGeodeticStore((s) => s.coverage);
  const companions = useGeodeticStore((s) => s.companions);
  const syncing = useGeodeticStore((s) => s.syncing);
  const error = useGeodeticStore((s) => s.error);
  const regions = useOfflineStore((s) => s.regions);
  const [sourcesOpen, setSourcesOpen] = useState(false);

  useEffect(() => {
    void refreshGeodeticCoverage();
    void refreshCompanions();
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

  if (!installed) {
    return (
      <View style={styles.pad}>
        <View style={styles.getRow}>
          <View style={[styles.badge, { backgroundColor: tokens.surfaceVariant }]}>
            {badge !== undefined && <Image source={badge} style={styles.badgeIcon} />}
          </View>
          <View style={styles.flex}>
            <Text variant="titleSmall">Geodetic points</Text>
            <Text variant="bodySmall" style={{ color: tokens.inkVariant }}>
              Every known survey mark and benchmark: 3D, horizontal, vertical and GNSS stations. Tap
              one for its summary and datasheet.
            </Text>
          </View>
          <Button
            mode="contained"
            compact
            icon="download"
            onPress={installGeodetic}
            accessibilityLabel="Get Geodetic points"
          >
            Get
          </Button>
        </View>
        <View style={styles.legend}>
          <GeodeticLegend />
        </View>
        <Text variant="bodySmall" style={[styles.note, { color: tokens.inkMuted }]}>
          Free · usually under 1 MB per offline region · included in the regions you download
        </Text>
      </View>
    );
  }

  const confirmRemove = () =>
    Alert.alert(
      'Remove Geodetic points?',
      'The marks leave the map and your offline regions. You can get them again any time.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: () => void removeGeodetic() },
      ],
    );

  return (
    <List.Section>
      <List.Item
        title="Geodetic points"
        description={
          show
            ? 'On · Map overlays › Extensions'
            : 'Off · switch it on here or in Map overlays › Extensions'
        }
        left={() => (
          <View
            style={[styles.badge, styles.badgeInline, { backgroundColor: tokens.surfaceVariant }]}
          >
            {badge !== undefined && <Image source={badge} style={styles.badgeIcon} />}
          </View>
        )}
        right={() => (
          <Switch
            value={show}
            onValueChange={(v) => set('showGeodetic', v)}
            accessibilityLabel="Show geodetic points"
          />
        )}
      />
      <List.Item
        title="Offline in your regions"
        description={offlineHint}
        descriptionNumberOfLines={2}
        right={() => (
          <Switch
            value={offline}
            onValueChange={(v) => void setGeodeticOffline(v)}
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
      <List.Item
        title="Remove extension"
        titleStyle={{ color: theme.colors.error }}
        description={`Hides the layer${companionBytes > 0 ? ` and frees ${formatBytes(companionBytes)}` : ''}`}
        onPress={confirmRemove}
        accessibilityLabel="Remove Geodetic points extension"
      />
    </List.Section>
  );
}

const styles = StyleSheet.create({
  pad: { paddingHorizontal: 16, paddingVertical: 8 },
  getRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  flex: { flex: 1 },
  badge: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeInline: { marginLeft: 8 },
  badgeIcon: { width: 18, height: 18 },
  legend: { marginTop: 10, marginLeft: 48 },
  note: { marginTop: 8 },
  sources: { paddingHorizontal: 16, paddingBottom: 8, gap: 2 },
  sourceRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, gap: 8 },
});
