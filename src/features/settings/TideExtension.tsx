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
import { useSettingsStore } from '@state/settingsStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useEffect, useState } from 'react';
import { Alert, Image, Linking, StyleSheet, View } from 'react-native';
import { Button, List, Switch, Text, TouchableRipple, useTheme } from 'react-native-paper';
import { TideLegend } from '../map/components/TideLegend';
import { tideImage } from '../map/tideImages';
import { fetchTideCoverage, installTides, removeTides } from './tidesExtension';

export function TideExtension() {
  const tokens = useSchemeTokens();
  const theme = useTheme();
  const installed = useSettingsStore((s) => s.tidesInstalledAt > 0);
  const show = useSettingsStore((s) => s.showTideStations);
  const set = useSettingsStore((s) => s.set);
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

  const badge = tideImage(theme.dark ? 'dark' : 'light', true);
  const badgeView = (inline: boolean) => (
    <View
      style={[
        styles.badge,
        inline && styles.badgeInline,
        { backgroundColor: tokens.surfaceVariant },
      ]}
    >
      {badge !== undefined && <Image source={badge} style={styles.badgeIcon} />}
    </View>
  );

  if (!installed) {
    return (
      <View style={styles.pad}>
        <View style={styles.getRow}>
          {badgeView(false)}
          <View style={styles.flex}>
            <Text variant="titleSmall">Tide stations</Text>
            <Text variant="bodySmall" style={{ color: tokens.inkVariant }}>
              Tide gauges with their published tidal levels in chart datum, the national datum and
              as ellipsoidal heights, and the live water level. Canada live from CHS.
            </Text>
          </View>
          <Button
            mode="contained"
            compact
            icon="download"
            onPress={installTides}
            accessibilityLabel="Get Tide stations"
          >
            Get
          </Button>
        </View>
        <View style={styles.legend}>
          <TideLegend />
        </View>
        <Text variant="bodySmall" style={[styles.note, { color: tokens.inkMuted }]}>
          Free · a few kB per offline region · not for navigation
        </Text>
      </View>
    );
  }

  const confirmRemove = () =>
    Alert.alert(
      'Remove Tide stations?',
      'The stations leave the map. You can get them again any time.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: removeTides },
      ],
    );

  return (
    <List.Section>
      <List.Item
        title="Tide stations"
        description={
          show
            ? 'On · Map overlays › Extensions'
            : 'Off · switch it on here or in Map overlays › Extensions'
        }
        left={() => badgeView(true)}
        right={() => (
          <Switch
            value={show}
            onValueChange={(v) => set('showTideStations', v)}
            accessibilityLabel="Show tide stations"
          />
        )}
      />
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
      <List.Item
        title="Remove extension"
        titleStyle={{ color: theme.colors.error }}
        description="Hides the layer"
        onPress={confirmRemove}
        accessibilityLabel="Remove Tide stations extension"
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
  badgeIcon: { width: 20, height: 20 },
  legend: { marginTop: 10, marginLeft: 48 },
  note: { marginTop: 8 },
  sources: { paddingHorizontal: 16, paddingBottom: 8, gap: 2 },
  sourceRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, gap: 8 },
});
