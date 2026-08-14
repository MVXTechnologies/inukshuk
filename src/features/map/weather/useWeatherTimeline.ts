import {
  parseTimeDimensionList,
  weatherLayerById,
  type WeatherLayerId,
} from '@core/geo/weatherLayers';
import {
  clampFrameIndex,
  defaultTimeline,
  nearestFrameIndex,
  SCRUB_THROTTLE_MS,
  throttleGate,
  wmsTimeParam,
  type WeatherTimeline,
} from '@core/geo/weatherTimeline';
import { defaultModelTimeline, timelineFromTimeList } from '@core/weather/modelTimeline';
import {
  modelCapabilitiesUrl,
  resolveModelWmsLayer,
  type WeatherModelId,
} from '@core/weather/weatherModels';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * The scrubbable weather timeline (weather UX M1, replaces the bounded-frame
 * useWeatherFrames): while a weather layer is active this owns which valid
 * time the drape shows.
 *
 * - Starts instantly on a clock-guessed timeline so the scrubber renders with
 *   zero network — per-model for forecast layers (`defaultModelTimeline`
 *   knows GDPS's 1 h → 3 h cadence change), the radar guess for past layers —
 *   then refines it from the resolved layer's GetCapabilities TIME dimension
 *   (one small layer-scoped request per activation — GeoMet usage policy).
 *   The list-form parser survives GDPS's comma-list dimension. Every failure
 *   mode — offline, junk XML, degenerate window — silently stays on the
 *   guess, and an unscrubbed radar guess resolves to "no TIME" = the server's
 *   latest frame, exactly the pre-scrubber behaviour.
 * - M2: sessions are keyed by the RESOLVED WMS layer (layer × model), so
 *   switching models rebuilds the timeline in place; the scrubbed position
 *   carries across as the nearest frame of the new model's timeline (mid-
 *   scrub model swaps land where the finger was). Radar layers resolve
 *   identically under every model — no session churn.
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
  /** Resolved WMS layer name (layer × model); stale sessions never leak. */
  key: string;
  /** The catalog layer, so a model swap can carry the scrubbed time over. */
  layerId: WeatherLayerId;
  timeline: WeatherTimeline;
  selectedIdx: number;
}

