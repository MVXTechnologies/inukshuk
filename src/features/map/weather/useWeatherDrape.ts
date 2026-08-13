import { wmsTimeParam, type WeatherTimeline } from '@core/geo/weatherTimeline';
import {
  FRAME_LOOKAHEAD,
  FRAME_PREFETCH_CONCURRENCY,
  prefetchFrameOrder,
  selectResolvedEvictions,
} from '@core/weather/framePrefetch';
import {
  drapeNeedsReanchor,
  weatherDrapeAnchor,
  weatherDrapeUrl,
  type DrapeAnchor,
  type DrapeView,
} from '@core/weather/weatherDrape';
import type { LngLat } from '@core/models';
import { ensureWeatherFrame, peekWeatherFrame, pinWeatherFrames } from '@data/weatherFrames';
import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * The weather drape's frame source (perf work 2026-08-11, owner: "can you
 * find a method to reduce the tile fetch time?").
 *
 * Replaces the `{bbox-epsg-3857}` WMS tile template — 15 GetMap requests per
 * phone-sized frame, measured at 1.5–2.1 s cold — with ONE viewport GetMap
 * per frame, downloaded to disk (`@data/weatherFrames`) and handed to a
 * MapLibre ImageSource as a `file://` URI.
 *
 * Two wins compound:
 * 1. one round trip instead of fifteen (GeoMet is HTTP/1.1, so those fifteen
 *    queue behind a handful of connections);
 * 2. because the app owns the download, the NEXT frames can be warmed while
 *    the current one is on screen. Playback is deterministic, so by the time
 *    the tick fires the file is already local and the swap costs nothing.
 *    A plain `fetch` prefetch could not do this — MapLibre Native's cache is
 *    its own and does not see RN's HTTP cache.
 *
 * Everything degrades silently. A frame that will not download is simply
 * never published, so the crossfade keeps the previous frame on screen, and
 * `frameKey` only ever advances to a frame whose bitmap already exists
 * locally — so a swap can never land on a frame the map cannot draw.
 *
 * ONE UNSTATED COST, so it is stated: an anchor change rewrites EVERY frame
 * URL, because the bbox and pixel size are baked into each one. Panning past
 * the 20% pad (or across a quarter-octave zoom rung) during playback
 * therefore re-downloads the whole lookahead at the new anchor; the frames
 * warmed at the old one stay on disk until the sweep evicts them. That is
 * the price of an anchored image source over a tile grid, and the snapping
 * in `@core/weather/weatherDrape` exists to make it rare rather than to hide
 * it: a nudge, a pinch inside a rung and any pan under an eighth of a box
 * all cost nothing.
 */

export interface WeatherDrapeFrame {
  /** Local `file://` URI MapLibre draws. */
  uri: string;
  /** Corners the image is pinned to (TL, TR, BR, BL). */
  coordinates: [LngLat, LngLat, LngLat, LngLat];
}

export interface WeatherDrapeState {
  /**
   * Identity of the frame to show — its remote GetMap URL. Null until the
   * first frame is on disk. Feeds `useWeatherCrossfade` unchanged.
   */
  frameKey: string | null;
  /** Resolved bitmaps the crossfade slots may reference, keyed by frameKey. */
  frames: ReadonlyMap<string, WeatherDrapeFrame>;
  /** True while the selected frame is still downloading — playback pacing. */
  fetching: boolean;
}

const EMPTY: ReadonlyMap<string, WeatherDrapeFrame> = new Map();

/** Resolved frames kept addressable: the two crossfade slots plus slack. */
const KEEP_RESOLVED = 4;

