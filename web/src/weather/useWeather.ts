import type { ImageSource, Map as MlMap } from 'maplibre-gl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  parseReferenceTimeDefault,
  parseTimeDimension,
  weatherCapabilitiesUrl,
  weatherLayerById,
  type WeatherLayerId,
} from '@core/geo/weatherLayers';
import {
  clampFrameIndex,
  defaultTimeline,
  FORECAST_STEP_MS,
  nearestFrameIndex,
  RADAR_STEP_MS,
  SCRUB_THROTTLE_MS,
  throttleGate,
  timelineFromDimension,
  wmsTimeParam,
  type WeatherTimeline,
} from '@core/geo/weatherTimeline';
import {
  crossfadeCommit,
  crossfadeInit,
  crossfadeTarget,
  WEATHER_PRELOAD_MAX_MS,
  WEATHER_PRELOAD_MS,
  type WeatherCrossfadeState,
} from '@core/weather/weatherCrossfade';
import {
  drapeNeedsReanchor,
  weatherDrapeAnchor,
  weatherDrapeUrl,
  type DrapeAnchor,
} from '@core/weather/weatherDrape';
import { WEATHER_DRAPE_OPACITY } from '@core/weather/weatherLook';
import { WIND_DRAPE_OPACITY } from '@core/weather/windLook';

import { useNow } from '@/lib/useNow';
import { DRAPE_SLOT_IDS } from '@/map/mapStyle';
import type { MapView } from '@/map/MapCanvas';

/**
 * `raster-opacity` for one weather layer's colour drape.
 *
 * The same rule the app applies: wind gets its own (much lower) constant
 * because it is the only layer that also draws its own particle ink on top;
 * everything else gets the shared default. Both numbers come from `@core`, so
 * the playground cannot drift from the device-reviewed values — the full
 * reasoning is in `weatherLook.ts` and `windLook.ts`.
 */
export function drapeOpacityFor(id: WeatherLayerId): number {
  return id === 'wind' ? WIND_DRAPE_OPACITY : WEATHER_DRAPE_OPACITY;
}

/** How long one frame is held during playback. Matches the app's 700 ms tick. */
const PLAYBACK_TICK_MS = 700;

/** The timeline a live GetCapabilities gave us, tagged with whose it is. */
interface LiveTimeline {
  layerId: WeatherLayerId;
  timeline: WeatherTimeline;
  referenceTimeMs: number | null;
}

/**
 * What the user is looking at, stored as a MOMENT rather than a frame index.
 *
 * This is the detail worth getting right. A timeline gets REPLACED under the
 * user twice over: once when GetCapabilities upgrades the clock guess to the
 * real dimension, and again whenever the clock steps onto a new frame grid.
 * An index means something different in each of those lists, so carrying one
 * across silently teleports the view; an epoch-ms moment survives all of them,
 * and `nearestFrameIndex` maps it back into whatever list is current.
 */
interface FramePick {
  layerId: WeatherLayerId;
  atMs: number;
}

export interface WeatherState {
  timeline: WeatherTimeline;
  frameIndex: number;
  setFrameIndex: (idx: number) => void;
  playing: boolean;
  togglePlay: () => void;
  /** Epoch ms of the model run behind the current layer, when GeoMet says. */
  referenceTimeMs: number | null;
  /** True while the first drape image of a change is still on the wire. */
  loading: boolean;
}

/**
 * Everything the weather overlay needs, wired straight onto `@core`:
 *
 *  - the TIMELINE comes from `@core/geo/weatherTimeline` — the clock guess
 *    first (so the scrubber is usable before any network), then upgraded in
 *    place when GetCapabilities lands;
 *  - the DRAPE is one GetMap per frame, anchored and snapped by
 *    `@core/weather/weatherDrape` — the same single-image approach the app
 *    moved to when tile-grid fetches measured 15 requests and ~2 s per frame;
 *  - frame changes go through `@core/weather/weatherCrossfade`, so scrubbing
 *    never blanks the map.
 *
 * None of that logic is reimplemented here. This hook is the browser's half:
 * fetch, timers, and MapLibre GL JS source plumbing.
 */
