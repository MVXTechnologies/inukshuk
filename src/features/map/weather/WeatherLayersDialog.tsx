import { WEATHER_LAYERS, type WeatherLayerId } from '@core/geo/weatherLayers';
import { radarAvailableAt } from '@core/weather/modelCoverage';
import { useMapStore } from '@state/mapStore';
import { useSettingsStore } from '@state/settingsStore';
import { StyleSheet, View } from 'react-native';
import { Button, Dialog, Icon, Portal, Text, TouchableRipple } from 'react-native-paper';
import { weatherChrome as wc } from './weatherChrome';

/**
 * "Weather" picker (weather UX M1, reworked in wave A item 5): a dark
 * translucent panel — same fixed chrome in both themes as the
 * scrubber/legend, see weatherChrome.ts — listing one row per layer: a clear
 * layer ICON on a subtle dark disc beside its label (the gradient-ramp discs
 * read as identical rainbow blobs in the field; the legend pill keeps the
 * colour ramp, see WeatherLegend). The selected row wears an accent ring and
 * a bolder label.
 *
 * Playback lives on the scrubber's play button alone — the old "Animate"
 * checkbox here was a redundant second control and is gone (wave A item 2).
 *
 * User-invoked dialog, so Portal is safe here (the launch-path Portal ban in
 * [[paper-portal-touch-swallow]] doesn't apply). M2/M3 seam: rows render
 * from the catalog, so more layers (or per-model variants) just work.
 */

/** Per-layer icon (MaterialCommunityIcons). UI-only mapping — the catalog in
 * `@core/geo/weatherLayers` stays presentation-free. */
const LAYER_ICONS: Record<WeatherLayerId, string> = {
  'radar-rain': 'weather-pouring',
  'radar-snow': 'weather-snowy-heavy',
  temp: 'thermometer',
  wind: 'weather-windy',
  precip: 'weather-rainy',
};

export function WeatherLayersDialog({
  visible,
  onDismiss,
}: {
  visible: boolean;
  onDismiss: () => void;
}) {
  const weatherLayer = useSettingsStore((s) => s.weatherLayer);
  const set = useSettingsStore((s) => s.set);
  // Wave B: radar is a North American composite — while the map centre sits
  // outside it, the radar rows carry an honest "Canada only" hint (the rows
  // stay tappable; the drape just shows nothing there). Boolean selector, so
  // the dialog only re-renders when the answer flips at the coverage edge.
  const radarOutside = useMapStore((s) => !radarAvailableAt(s.mapCenter));

  const row = (id: WeatherLayerId | null, label: string, hint?: string) => {
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
          <View style={[styles.discRing, selected && styles.discRingSelected]}>
            <View style={styles.disc}>
              <Icon
                source={id === null ? 'eye-off-outline' : LAYER_ICONS[id]}
                size={22}
                color={id === null ? wc.inkMuted : wc.ink}
              />
            </View>
          </View>
          <View style={styles.rowText}>
            <Text style={[styles.rowLabel, selected && styles.rowLabelSelected]}>{label}</Text>
            {hint !== undefined && <Text style={styles.rowHint}>{hint}</Text>}
          </View>
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
          {row(null, 'None')}
          {WEATHER_LAYERS.map((l) =>
            row(l.id, l.label, l.timeline === 'past' && radarOutside ? 'Canada only' : undefined),
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

/** 40 px icon disc — same slot the old gradient thumbnail occupied. */
const DISC_D = 40;

const styles = StyleSheet.create({
  dialog: { backgroundColor: wc.panelSolid },
  title: { color: wc.ink },
  hint: { color: wc.inkMuted, fontSize: 12, lineHeight: 16, marginBottom: 10 },
  row: { borderRadius: 12, paddingVertical: 7, paddingHorizontal: 6 },
  rowInner: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  // Constant-size ring wrapper so selection never shifts the layout.
  discRing: {
    width: DISC_D + 6,
    height: DISC_D + 6,
    borderRadius: (DISC_D + 6) / 2,
    borderWidth: 2,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  discRingSelected: { borderColor: wc.accent },
  disc: {
    width: DISC_D,
    height: DISC_D,
    borderRadius: DISC_D / 2,
    backgroundColor: '#353B43',
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowText: { flex: 1 },
  rowLabel: { fontSize: 15, lineHeight: 20, color: wc.ink },
  rowLabelSelected: { fontWeight: '700' },
  rowHint: { fontSize: 11, lineHeight: 14, color: wc.inkFaint },
});