export interface WeatherTimelineState {
  /** Null only while no layer is active. */
  timeline: WeatherTimeline | null;
  selectedIdx: number;
  /**
   * The trailing-throttled frame index the DRAPE renders. Scrubbing moves
   * `selectedIdx` (and the readout) with the finger; this lags it by at most
   * {@link SCRUB_THROTTLE_MS} so a drag costs a bounded number of fetches.
   */
  drapeIdx: number;
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
  model: WeatherModelId,
  playing: boolean,
  /**
   * "The drape is still staging a frame" (the crossfade's pending slot).
   * A ref, not a prop, because the crossfade is downstream of this hook —
   * the ref breaks the cycle without a render loop. Playback SKIPS a tick
   * while it is true, which paces the animation to the tile-fetch rate
   * instead of queueing frames the map has not drawn yet (perf fix
   * 2026-08-10: the owner saw playback run ahead of what was on screen).
   */
  stagingRef?: { current: boolean },
): WeatherTimelineState {
  // Keyed session instead of resetting state in an effect (the
  // react-hooks/set-state-in-effect rule): a session tagged with another
  // resolved layer's key simply stops being used when the layer or model
  // changes. The session is seeded from the activation effect below — never
  // during render, which must stay pure (react-hooks/purity bans Date.now()
  // there).
  const [session, setSession] = useState<TimelineSession | null>(null);

  const resolvedKey = layer !== null ? resolveModelWmsLayer(layer, model) : null;
  const live = session !== null && session.key === resolvedKey ? session : null;

  // Activation (layer picked or model switched): (1) seed a clock-guessed
  // session on the next tick so the scrubber works with zero network — a
  // model swap carries the previous scrubbed time to the nearest new frame —
  // then (2) refine it from the resolved layer's GetCapabilities TIME window
  // (one small layer-scoped request — GeoMet usage policy). All failures
  // degrade silently to the guess.
  useEffect(() => {
    if (layer === null) return;
    const key = resolveModelWmsLayer(layer, model);
    const kind = weatherLayerById(layer).timeline;
    let cancelled = false;
    const guess = (nowMs: number): WeatherTimeline =>
      kind === 'past' ? defaultTimeline('past', nowMs) : defaultModelTimeline(model, nowMs);
    const seed = setTimeout(() => {
      setSession((prev) => {
        if (prev !== null && prev.key === key) return prev;
        const now = Date.now();
        const timeline = guess(now);
        // Same catalog layer, different model: keep the scrubbed position.
        const prevMs =
          prev !== null && prev.layerId === layer
            ? prev.timeline.framesMs[prev.selectedIdx]
            : undefined;
        const selectedIdx =
          prevMs !== undefined ? nearestFrameIndex(timeline, prevMs) : initialIndex(timeline, now);
        return { key, layerId: layer, timeline, selectedIdx };
      });
    }, 0);
    void (async () => {
      try {
        const res = await fetch(modelCapabilitiesUrl(layer, model), {
          headers: { 'User-Agent': WEATHER_USER_AGENT },
        });
        if (!res.ok || cancelled) return;
        const list = parseTimeDimensionList(await res.text());
        if (list === null || cancelled) return;
        const timeline = timelineFromTimeList(list.timesMs, kind, Date.now());
        if (timeline === null) return;
        setSession((prev) => {
          // Keep an already-scrubbed position (nearest real frame); otherwise
          // open at the kind's natural end (latest observation / now).
          const prevMs =
            prev !== null && prev.key === key
              ? prev.timeline.framesMs[prev.selectedIdx]
              : undefined;
          const selectedIdx =
            prevMs !== undefined
              ? nearestFrameIndex(timeline, prevMs)
              : initialIndex(timeline, Date.now());
          return { key, layerId: layer, timeline, selectedIdx };
        });
      } catch {
        // Unreachable host / offline: stay on the clock-guessed timeline.
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(seed);
    };
  }, [layer, model]);

  const scrubTo = useCallback(
    (idx: number) => {
      if (live === null) return;
      setSession({ ...live, selectedIdx: clampFrameIndex(live.timeline, idx) });
    },
    [live],
  );

  // Playback: advance one frame per tick over the same timeline, wrapping.
  useEffect(() => {
    if (resolvedKey === null || !playing) return;
    const interval = setInterval(() => {
      // Still waiting on the staged frame's tiles: hold this beat rather
      // than stacking another frame the drape cannot show yet.
      if (stagingRef?.current === true) return;
      setSession((prev) => {
        if (prev === null || prev.key !== resolvedKey) return prev;
        return { ...prev, selectedIdx: (prev.selectedIdx + 1) % prev.timeline.framesMs.length };
      });
    }, WEATHER_FRAME_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [resolvedKey, playing, stagingRef]);

  // The FRAME index is what gets throttled, not just its TIME string: the
  // drape now fetches one image per frame and warms the next ones from the
  // same index, so both need the same trailing-throttled value or a fast
  // drag would queue a download per finger position.
  //
  // The throttled value carries its SESSION KEY, and an index tagged with a
  // previous session is discarded rather than waited out. An index means
  // nothing across timelines: switching from radar (36 frames, idx 35 = now)
  // to HRDPS temperature would hold idx 35 against the new timeline for up to
  // SCRUB_THROTTLE_MS and fetch a ~35 h-out forecast — the drape briefly
  // showing tomorrow's weather when the user asked for now.
  const selectedIdx = live?.selectedIdx ?? 0;
  const throttled = useThrottledValue(
    useMemo(() => ({ key: resolvedKey, idx: selectedIdx }), [resolvedKey, selectedIdx]),
    SCRUB_THROTTLE_MS,
  );
  const drapeIdx = throttled.key === resolvedKey ? throttled.idx : selectedIdx;
  const timeParam = live !== null ? wmsTimeParam(live.timeline, drapeIdx) : undefined;

  return {
    timeline: live?.timeline ?? null,
    selectedIdx: live?.selectedIdx ?? 0,
    drapeIdx,
    selectedMs: live !== null ? (live.timeline.framesMs[live.selectedIdx] ?? null) : null,
    scrubTo,
    timeParam: layer === null ? undefined : timeParam,
  };
}
