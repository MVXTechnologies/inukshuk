import {
  getFeatureInfoUrlForLayer,
  parseFeatureInfo,
  type FeatureInfoValue,
  type WeatherLayerId,
} from '@core/geo/weatherLayers';
import { resolveModelWmsLayer, type WeatherModelId } from '@core/weather/weatherModels';
import type { LatLng } from '@core/models';
import { useEffect, useState } from 'react';
import { WEATHER_USER_AGENT } from './useWeatherTimeline';

/**
 * The tap-anywhere point-value chip's data (wave A item 7): one WMS
 * GetFeatureInfo request for the active layer's gridded value under the
 * tapped point, resolved against the active MODEL and pinned to the
 * scrubbed TIME (the M2 machinery the comparison table already uses). Same
 * keyed-result idiom as useForecast: while a new request is in flight the
 * stored key no longer matches and 'loading' is returned; out-of-range
 * times come back as XML ServiceException, which `res.json()` throws on —
 * caught into the silent 'error' state (the chip shows "No data").
 */

export interface WeatherPointQuery {
  status: 'loading' | 'error' | 'ready';
  value: FeatureInfoValue | null;
}

const LOADING: WeatherPointQuery = { status: 'loading', value: null };

function requestKey(
  at: LatLng,
  layer: WeatherLayerId,
  model: WeatherModelId,
  timeIso: string | undefined,
): string {
  return `${at.latitude},${at.longitude}|${layer}|${model}|${timeIso ?? ''}`;
}

export function useWeatherPointValue(
  at: LatLng,
  layer: WeatherLayerId,
  model: WeatherModelId,
  timeIso: string | undefined,
): WeatherPointQuery {
  const [result, setResult] = useState<{ key: string; query: WeatherPointQuery } | null>(null);

  useEffect(() => {
    const key = requestKey(at, layer, model, timeIso);
    let cancelled = false;
    void (async () => {
      try {
        const url = getFeatureInfoUrlForLayer(resolveModelWmsLayer(layer, model), at, timeIso);
        const res = await fetch(url, { headers: { 'User-Agent': WEATHER_USER_AGENT } });
        const value = res.ok ? parseFeatureInfo(await res.json()) : null;
        if (cancelled) return;
        setResult({
          key,
          query: value !== null ? { status: 'ready', value } : { status: 'error', value: null },
        });
      } catch {
        if (!cancelled) setResult({ key, query: { status: 'error', value: null } });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [at, layer, model, timeIso]);

  return result !== null && result.key === requestKey(at, layer, model, timeIso)
    ? result.query
    : LOADING;
}
