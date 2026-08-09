import {
  getFeatureInfoUrl,
  parseFeatureInfo,
  type FeatureInfoValue,
  type WeatherLayerId,
} from '@core/geo/weatherLayers';
import {
  citypageItemsUrl,
  parseCitypageCollection,
  type PointForecast,
} from '@core/weather/forecast';
import type { LatLng } from '@core/models';
import { useEffect, useState } from 'react';
import { WEATHER_USER_AGENT } from './useWeatherTimeline';

/**
 * The forecast tap-card's data: the nearest ECCC citypage forecast around a
 * long-pressed point, plus (when a weather layer is active) the gridded value
 * under the finger via WMS GetFeatureInfo. The gridded value is a garnish —
 * its failure never fails the card; a citypage failure yields 'error' and the
 * card renders its "needs a connection" state (weather is online-only, no
 * stale forecasts).
 */

export interface ForecastQuery {
  status: 'loading' | 'error' | 'ready';
  forecast: PointForecast | null;
  layerValue: FeatureInfoValue | null;
}

const LOADING: ForecastQuery = { status: 'loading', forecast: null, layerValue: null };

/** Identifies one card request; results tagged with a stale key never show. */
function requestKey(at: LatLng, layer: WeatherLayerId | null): string {
  return `${at.latitude},${at.longitude}|${layer ?? ''}`;
}

export function useForecast(at: LatLng | null, layer: WeatherLayerId | null): ForecastQuery {
  // Keyed result instead of resetting to 'loading' inside the effect (the
  // react-hooks/set-state-in-effect rule): while a new request is in flight
  // the stored result's key no longer matches and LOADING is returned.
  const [result, setResult] = useState<{ key: string; query: ForecastQuery } | null>(null);

  useEffect(() => {
    if (at === null) return;
    const key = requestKey(at, layer);
    let cancelled = false;
    const headers = { 'User-Agent': WEATHER_USER_AGENT };
    const valuePromise: Promise<FeatureInfoValue | null> =
      layer === null
        ? Promise.resolve(null)
        : fetch(getFeatureInfoUrl(layer, at), { headers })
            .then(async (r) => (r.ok ? parseFeatureInfo(await r.json()) : null))
            .catch(() => null);
    void (async () => {
      try {
        const res = await fetch(citypageItemsUrl(at), { headers });
        const forecast = res.ok ? parseCitypageCollection(await res.json(), at) : null;
        const layerValue = await valuePromise;
        if (cancelled) return;
        setResult({
          key,
          query:
            forecast !== null
              ? { status: 'ready', forecast, layerValue }
              : { status: 'error', forecast: null, layerValue: null },
        });
      } catch {
        if (!cancelled) {
          setResult({ key, query: { status: 'error', forecast: null, layerValue: null } });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [at, layer]);

  if (at === null) return LOADING;
  return result !== null && result.key === requestKey(at, layer) ? result.query : LOADING;
}
