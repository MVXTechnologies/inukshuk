import {
  crossfadeCommit,
  crossfadeInit,
  crossfadeTarget,
  WEATHER_PRELOAD_MS,
  type WeatherCrossfadeState,
} from '@core/weather/weatherCrossfade';
import { useEffect, useState } from 'react';

/**
 * Drives the weather drape's two-slot crossfade (wave A item 3, the
 * frame-swap flicker fix): feed it the CURRENT frame's tile-URL template
 * (already throttled by useWeatherTimeline) and it returns the slot state
 * the style builder renders — the incoming frame staged at opacity 0 in the
 * inactive slot (MapLibre prefetches its tiles while invisible), then the
 * active slot flipped after {@link WEATHER_PRELOAD_MS}. The pure slot
 * machine lives in `@core/weather/weatherCrossfade`; this hook only owns the
 * two timers (the setTimeout(0) staging keeps setState out of the effect
 * body — the repo's set-state-in-effect discipline).
 */
export function useWeatherCrossfade(url: string | null): WeatherCrossfadeState {
  const [state, setState] = useState<WeatherCrossfadeState>(() => crossfadeInit(url));

  // Stage every URL change; weather turning off resets the slots outright.
  useEffect(() => {
    const t = setTimeout(() => {
      setState((s) =>
        url === null
          ? s.slots[0] === null && s.slots[1] === null
            ? s
            : crossfadeInit(null)
          : crossfadeTarget(s, url),
      );
    }, 0);
    return () => clearTimeout(t);
  }, [url]);

  // Commit the pending slot once its preload window elapses. Keyed on the
  // pending URL: a newer frame restaging the slot restarts the window.
  const pendingUrl = state.pendingSlot !== null ? state.slots[state.pendingSlot] : null;
  useEffect(() => {
    if (pendingUrl === null) return;
    const t = setTimeout(() => setState(crossfadeCommit), WEATHER_PRELOAD_MS);
    return () => clearTimeout(t);
  }, [pendingUrl]);

  return state;
}
