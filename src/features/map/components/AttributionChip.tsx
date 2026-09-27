import type { MapBasemap } from '@state/mapStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';
import { basemapAttribution } from '../mapStyle';

/**
 * The basemap's credit, bottom-right on a paper chip (revamp `Main.html`).
 * MapLibre's own attribution button stays off (it crowded the map); the full
 * credits roll is in Settings › System info.
 */
export function AttributionChip({ basemap }: { basemap: MapBasemap }) {
  const tokens = useSchemeTokens();
  return (
    <View style={[styles.chip, { backgroundColor: tokens.map.chip }]} pointerEvents="none">
      <Text style={[styles.label, { color: tokens.map.chipInkMuted }]}>
        {basemapAttribution(basemap)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  label: { fontSize: 12 },
});