export function useWeatherDrape(
  /** Resolved WMS layer (layer x model), or null when weather is off. */
  wmsLayer: string | null,
  timeline: WeatherTimeline | null,
  selectedIdx: number,
  /** Settled viewport bounds; null before the map has reported a camera. */
  view: DrapeView | null,
  /** Viewport size in points (MapView onLayout). */
  viewportPt: { width: number; height: number },
  playing: boolean,
  /**
   * The frame keys the crossfade slots are CURRENTLY mounted on. A ref, not a
   * prop, because the crossfade is downstream of this hook — the ref breaks
   * the cycle without a render loop, the same trick the playback pacing uses.
   * Never evicted from `resolved` below: a slot whose frame vanishes from the
   * map renders null, i.e. a visible blank, and `pinWeatherFrames` then
   * unpins the file so the disk sweep may delete it too.
   */
  slotsRef?: { current: readonly (string | null)[] },
): WeatherDrapeState {
  // The anchor is re-taken only when the camera actually leaves the padded
  // box (or zooms deep into it). Holding it in state — rather than deriving
  // it from every settle — is what keeps the frame URLs, and therefore the
  // warmed cache, stable while the user nudges the map.
  const [anchor, setAnchor] = useState<DrapeAnchor | null>(null);
  useEffect(() => {
    // Deferred + functional, per the repo's set-state-in-effect discipline:
    // the decision reads the CURRENT anchor without depending on it, which is
    // also what keeps a re-anchor from re-triggering itself.
    const t = setTimeout(() => {
      setAnchor((prev) => {
        if (wmsLayer === null || view === null) return prev === null ? prev : null;
        if (prev !== null && !drapeNeedsReanchor(prev, view)) return prev;
        // A degenerate viewport keeps the anchor already in use rather than
        // dropping the drape (silent degrade).
        return weatherDrapeAnchor(view, viewportPt) ?? prev;
      });
    }, 0);
    return () => clearTimeout(t);
  }, [wmsLayer, view, viewportPt]);

  const frameUrls = useMemo(() => {
    if (wmsLayer === null || anchor === null || timeline === null) return null;
    return timeline.framesMs.map((_, i) =>
      weatherDrapeUrl(wmsLayer, anchor, wmsTimeParam(timeline, i)),
    );
  }, [wmsLayer, anchor, timeline]);

  const selectedUrl =
    frameUrls === null ? null : (frameUrls[Math.min(selectedIdx, frameUrls.length - 1)] ?? null);

  const [resolved, setResolved] = useState<ReadonlyMap<string, WeatherDrapeFrame>>(EMPTY);
  const [frameKey, setFrameKey] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);

  // Publish the selected frame as soon as its bitmap is local. A cache hit
  // resolves on the next tick with zero network; a miss waits for exactly one
  // request. Either way the PREVIOUS frameKey stays published meanwhile, so
  // the drape never blanks and never steps backwards.
  useEffect(() => {
    if (selectedUrl === null || anchor === null) {
      const t = setTimeout(() => {
        setFrameKey(null);
        setResolved((prev) => (prev.size === 0 ? prev : EMPTY));
        setFetching(false);
      }, 0);
      return () => clearTimeout(t);
    }
    let cancelled = false;
    const coordinates = anchor.coordinates;
    const publish = (uri: string): void => {
      if (cancelled) return;
      setResolved((prev) => {
        const had = prev.get(selectedUrl);
        // Same bitmap at the same corners: keep the map identity so the pin
        // effect below (and the drape's props) do not churn every tick.
        if (had !== undefined && had.uri === uri && had.coordinates === coordinates) return prev;
        const next = new Map(prev);
        next.set(selectedUrl, { uri, coordinates });
        // Bounded: only the slots (and a little slack) need to stay
        // addressable; the bitmaps themselves live in the disk cache. The
        // LIVE SLOTS ARE PROTECTED, not just the selected frame: a slot can
        // outlive four publishes (a 300 ms-throttled scrub against a commit
        // gate that waits up to WEATHER_PRELOAD_MAX_MS), and dropping the
        // frame under it unmounts its ImageSource mid-crossfade.
        const keep = [selectedUrl, ...(slotsRef?.current ?? [])].filter(
          (k): k is string => k !== null && k !== undefined,
        );
        for (const victim of selectResolvedEvictions([...next.keys()], keep, KEEP_RESOLVED)) {
          next.delete(victim);
        }
        return next;
      });
      setFrameKey(selectedUrl);
      setFetching(false);
    };
    const warm = peekWeatherFrame(selectedUrl);
    if (warm !== null) {
      const t = setTimeout(() => publish(warm), 0);
      return () => {
        cancelled = true;
        clearTimeout(t);
      };
    }
    const arm = setTimeout(() => {
      if (!cancelled) setFetching(true);
    }, 0);
    // Deliberately NOT aborted on cleanup: the request is already paid for,
    // and a frame that lands in the cache is a frame the next loop (or a
    // scrub back) gets for free.
    void ensureWeatherFrame(selectedUrl).then((uri) => {
      if (cancelled) return;
      if (uri === null) {
        setFetching(false);
        return;
      }
      publish(uri);
    });
    return () => {
      cancelled = true;
      clearTimeout(arm);
    };
  }, [selectedUrl, anchor, slotsRef]);

  // Warm the next frames while this one is on screen. Bounded lookahead and
  // concurrency (see framePrefetch) — the point is to cover one tick, not to
  // burst a whole loop at a host that asks for ~1 req/s.
  const genRef = useRef(0);
  useEffect(() => {
    if (frameUrls === null || frameUrls.length === 0) return;
    const gen = ++genRef.current;
    // Off playback a single frame ahead is enough (a scrub is user-paced);
    // during playback cover the tick.
    const order = prefetchFrameOrder(selectedIdx, frameUrls.length, playing ? FRAME_LOOKAHEAD : 1);
    const queue = order.map((i) => frameUrls[i]).filter((u): u is string => u !== undefined);
    let i = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const url = queue[i++];
        if (url === undefined || genRef.current !== gen) return;
        if (peekWeatherFrame(url) !== null) continue;
        await ensureWeatherFrame(url);
      }
    };
    for (let w = 0; w < FRAME_PREFETCH_CONCURRENCY; w++) void worker();
    return () => {
      genRef.current += 1;
    };
  }, [frameUrls, selectedIdx, playing]);

  // Never evict what the drape is drawing.
  useEffect(() => {
    pinWeatherFrames([...resolved.keys()]);
  }, [resolved]);

  return { frameKey, frames: resolved, fetching };
}
