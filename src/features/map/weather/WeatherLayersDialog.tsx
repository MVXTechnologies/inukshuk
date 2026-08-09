import { WEATHER_LAYERS, type WeatherLayerId } from '@core/geo/weatherLayers';
import { useMapStore } from '@state/mapStore';
import { useSettingsStore } from '@state/settingsStore';
import { StyleSheet, View } from 'react-native';
import {
  Button,
  Checkbox,
  Dialog,
  Divider,
  Icon,
  Portal,
  Text,
  TouchableRipple,
  useTheme,
} from 'react-native-paper';

/**
 * "Weather" picker (weather UX M1): one live ECCC GeoMet layer at a time,
 * chosen from thumbnail rows in the basemap-picker idiom (label left, a
 * banner strip right — see BasemapRows) rather than radio buttons. The
 * banner is the layer's legend colour ramp rendered as stepped gradient
 * segments: plain Views, no binary assets, OTA-clean. The Animate toggle is
 * "play" over the layer's scrubber timeline — radar loops its ~3 h past,
 * model layers their ~48 h forecast.
 *
 * User-invoked dialog, so Portal is safe here (the launch-path Portal ban in
 * [[paper-portal-touch-swallow]] doesn't apply). M2/M3 seam: rows render
 * from the catalog, so more layers (or per-model variants) just work.
 */
export function WeatherLayersDialog({
  visible,
  onDismiss,
}: {
  visible: boolean;
  onDismiss: () => void;
}) {
  const theme = useTheme();
  const weatherLayer = useSettingsStore((s) => s.weatherLayer);
  const set = useSettingsStore((s) => s.set);
  const animating = useMapStore((s) => s.weatherAnimating);
  const toggleAnimation = useMapStore((s) => s.toggleWeatherAnimation);

  const row = (id: WeatherLayerId | null, label: string, swatch: readonly string[] | null) => {
    const selected = weatherLayer === id;
    return (
      <TouchableRipple
        key={id ?? 'none'}
        onPress={() => set('weatherLayer', id)}
        accessibilityLabel={label}
        style={styles.row}
      >
        <View style={styles.rowInner}>
          <View style={styles.labelBox}>
            {selected && <Icon source="check" size={16} />}
            <Text variant="bodyLarge">{label}</Text>
          </View>
          <View
            style={[
              styles.banner,
              selected && { borderWidth: 2, borderColor: theme.colors.primary },
            ]}
          >
            {swatch !== null ? (
              // Stepped legend ramp — the layer's "map look" thumbnail.
              swatch.map((color) => (
                <View key={color} style={[styles.swatchStep, { backgroundColor: color }]} />
              ))
            ) : (
              <View style={[styles.swatchStep, { backgroundColor: theme.colors.surfaceVariant }]} />
            )}
          </View>
        </View>
      </TouchableRipple>
    );
  };

  return (
    <Portal>
      <Dialog visible={visible} onDismiss={onDismiss}>
        <Dialog.Title>Weather</Dialog.Title>
        <Dialog.Content>
          <Text variant="bodySmall" style={styles.hint}>
            Live layers from Environment and Climate Change Canada, draped over the map. Needs a
            connection; hidden while &quot;Locally downloaded only&quot; is on.
          </Text>
          {row(null, 'None', null)}
          {WEATHER_LAYERS.map((l) => row(l.id, l.label, l.swatch))}
          {weatherLayer !== null && (
            <>
              <Divider />
              <Checkbox.Item
                label="Animate"
                status={animating ? 'checked' : 'unchecked'}
                onPress={toggleAnimation}
                position="leading"
                labelStyle={styles.leftLabel}
              />
            </>
          )}
        </Dialog.Content>
        <Dialog.Actions>
          <Button onPress={onDismiss}>Done</Button>
        </Dialog.Actions>
      </Dialog>
    </Portal>
  );
}

const styles = StyleSheet.create({
  hint: { opacity: 0.7, marginBottom: 4 },
  row: { paddingVertical: 7, paddingHorizontal: 4, borderRadius: 8 },
  rowInner: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  labelBox: { flexDirection: 'row', alignItems: 'center', gap: 6, width: 118 },
  banner: {
    flex: 1,
    flexDirection: 'row',
    borderRadius: 7,
    overflow: 'hidden',
    height: 24,
  },
  swatchStep: { flex: 1 },
  leftLabel: { textAlign: 'left' },
});
