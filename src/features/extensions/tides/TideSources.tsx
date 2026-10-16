/**
 * Tide stations' Coverage & sources, one source for both places it shows:
 * Settings › Extensions › Tide stations (inside its collapsible row) and the
 * overlays sheet's Tide stations sub-panel (#668). Each source opens its
 * licence; the counts come from the tide archive's TileJSON (`./coverage`).
 */
import { tideCoverageRows, type TideCoverage } from '@core/tides/coverage';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useEffect, useState } from 'react';
import { Linking, View } from 'react-native';
import { Text, TouchableRipple } from '@ui/paper';

import { extensionRowStylesSheet as stylesSheet } from '../rowStyles';
import { fetchTideCoverage } from './coverage';
import { useScaledStyles } from '@ui/displayScale';

/** The stations per source, fetched once per mount; null until (or while offline). */
export function useTideCoverage(): TideCoverage | null {
  const [coverage, setCoverage] = useState<TideCoverage | null>(null);
  useEffect(() => {
    let alive = true;
    void fetchTideCoverage().then((c) => {
      if (alive && c) setCoverage(c);
    });
    return () => {
      alive = false;
    };
  }, []);
  return coverage;
}

/** Not for navigation: said under the sources wherever they show. */
export const TIDE_SOURCES_NOTE =
  'Values are shown as each agency publishes them. Not for navigation.';

/** One row per source (name · network, attribution, stations or "live") and the note. */
export function TideSources({ coverage }: { coverage: TideCoverage | null }) {
  const styles = useScaledStyles(stylesSheet);

  const tokens = useSchemeTokens();
  return (
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
        {TIDE_SOURCES_NOTE}
      </Text>
    </View>
  );
}
