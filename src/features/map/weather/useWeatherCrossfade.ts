import {
  crossfadeCommit,
  crossfadeInit,
  crossfadeTarget,
  WEATHER_PRELOAD_MAX_MS,
  WEATHER_PRELOAD_MS,
  WEATHER_PRELOAD_POLL_MS,
  type WeatherCrossfadeState,
} from '@core/weather/weatherCrossfade';
import { useEffect, useRef, useState } from 'react';

/**
 * Drives the weather drape's two-slot crossfade (wave A item 3, the
 * frame-swap flicker fix): feed it the CURRENT frame's tile-URL template
 * (already throttled by useWeatherTimeline) and it returns the slot state
 * `WeatherDrapeLayers` renders — the incoming frame staged at opacity 0 in
 * the inactive slot (MapLibre prefetches its tiles while invisible), then
 * the active slot flipped once that frame is actually drawn. The pure slot
 * machine lives in `@core/weather/weatherCrossfade`; this hook only owns the
 * timers (the setTimeout(0) staging keeps setState out of the effect body —
 * the repo's set-state-in-effect discipline).
 *
 * The commit is GATED ON A FULLY-RENDERED FRAME (perf fix 2026-08-10):
 * `renderedRef` counts MapLibre's `onDidFinishRenderingFrameFully`, which
 * fires only once every tile the style currently needs — including the
 * invisible staged slot's — is loaded and drawn. Waiting for one of those
 * after staging is a much better gate than the fixed
 * {@link WEATHER_PRELOAD_MS} window, which on its own could flip onto a
 * half-loaded slot. {@link WEATHER_PRELOAD_MAX_MS} caps the wait so a frame
 * whose tiles never arrive (dead host, empty region) can never wedge
 * playback.
 *
 * HONEST LIMIT: the gate is not frame-SPECIFIC. The event carries no identity
 * — any fully-rendered map frame increments the counter — and the snapshot is
 * taken in JS at staging time, a moment before maplibre-react-native has
 * actually inserted the new layer natively. So a render that completes in
 * that gap (a camera nudge, the basemap settling) can satisfy the gate before
 * the staged frame's own pixels exist. It is deliberately NOT tightened by
 * snapshotting later: an already-warm frame may paint once and then leave the
 * map completely idle, and a gate that demanded a LATER event would stall
 * that frame for the full {@link WEATHER_PRELOAD_MAX_MS}.
 *
 * So this gate makes a washed-out swap RARE, not impossible; closing the gap
 * for good has to happen upstream, by staging only frames whose bitmap is
 * already local.
 */
export function useWeatherCrossfade(
  url: string | null,
  renderedRef?: { current: number },
): WeatherCrossfadeState {
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

  // Commit the pending slot once its tiles have rendered (or the cap
  // elapses). Keyed on the pending URL: a newer frame restaging the slot
  // restarts the window.
  const pendingUrl = state.pendingSlot !== null ? state.slots[state.pendingSlot] : null;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (pendingUrl === null) return;
    const stagedAtFrame = renderedRef?.current ?? 0;
    const startedAt = Date.now();
    const poll = (): void => {
      const elapsed = Date.now() - startedAt;
      const drawn = renderedRef === undefined || renderedRef.current > stagedAtFrame;
      if ((drawn && elapsed >= WEATHER_PRELOAD_MS) || elapsed >= WEATHER_PRELOAD_MAX_MS) {
        setState(crossfadeCommit);
        return;
      }
      timerRef.current = setTimeout(poll, WEATHER_PRELOAD_POLL_MS);
    };
    timerRef.current = setTimeout(poll, WEATHER_PRELOAD_MS);
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, [pendingUrl, renderedRef]);

  return state;
}
