import type { StatTile } from '@core/library/trailViewText';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Text } from 'react-native-paper';

interface Props {
  tiles: readonly StatTile[];
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * The trail view's stat tiles (#511, board C2), three to a row: a bold value,
 * an optional small line under it, then the label. Shared by the Overview tab
 * and the map's tap-a-trail sheet, so both read the same.
 */
export function StatTiles({ tiles, style, testID }: Props) {
  const t = useSchemeTokens();
  return (
    <View style={[styles.grid, style]} testID={testID}>
      {tiles.map((tile) => (
        <View
          key={tile.label}
          style={styles.tile}
          accessible
          accessibilityLabel={`${tile.label} ${tile.value}${tile.sub ? `, ${tile.sub}` : ''}`}
        >
          <Text style={[styles.value, { color: t.ink }]} numberOfLines={1} adjustsFontSizeToFit>
            {tile.value}
          </Text>
          {tile.sub ? (
            <Text style={[styles.sub, { color: t.inkVariant }]} numberOfLines={1}>
              {tile.sub}
            </Text>
          ) : null}
          <Text style={[styles.label, { color: t.inkMuted }]} numberOfLines={1}>
            {tile.label}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 14 },
  tile: { width: '33.33%', paddingRight: 8 },
  value: { fontSize: 18, fontWeight: '800' },
  sub: { fontSize: 12 },
  label: { fontSize: 12, marginTop: 1 },
});
