import { Image, StyleSheet, View } from 'react-native';
import { Text, useTheme } from 'react-native-paper';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { geodeticImage } from '../geodeticImages';

const ENTRIES = [
  { kind: '3d', label: '3D' },
  { kind: 'h', label: 'Horiz.' },
  { kind: 'v', label: 'Vert.' },
  { kind: 'gnss', label: 'GNSS' },
] as const;

/**
 * The four mark symbols with their names (overlays menu and Settings →
 * Extensions), plus "hollow = legacy datum". Same images as the map.
 */
export function GeodeticLegend({ disabled = false }: { disabled?: boolean }) {
  const tokens = useSchemeTokens();
  const theme = useTheme().dark ? 'dark' : 'light';
  const color = disabled ? tokens.inkMuted : tokens.ink;
  return (
    <View
      style={[styles.row, disabled && styles.disabled]}
      accessibilityLabel="Geodetic points legend"
    >
      {ENTRIES.map((e) => {
        const src = geodeticImage(theme, e.kind);
        return (
          <View key={e.kind} style={styles.entry}>
            {src !== undefined && <Image source={src} style={styles.icon} />}
            <Text variant="labelSmall" style={{ color }}>
              {e.label}
            </Text>
          </View>
        );
      })}
      <View style={styles.entry}>
        {geodeticImage(theme, 'v', true) !== undefined && (
          <Image source={geodeticImage(theme, 'v', true)} style={styles.icon} />
        )}
        <Text variant="labelSmall" style={{ color: tokens.inkMuted }}>
          Legacy
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 12, rowGap: 4 },
  entry: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  icon: { width: 14, height: 14 },
  disabled: { opacity: 0.5 },
});
