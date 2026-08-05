import { StyleSheet, View } from 'react-native';
import { Text, useTheme } from 'react-native-paper';

interface StatTileProps {
  label: string;
  value: string;
  /** Optional accent colour for the value (e.g. ascent green, descent red). */
  color?: string;
  /** Smaller footprint (narrower min width, titleSmall value) — the live
   * recording HUD's expanded card (item 3: made smaller). */
  compact?: boolean;
}

/** A compact label-over-value tile used across the live HUD and track details. */
export function StatTile({ label, value, color, compact = false }: StatTileProps) {
  const theme = useTheme();
  return (
    <View style={[styles.container, compact && styles.containerCompact]}>
      <Text variant="labelSmall" style={[styles.label, { color: theme.colors.onSurfaceVariant }]}>
        {label}
      </Text>
      <Text
        variant={compact ? 'titleSmall' : 'titleMedium'}
        style={[styles.value, color ? { color } : null]}
      >
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    minWidth: 72,
    alignItems: 'center',
    paddingVertical: 4,
  },
  containerCompact: {
    minWidth: 52,
    paddingVertical: 2,
  },
  label: {
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  value: {
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
});
