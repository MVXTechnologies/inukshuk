import { Pressable, StyleSheet, View } from 'react-native';
import { Text, useTheme } from 'react-native-paper';

export interface Detent<V> {
  value: V;
  /** Short label; doubles as the tick's accessibility label. */
  label: string;
}

interface Props<V> {
  detents: readonly Detent<V>[];
  selected: V;
  onSelect: (value: V) => void;
  /** Track width in dp (the row's remaining space, minus the value label). */
  width?: number;
  disabled?: boolean;
}

/**
 * A compact discrete slider for menu rows: a track with one tappable detent
 * per option and a thumb on the selection, current label at the end. Chosen
 * over stacked Menu.Items because five rows per selector made the Layers menu
 * outgrow small screens (the 1.2.0 iOS E2E fold bug), and over a pan slider
 * because tap-per-detent stays deterministic for Maestro and screen readers
 * (each detent keeps the label the old rows had).
 */
export function DetentSlider<V>({ detents, selected, onSelect, width = 116, disabled }: Props<V>) {
  const theme = useTheme();
  const i = Math.max(
    0,
    detents.findIndex((d) => d.value === selected),
  );
  const current = detents[i]!;
  const step = width / (detents.length - 1);

  return (
    <View style={styles.row} pointerEvents={disabled ? 'none' : 'auto'}>
      <View style={[styles.trackBox, { width }]}>
        <View style={[styles.track, { backgroundColor: theme.colors.surfaceVariant }]} />
        <View
          style={[
            styles.trackFill,
            { width: i * step, backgroundColor: theme.colors.primary, opacity: 0.4 },
          ]}
        />
        {detents.map((d, j) => (
          <Pressable
            key={d.label}
            onPress={() => onSelect(d.value)}
            accessibilityRole="button"
            accessibilityLabel={d.label}
            accessibilityState={{ selected: j === i }}
            // Ticks sit ~29 dp apart; generous hitSlop keeps them finger-sized.
            hitSlop={{ top: 16, bottom: 16, left: step / 2 - 4, right: step / 2 - 4 }}
            style={[styles.tick, { left: j * step - 3 }]}
          >
            <View
              style={[
                styles.tickDot,
                {
                  backgroundColor: j === i ? theme.colors.primary : theme.colors.outlineVariant,
                },
                j === i && styles.thumb,
              ]}
            />
          </Pressable>
        ))}
      </View>
      <Text variant="labelMedium" style={[styles.valueLabel, { color: theme.colors.primary }]}>
        {current.label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  trackBox: { height: 28, justifyContent: 'center' },
  track: { position: 'absolute', left: 0, right: 0, height: 2, borderRadius: 1 },
  trackFill: { position: 'absolute', left: 0, height: 2, borderRadius: 1 },
  tick: { position: 'absolute', top: 11, width: 6, height: 6 },
  tickDot: { width: 6, height: 6, borderRadius: 3 },
  thumb: {
    width: 12,
    height: 12,
    borderRadius: 6,
    marginLeft: -3,
    marginTop: -3,
  },
  valueLabel: { minWidth: 56, textAlign: 'right' },
});
