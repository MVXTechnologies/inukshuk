import {
  parseTimeDimension,
  weatherCapabilitiesUrl,
  weatherLayerById,
  type WeatherLayerId,
} from '@core/geo/weatherLayers';
import {
  clampFrameIndex,
  defaultTimeline,
  nearestFrameIndex,
  SCRUB_THROTTLE_MS,
  throttleGate,
  timelineFromDimension,
  wmsTimeParam,
  type WeatherTimeline,
} from '@core/geo/weatherTimeline';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The scrubbable weather timeline (weather UX M1, replaces the bounded-frame
 * useWeatherFrames): while a weather layer is active this owns which valid
 * time the drape shows.
 *
 * - Starts instantly on a clock-guessed timeline (`defaultTimeline`) so the
 *   scrubber renders with zero network, then refines it from the layer's
 *   GetCapabilities TIME dimension (one small layer-scoped request per
 *   activation — GeoMet usage policy). Every failure mode — offline, junk
 *   XML, degenerate window — silently stays on the guess, and an unscrubbed
 *   radar guess resolves to "no TIME" = the server's latest frame, exactly
 *   the pre-scrubber behaviour.
 * - Scrubbing updates the selection (and the readout) live, but the WMS TIME
 *   fed to the drape is trailing-throttled ({@link SCRUB_THROTTLE_MS}) — each
 *   emit re-fetches the visible tile set, so the drag must not emit per-move.
 * - `playing` (the mapStore animate flag, now "play" for every layer) steps
 *   the selection across the same timeline and wraps.
 */

/** GeoMet usage policy asks for a meaningful User-Agent. */
export const WEATHER_USER_AGENT = 'Inukshuk trail app (github.com/MVXTechnologies/inukshuk)';

/** Playback cadence — one frame per tick, wrapping at the end. */
export const WEATHER_FRAME_INTERVAL_MS = 700;

interface TimelineSession {
  /** The layer this session belongs to; stale sessions never leak across layers. */
  key: WeatherLayerId;
  timeline: WeatherTimeline;
  selectedIdx: number;
}

export interface WeatherTimelineState {
  /** Null only while no layer is active. */
  timeline: WeatherTimeline | null;
  selectedIdx: number;
  /** Epoch ms of the selected frame (drives the readout), or null when off. */
  selectedMs: number | null;
  /** Scrub to a frame index (clamped). Instant — the readout follows the finger. */
  scrubTo: (idx: number) => void;
  /** Throttled WMS TIME for the drape; undefined = server-default latest frame. */
  timeParam: string | undefined;
}

function initialIndex(timeline: WeatherTimeline, nowMs: number): number {
  // Radar opens on the latest observation; forecast opens on "now".
  return timeline.kind === 'past'
    ? timeline.framesMs.length - 1
    : nearestFrameIndex(timeline, nowMs);
}

/**
 * Emit `value` at most once per `intervalMs`, trailing-edge included: while
 * values keep changing the timer keeps the REMAINING wait (throttle, not
 * debounce), so a continuous scrub emits steadily and the final position
 * always lands. The pure gate math lives in `@core/geo/weatherTimeline`.
 */
function useThrottledValue<T>(value: T, intervalMs: number): T {
  const [emitted, setEmitted] = useState(value);
  const lastEmitRef = useRef<number | null>(null);
  useEffect(() => {
    const gate = throttleGate(lastEmitRef.current, Date.now(), intervalMs);
    const timer = setTimeout(() => {
      lastEmitRef.current = Date.now();
      setEmitted(value);
    }, gate.waitMs);
    return () => clearTimeout(timer);
  }, [value, intervalMs]);
  return emitted;
}

export function useWeatherTimeline(
  layer: WeatherLayerId | null,
  playing: boolean,
): WeatherTimelineState {
  // Keyed session instead of resetting state in an effect (the
  // react-hooks/set-state-in-effect rule): a session tagged with another
  // layer's key simply stops being used when the layer changes. The session
  // is seeded from the activation effect below — never during render, which
  // must stay pure (react-hooks/purity bans Date.now() there).
  const [session, setSession] = useState<TimelineSession | null>(null);

  const live = session !== null && session.key === layer ? session : null;

  // Layer activation: (1) seed a clock-guessed session on the next tick so
  // the scrubber works with zero network, then (2) refine it from the
  // layer's GetCapabilities TIME window (one small layer-scoped request —
  // GeoMet usage policy). All failures degrade silently to the guess.
  useEffect(() => {
    if (layer === null) return;
    const kind = weatherLayerById(layer).timeline;
    let cancelled = false;
    const seed = setTimeout(() => {
      setSession((prev) => {
        if (prev !== null && prev.key === layer) return prev;
        const now = Date.now();
        const timeline = defaultTimeline(kind, now);
        return { key: layer, timeline, selectedIdx: initialIndex(timeline, now) };
      });
    }, 0);
    void (async () => {
      try {
        const res = await fetch(weatherCapabilitiesUrl(layer), {
          headers: { 'User-Agent': WEATHER_USER_AGENT },
        });
        if (!res.ok || cancelled) return;
        const dim = parseTimeDimension(await res.text());
        if (dim === null || cancelled) return;
        const timeline = timelineFromDimension(dim, kind, Date.now());
        if (timeline === null) return;
        setSession((prev) => {
          // Keep an already-scrubbed position (nearest real frame); otherwise
          // open at the kind's natural end (latest observation / now).
          const prevMs =
            prev !== null && prev.key === layer
              ? prev.timeline.framesMs[prev.selectedIdx]
              : undefined;
          const selectedIdx =
            prevMs !== undefined
              ? nearestFrameIndex(timeline, prevMs)
              : initialIndex(timeline, Date.now());
          return { key: layer, timeline, selectedIdx };
        });
      } catch {
        // Unreachable host / offline: stay on the clock-guessed timeline.
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(seed);
    };
  }, [layer]);

  const scrubTo = useCallback(
    (idx: number) => {
      if (live === null) return;
      setSession({ ...live, selectedIdx: clampFrameIndex(live.timeline, idx) });
    },
    [live],
  );

  // Playback: advance one frame per tick over the same timeline, wrapping.
  useEffect(() => {
    if (layer === null || !playing) return;
    const interval = setInterval(() => {
      setSession((prev) => {
        if (prev === null || prev.key !== layer) return prev;
        return { ...prev, selectedIdx: (prev.selectedIdx + 1) % prev.timeline.framesMs.length };
      });
    }, WEATHER_FRAME_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [layer, playing]);

  const rawParam = live !== null ? wmsTimeParam(live.timeline, live.selectedIdx) : undefined;
  const timeParam = useThrottledValue(rawParam, SCRUB_THROTTLE_MS);

  return {
    timeline: live?.timeline ?? null,
    selectedIdx: live?.selectedIdx ?? 0,
    selectedMs: live !== null ? (live.timeline.framesMs[live.selectedIdx] ?? null) : null,
    scrubTo,
    timeParam: layer === null ? undefined : timeParam,
  };
}