export function useWeather(
  map: MlMap | null,
  styleEpoch: number,
  layerId: WeatherLayerId | null,
  view: MapView | null,
): WeatherState {
  const kind = layerId === null ? 'forecast' : weatherLayerById(layerId).timeline;

  // Stepped at the layer's own cadence: stable between frames, but it does
  // advance, so a long-lived tab keeps offering the newest radar frame.
  const nowMs = useNow(kind === 'past' ? RADAR_STEP_MS : FORECAST_STEP_MS);

  const [live, setLive] = useState<LiveTimeline | null>(null);
  const [pick, setPick] = useState<FramePick | null>(null);
  const [playing, setPlaying] = useState(false);
  const [anchor, setAnchor] = useState<DrapeAnchor | null>(null);
  const [fade, setFade] = useState<WeatherCrossfadeState>(() => crossfadeInit(null));
  const [loading, setLoading] = useState(false);

  // ------------------------------------------------------------ timeline --
  // Derived, not stored: the live dimension when we have one for THIS layer,
  // otherwise the zero-network clock guess. Switching layers therefore cannot
  // leave a radar timeline attached to a forecast layer — there is no stale
  // state to forget to reset.
  const timeline = useMemo<WeatherTimeline>(() => {
    if (live !== null && live.layerId === layerId) return live.timeline;
    return defaultTimeline(kind, nowMs);
  }, [live, layerId, kind, nowMs]);

  const referenceTimeMs = live !== null && live.layerId === layerId ? live.referenceTimeMs : null;

  // Radar scrubs backwards from the newest observation; a forecast starts at
  // "now" and runs forwards. Same rule the app's scrubber opens on.
  const defaultIndex = timeline.kind === 'past' ? timeline.framesMs.length - 1 : 0;
  const frameIndex =
    pick !== null && pick.layerId === layerId
      ? nearestFrameIndex(timeline, pick.atMs)
      : defaultIndex;

  useEffect(() => {
    if (layerId === null) return;
    const controller = new AbortController();
    const layerKind = weatherLayerById(layerId).timeline;
    void (async () => {
      try {
        const res = await fetch(weatherCapabilitiesUrl(layerId), { signal: controller.signal });
        if (!res.ok) return;
        const xml = await res.text();
        const dim = parseTimeDimension(xml);
        if (dim === null) return;
        const upgraded = timelineFromDimension(dim, layerKind, Date.now());
        if (upgraded === null) return;
        setLive({
          layerId,
          timeline: upgraded,
          referenceTimeMs: parseReferenceTimeDefault(xml),
        });
      } catch {
        // Offline / blocked / malformed: the clock guess stays, which is the
        // whole reason it exists. Silent degrade, same rule as the app.
      }
    })();
    return () => controller.abort();
  }, [layerId]);

  // ------------------------------------------------------------- anchor ---
  // Re-anchor only when the viewport escapes the padded box (or shrinks far
  // inside it) — `drapeNeedsReanchor` owns that rule, so a pan inside the pad
  // costs zero requests and leaves every warmed frame URL untouched.
  useEffect(() => {
    if (view === null || layerId === null) return;
    // Deliberately stateful rather than a `useMemo` over the viewport: the
    // whole value of `drapeNeedsReanchor` is HYSTERESIS — the answer depends on
    // the anchor already in use, not only on the current camera. The updater
    // returns `prev` unchanged in the common case, so this settles in one pass
    // and does not cascade.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAnchor((prev) => {
      if (prev !== null && !drapeNeedsReanchor(prev, view)) return prev;
      return weatherDrapeAnchor(view, { width: view.widthPt, height: view.heightPt }) ?? prev;
    });
  }, [view, layerId]);

  // Switching the layer off is DERIVED, not a stored reset: there is then no
  // window in which a stale anchor (or a running playback) can still be read,
  // and nothing to forget to clear on the way back in.
  const activeAnchor = layerId === null ? null : anchor;
  const isPlaying = layerId === null ? false : playing;

  // -------------------------------------------------------- frame -> URL ---
  const targetUrl = useMemo(() => {
    if (layerId === null || activeAnchor === null) return null;
    return weatherDrapeUrl(
      weatherLayerById(layerId).wmsLayer,
      activeAnchor,
      wmsTimeParam(timeline, frameIndex),
    );
  }, [layerId, activeAnchor, timeline, frameIndex]);

  // Scrub throttle: each frame change is a GetMap render on GeoMet's side, and
  // their usage policy is ~1 req/s. `throttleGate` is the app's own gate.
  const lastEmit = useRef<number | null>(null);
  // The crossfade is a state MACHINE advanced over time by an external signal
  // (which frame's image has arrived), not a value derivable from the current
  // props — `crossfadeTarget`/`crossfadeCommit` in `@core` are the transitions.
  // Both writes below are one-shot transitions, not cascades.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (targetUrl === null) {
      setFade(crossfadeInit(null));
      return;
    }
    const stage = () => {
      lastEmit.current = Date.now();
      setFade((prev) => crossfadeTarget(prev, targetUrl));
    };
    const { emit, waitMs } = throttleGate(lastEmit.current, Date.now(), SCRUB_THROTTLE_MS);
    if (emit) {
      stage();
      return;
    }
    const trailing = window.setTimeout(stage, waitMs);
    return () => window.clearTimeout(trailing);
  }, [targetUrl]);

  // ------------------------------------------------------- commit the fade --
  // Hold the outgoing frame until the incoming one has actually arrived, then
  // flip.
  //
  // The app polls MapLibre for a fully-rendered frame; that signal is not
  // available here, and `isSourceLoaded` is worse than useless for an
  // ImageSource — it stays true across `updateImage`, so it would report the
  // OUTGOING image as "ready". The browser gives a better one: decode the URL
  // into an `Image` first. It doubles as the prefetch, because MapLibre's own
  // request for the identical URL then lands in the HTTP cache.
  //
  // The cap still applies: a frame whose image never loads (dead host, a region
  // with no data) swaps anyway rather than freezing playback.
  const pendingUrl = fade.pendingSlot === null ? null : (fade.slots[fade.pendingSlot] ?? null);
  useEffect(() => {
    if (pendingUrl === null) return;
    setLoading(true);
    const startedAt = Date.now();
    let settled = false;
    let hold: number | undefined;

    const commit = () => {
      if (settled) return;
      settled = true;
      const rest = Math.max(0, WEATHER_PRELOAD_MS - (Date.now() - startedAt));
      hold = window.setTimeout(() => {
        setLoading(false);
        setFade(crossfadeCommit);
      }, rest);
    };

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = commit;
    img.onerror = commit;
    img.src = pendingUrl;
    const cap = window.setTimeout(commit, WEATHER_PRELOAD_MAX_MS);

    return () => {
      settled = true;
      img.onload = null;
      img.onerror = null;
      window.clearTimeout(cap);
      if (hold !== undefined) window.clearTimeout(hold);
      setLoading(false);
    };
  }, [pendingUrl]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // ---------------------------------------------------- MapLibre plumbing --
  // Each slot remembers the URL it was staged with (per style epoch, since a
  // style swap throws every source away), so an unchanged slot is never asked
  // to refetch an image it already holds.
  const staged = useRef<Record<string, string>>({});
  useEffect(() => {
    if (map === null || styleEpoch === 0) return;
    const opacity = layerId === null ? 0 : drapeOpacityFor(layerId);

    for (const slot of [0, 1] as const) {
      const id = DRAPE_SLOT_IDS[slot];
      const url = fade.slots[slot];
      const hasLayer = map.getLayer(id) !== undefined;
      if (url === null || url === undefined || activeAnchor === null) {
        if (hasLayer) map.setPaintProperty(id, 'raster-opacity', 0);
        continue;
      }
      const source = map.getSource(id) as ImageSource | undefined;
      const key = `${styleEpoch}|${url}`;
      if (source === undefined) {
        map.addSource(id, { type: 'image', url, coordinates: activeAnchor.coordinates });
        staged.current[id] = key;
      } else if (staged.current[id] !== key) {
        source.updateImage({ url, coordinates: activeAnchor.coordinates });
        staged.current[id] = key;
      }
      if (hasLayer) {
        map.setPaintProperty(id, 'raster-opacity', slot === fade.activeSlot ? opacity : 0);
      }
    }
  }, [map, styleEpoch, fade, activeAnchor, layerId]);

  // ----------------------------------------------------------- playback ---
  const selectIndex = useCallback(
    (idx: number) => {
      if (layerId === null) return;
      const atMs = timeline.framesMs[clampFrameIndex(timeline, idx)];
      if (atMs !== undefined) setPick({ layerId, atMs });
    },
    [layerId, timeline],
  );

  // The tick reads the current frame out of the updater argument rather than a
  // ref, so the interval is armed once per timeline instead of re-armed on
  // every frame — and there is no ref to fall out of sync.
  useEffect(() => {
    if (!isPlaying || layerId === null) return;
    const tick = window.setInterval(() => {
      setPick((prev) => {
        const frames = timeline.framesMs;
        if (frames.length === 0) return prev;
        const current =
          prev !== null && prev.layerId === layerId
            ? nearestFrameIndex(timeline, prev.atMs)
            : timeline.kind === 'past'
              ? frames.length - 1
              : 0;
        const next = frames[(current + 1) % frames.length];
        return next === undefined ? prev : { layerId, atMs: next };
      });
    }, PLAYBACK_TICK_MS);
    return () => window.clearInterval(tick);
  }, [isPlaying, layerId, timeline]);

  const togglePlay = useCallback(() => setPlaying((p) => !p), []);

  return {
    timeline,
    frameIndex: clampFrameIndex(timeline, frameIndex),
    setFrameIndex: selectIndex,
    playing: isPlaying,
    togglePlay,
    referenceTimeMs,
    loading,
  };
}
