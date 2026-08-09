import { sanitizeWeatherLayer } from '@core/geo/weatherLayers';
import { WeatherCompareScreen } from '@features/map/weather/WeatherCompareScreen';
import { useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';

/** Québec City — the harmless last-resort point for junk deep-link params. */
const FALLBACK = { latitude: 46.813, longitude: -71.208 };

export default function WeatherCompareRoute() {
  const { lat, lng, layer } = useLocalSearchParams<{ lat: string; lng: string; layer: string }>();
  // Stable point identity: the screen keys its fetch effect on this object,
  // so it must not be re-created per render.
  const at = useMemo(() => {
    const latitude = Number(lat);
    const longitude = Number(lng);
    return Number.isFinite(latitude) && Number.isFinite(longitude)
      ? { latitude, longitude }
      : FALLBACK;
  }, [lat, lng]);
  return <WeatherCompareScreen at={at} layer={sanitizeWeatherLayer(layer)} />;
}
