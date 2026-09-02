import { WEATHER_ENABLED } from '@core/features/flags';
import { sanitizeWeatherLayer } from '@core/geo/weatherLayers';
import { WeatherCompareScreen } from '@features/map/weather/WeatherCompareScreen';
import { Redirect, useLocalSearchParams } from 'expo-router';
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
  // PARKED (see `@core/features/flags`): nothing in the app links here while
  // weather is parked, but the route still exists and a stale deep link (or a
  // notification from an older build) could land on it. Bounce to the map
  // rather than mount a screen that would immediately start fetching ECCC
  // model data for a feature the user cannot see.
  if (!WEATHER_ENABLED) return <Redirect href="/" />;
  return <WeatherCompareScreen at={at} layer={sanitizeWeatherLayer(layer)} />;
}
