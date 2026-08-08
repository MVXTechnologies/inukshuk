import type { WeatherLayerId } from '@core/geo/weatherLayers';
import type { LatLng } from '@core/models';
import { formatTimestamp } from '@lib/format';
import { useSettingsStore } from '@state/settingsStore';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { IconButton, Surface, Text } from 'react-native-paper';
import { useForecast } from './useForecast';

/**
 * Forecast tap-card (meteo M1): long-pressing the map with a weather layer
 * active opens the nearest ECCC citypage forecast — current conditions, the
 * gridded value under the finger, and the next forecast periods. A bottom
 * card like WaypointViewerCard (never a Portal dialog — see the #108
 * invisible-overlay soft-lock). Weather is online-only: the error state says
 * so instead of ever showing a stale forecast.
 */
export function ForecastCard({
  at,
  layer,
  onClose,
}: {
  at: LatLng;
  layer: WeatherLayerId | null;
  onClose: () => void;
}) {
  const { status, forecast, layerValue } = useForecast(at, layer);
  const units = useSettingsStore((s) => s.units);
  const temp = (c: number): string =>
    units === 'imperial' ? `${Math.round((c * 9) / 5 + 32)}°F` : `${Math.round(c * 10) / 10}°C`;

  return (
    <Surface style={styles.card} elevation={4}>
      <View style={styles.header}>
        <Text variant="titleMedium" numberOfLines={1} style={styles.title}>
          {forecast !== null
            ? forecast.region !== null
              ? `${forecast.site} — ${forecast.region}`
              : forecast.site
            : 'Forecast'}
        </Text>
        <IconButton icon="close" size={20} onPress={onClose} accessibilityLabel="Close forecast" />
      </View>

      {status === 'loading' && (
        <View style={styles.row}>
          <ActivityIndicator size="small" />
          <Text variant="bodyMedium">Fetching forecast…</Text>
        </View>
      )}

      {status === 'error' && (
        <Text variant="bodyMedium" style={styles.muted}>
          Forecast unavailable — needs a connection.
        </Text>
      )}

      {status === 'ready' && forecast !== null && (
        <>
          {forecast.current !== null && (
            <Text variant="bodyMedium">
              {[
                forecast.current.temperatureC !== null ? temp(forecast.current.temperatureC) : null,
                forecast.current.condition,
                forecast.current.windSummary !== null
                  ? `wind ${forecast.current.windSummary}`
                  : null,
                forecast.current.relativeHumidityPct !== null
                  ? `RH ${forecast.current.relativeHumidityPct}%`
                  : null,
              ]
                .filter((p) => p !== null)
                .join(' · ')}
            </Text>
          )}
          {layerValue !== null && (
            <Text variant="bodySmall" style={styles.muted}>
              Here: {Math.round(layerValue.value * 10) / 10}
              {layerValue.label !== null ? ` — ${layerValue.label}` : ''}
            </Text>
          )}
          {forecast.periods.map((p) => (
            <Text key={p.name} variant="bodySmall" numberOfLines={2}>
              <Text variant="bodySmall" style={styles.periodName}>
                {p.name}:
              </Text>{' '}
              {[p.summary, p.temperatureSummary].filter((s) => s !== null).join(' — ')}
            </Text>
          ))}
          <Text variant="labelSmall" style={styles.footer}>
            {forecast.updatedAtMs !== null
              ? `As of ${formatTimestamp(forecast.updatedAtMs)} · `
              : ''}
            Data: Environment and Climate Change Canada
          </Text>
        </>
      )}
    </Surface>
  );
}

const styles = StyleSheet.create({
  card: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 12,
  },
  header: { flexDirection: 'row', alignItems: 'center' },
  title: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, marginVertical: 4 },
  muted: { opacity: 0.7, marginBottom: 2 },
  periodName: { fontWeight: 'bold' },
  footer: { opacity: 0.6, marginTop: 6 },
});
