import type { MapBasemap } from '@state/mapStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { StyleSheet } from 'react-native';
import { Text } from 'react-native-paper';

import { basemapAttribution } from '../mapStyle';

/**
 * The basemap's credit as tiny grey text on the map (#476, round 3), next to
 * the scale bar. It replaces the ⓘ button, whose corner now holds the tip
 * button; the full roll lives in Settings › System info › "Maps & data".
 *
 * Why text stays on the map at all: OpenStreetMap's attribution guidelines
 * and Esri's terms expect the credit visible on the map view itself, not only
 * in a settings screen. So it is always shown, but as quiet text rather than
 * a control; a tap opens Settings, where the full credits are.
 */
export function MapCreditText({ basemap, vector }: { basemap: MapBasemap; vector: boolean }) {
  const t = useSchemeTokens();
  const router = useRouter();
  const credit = basemapAttribution(basemap, vector);
  return (
    <Text
      onPress={() => router.push('/settings')}
      accessibilityRole="text"
      accessibilityHint="Full map credits are in Settings, System info"
      numberOfLines={1}
      style={[styles.credit, { color: t.map.chipInkMuted, backgroundColor: t.map.chip }]}
      testID="map-credit"
    >
      {credit}
    </Text>
  );
}

const styles = StyleSheet.create({
  // Readable over any tile and any label: a faint caption backing in the
  // map-chip colour (a text label, not a control — no border, no icon).
  credit: {
    alignSelf: 'flex-start',
    fontSize: 12,
    lineHeight: 15,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
    overflow: 'hidden',
  },
});
