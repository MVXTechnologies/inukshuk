import type { WeatherLayerId } from '@core/geo/weatherLayers';
import type { LatLng } from '@core/models';
import { pointReadoutText } from '@core/weather/pointReadout';
import type { WeatherModelId } from '@core/weather/weatherModels';
import { useSettingsStore } from '@state/settingsStore';
import { StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';
import { useWeatherPointValue } from './useWeatherPointValue';
import { weatherChrome as wc } from './weatherChrome';

/**
 * Tap-anywhere point-value chip (wave A item 7, the Windy picker idiom):
 * with a weather layer draped, a single tap on bare map drops this compact
 * dark chip at the tapped spot — "14° · HRDPS · Sun 14:00" — the gridded
 * GetFeatureInfo value for the active layer/model at the SCRUBBED time.
 * Scrubbing while the chip is up refetches it for the new frame.
 *
 * Rendered inside a MapLibre <Marker anchor="bottom">: chip above a pointer
 * tail above a small anchor dot. pointerEvents none — taps fall through to
 * the map, where MapScreen's onMapPress hit-tests the chip for dismissal
 * (Marker onPress doesn't fire on Android — the waypoint-pin precedent).
 * Fixed dark weather chrome in both themes, plain Views only.
 */
export function WeatherPointChip({
  at,
  layer,
  model,
  timeIso,
  selectedMs,
}: {
  at: LatLng;
  layer: WeatherLayerId;
  model: WeatherModelId;
  /** The drape's committed (throttled) WMS TIME — what the value is pinned to. */
  timeIso: string | undefined;
  /** Scrubbed frame epoch-ms, for the readout's time segment. */
  selectedMs: number | null;
}) {
  const { status, value } = useWeatherPointValue(at, layer, model, timeIso);
  const units = useSettingsStore((s) => s.units);

  // Prefer the server's own valid time for the readout (truth over intent);
  // fall back to the scrubbed frame while loading / when absent.
  const serverMs = value?.time != null ? Date.parse(value.time) : NaN;
  const timeMs = Number.isFinite(serverMs) ? serverMs : selectedMs;

  const text =
    status === 'ready' && value !== null
      ? pointReadoutText(layer, model, value.value, units === 'imperial', timeMs)
      : status === 'loading'
        ? '…'
        : 'No data';

  return (
    <View style={styles.wrap} pointerEvents="none" accessibilityLabel="Weather point value">
      <View style={styles.chip}>
        <Text style={styles.chipText} numberOfLines={1}>
          {text}
        </Text>
      </View>
      <View style={styles.tail} />
      <View style={styles.dot} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center' },
  chip: {
    backgroundColor: wc.panel,
    borderRadius: 13,
    paddingHorizontal: 10,
    paddingVertical: 5,
    maxWidth: 220,
  },
  chipText: {
    fontSize: 12,
    lineHeight: 15,
    fontWeight: '700',
    color: wc.ink,
    fontVariant: ['tabular-nums'],
  },
  tail: {
    width: 8,
    height: 8,
    marginTop: -5,
    borderRadius: 1.5,
    backgroundColor: wc.panel,
    transform: [{ rotate: '45deg' }],
  },
  // Small accent anchor dot sitting exactly on the tapped coordinate.
  dot: {
    width: 7,
    height: 7,
    marginTop: 2,
    borderRadius: 3.5,
    backgroundColor: wc.accent,
    borderWidth: 1.5,
    borderColor: '#FFFFFF',
  },
});
