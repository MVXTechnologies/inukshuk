import { WEATHER_LAYERS, type WeatherLayerId } from '@core/geo/weatherLayers';
import { interpolateRamp } from '@core/weather/colorRamp';
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
} from 'react-native-paper';
import { weatherChrome as wc } from './weatherChrome';

/**
 * "Weather" picker (weather UX M1, the Windy idiom): a dark translucent
 * panel — same fixed chrome in both themes as the scrubber/legend, see
 * weatherChrome.ts — listing one row per layer: a circular thumbnail of the
 * layer's colour ramp (smoothly interpolated from its swatch stops — plain
 * Views, no binary assets, OTA-clean) beside its label. The selected row
 * wears an accent ring and a bolder label. The Animate toggle is "play"
 * over the layer's scrubber timeline.
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
        borderless
      >
        <View style={styles.rowInner}>
          <View style={[styles.thumbRing, selected && styles.thumbRingSelected]}>
            <View style={styles.thumb}>
              {swatch !== null ? (
                interpolateRamp(swatch, THUMB_STEPS).map((color, i) => (
                  // Colours can repeat after interpolation; suffix the position.
                  <View
                    key={`${color}-${i}`}
                    style={[styles.thumbStep, { backgroundColor: color }]}
                  />
                ))
              ) : (
                <View style={styles.thumbOff}>
                  <Icon source="eye-off-outline" size={17} color={wc.inkMuted} />
                </View>
              )}
            </View>
          </View>
          <Text style={[styles.rowLabel, selected && styles.rowLabelSelected]}>{label}</Text>
          {selected && <Icon source="check" size={18} color={wc.accent} />}
        </View>
      </TouchableRipple>
    );
  };

  return (
    <Portal>
      <Dialog visible={visible} onDismiss={onDismiss} style={styles.dialog}>
        <Dialog.Title style={styles.title}>Weather</Dialog.Title>
        <Dialog.Content>
          <Text style={styles.hint}>
            Live layers from Environment and Climate Change Canada, draped over the map. Needs a
            connection; hidden while &quot;Locally downloaded only&quot; is on.
          </Text>
          {row(null, 'None', null)}
          {WEATHER_LAYERS.map((l) => row(l.id, l.label, l.swatch))}
          {weatherLayer !== null && (
            <>
              <Divider style={styles.divider} />
              <Checkbox.Item
                label="Animate"
                status={animating ? 'checked' : 'unchecked'}
                onPress={toggleAnimation}
                position="leading"
                labelStyle={styles.animateLabel}
                color={wc.accent}
                uncheckedColor={wc.inkMuted}
              />
            </>
          )}
        </Dialog.Content>
        <Dialog.Actions>
          <Button onPress={onDismiss} textColor={wc.accent}>
            Done
          </Button>
        </Dialog.Actions>
      </Dialog>
    </Portal>
  );
}

/** 40 px circle over 16 interpolated bands ≈ a smooth gradient disc. */
const THUMB_STEPS = 16;
const THUMB_D = 40;

const styles = StyleSheet.create({
  dialog: { backgroundColor: wc.panelSolid },
  title: { color: wc.ink },
  hint: { color: wc.inkMuted, fontSize: 12, lineHeight: 16, marginBottom: 10 },
  row: { borderRadius: 12, paddingVertical: 7, paddingHorizontal: 6 },
  rowInner: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  // Constant-size ring wrapper so selection never shifts the layout.
  thumbRing: {
    width: THUMB_D + 6,
    height: THUMB_D + 6,
    borderRadius: (THUMB_D + 6) / 2,
    borderWidth: 2,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbRingSelected: { borderColor: wc.accent },
  thumb: {
    width: THUMB_D,
    height: THUMB_D,
    borderRadius: THUMB_D / 2,
    overflow: 'hidden',
    flexDirection: 'row',
  },
  thumbStep: { flex: 1 },
  thumbOff: { flex: 1, backgroundColor: '#353B43', alignItems: 'center', justifyContent: 'center' },
  rowLabel: { flex: 1, fontSize: 15, lineHeight: 20, color: wc.ink },
  rowLabelSelected: { fontWeight: '700' },
  divider: { backgroundColor: wc.hairline, marginTop: 4 },
  animateLabel: { textAlign: 'left', color: wc.ink },
});
