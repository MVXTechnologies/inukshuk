import {
  animationFrames,
  parseTimeDimension,
  weatherCapabilitiesUrl,
  weatherLayerById,
  type WeatherLayerId,
} from '@core/geo/weatherLayers';
import { useEffect, useState } from 'react';

/**
 * Bounded radar animation (meteo M1): when the active weather layer is
 * animatable and the user turned animation on, fetch the layer's time
 * dimension once (layer-scoped GetCapabilities — one small request per
 * toggle-on, honouring GeoMet's ~1 req/s policy) and cycle the last
 * {@link WEATHER_FRAME_COUNT} frames. Returns the current frame's TIME
 * string, or null for "static latest frame" — which is also the graceful
 * degradation for every failure mode (offline, junk XML, empty window).
 */

/** 10 radar frames × 6-min steps = the last hour of weather. */
export const WEATHER_FRAME_COUNT = 10;
export const WEATHER_FRAME_INTERVAL_MS = 700;

/** GeoMet usage policy asks for a meaningful User-Agent. */
export const WEATHER_USER_AGENT = 'Inukshuk trail app (github.com/MVXTechnologies/inukshuk)';

/** Identifies one animation session; stale frames from an old session never leak. */
function sessionKey(layer: WeatherLayerId, animate: boolean): string {
  return `${layer}|${animate ? 'on' : 'off'}`;
}

export function useWeatherFrames(layer: WeatherLayerId | null, animate: boolean): string | null {
  // Keyed result instead of resetting state inside the effect (the
  // react-hooks/set-state-in-effect rule): a frame tagged with a stale
  // session key simply stops being returned when the inputs change.
  const [frame, setFrame] = useState<{ key: string; time: string } | null>(null);

  const active = layer !== null && animate && weatherLayerById(layer).animatable;

  useEffect(() => {
    if (layer === null || !animate || !weatherLayerById(layer).animatable) return;
    const key = sessionKey(layer, animate);
    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;
    void (async () => {
      try {
        const res = await fetch(weatherCapabilitiesUrl(layer), {
          headers: { 'User-Agent': WEATHER_USER_AGENT },
        });
        if (!res.ok || cancelled) return;
        const dim = parseTimeDimension(await res.text());
        if (dim === null || cancelled) return;
        const frames = animationFrames(dim, WEATHER_FRAME_COUNT);
        if (frames.length === 0) return;
        let i = 0;
        const first = frames[0];
        if (first !== undefined) setFrame({ key, time: first });
        interval = setInterval(() => {
          i = (i + 1) % frames.length;
          const t = frames[i];
          if (t !== undefined) setFrame({ key, time: t });
        }, WEATHER_FRAME_INTERVAL_MS);
      } catch {
        // Unreachable host / offline: stay on the static latest frame.
      }
    })();
    return () => {
      cancelled = true;
      if (interval !== null) clearInterval(interval);
    };
  }, [layer, animate]);

  return active && frame !== null && frame.key === sessionKey(layer, animate) ? frame.time : null;
}
