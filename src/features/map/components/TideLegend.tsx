import { Image, StyleSheet, View } from 'react-native';
import { Text, useTheme } from 'react-native-paper';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { tideImage } from '../tideImages';

/**
 * Under the overlays menu's "Tide stations" switch: the two station symbols
 * (filled = live gauge, hollow = predictions / historic), and the honest
 * coverage note — Canada's CHS stations are not in this layer (owner
 * decision: CHS stays live-only).
 */
export function TideLegend({ disabled = false }: { disabled?: boolean }) {
  const tokens = useSchemeTokens();
  const theme = useTheme().dark ? 'dark' : 'light';
  const color = disabled ? tokens.inkMuted : tokens.ink;
  const live = tideImage(theme, true);
  const pred = tideImage(theme, false);
  return (
    <View
      style={[styles.wrap, disabled && styles.disabled]}
      accessibilityLabel="Gauge symbols legend"
    >
      <View style={styles.row}>
        <View style={styles.entry}>
          {live !== undefined && <Image source={live} style={styles.icon} />}
          <Text variant="labelSmall" style={{ color }}>
            Live gauge
          </Text>
        </View>
        <View style={styles.entry}>
          {pred !== undefined && <Image source={pred} style={styles.icon} />}
          <Text variant="labelSmall" style={{ color }}>
            Predictions / historic
          </Text>
        </View>
      </View>
      <Text variant="labelSmall" style={{ color: tokens.inkMuted }}>
        USA, France, Norway, Japan · not for navigation
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 2 },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 12, rowGap: 4 },
  entry: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  icon: { width: 15, height: 15 },
  disabled: { opacity: 0.5 },
});
