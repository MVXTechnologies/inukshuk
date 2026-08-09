import { encodeWindTexture } from '@core/weather/windField';
import { needsReanchor, windFetchBbox, type WindBbox } from '@core/weather/windCoverage';
import type { WeatherModelId } from '@core/weather/weatherModels';
import type { WindViewState } from '@core/weather/windProjection';
import { useEffect, useMemo, useState } from 'react';
import { AppState } from 'react-native';
import { useWindField } from './useWindField';
import { WindParticleOverlay } from './WindParticleOverlay';

export interface WindParticleLayerProps {
  /** The active forecast model — wind coverages resolve per model. */
  model: WeatherModelId;
  /** Scrubbed WMS/WCS TIME (throttled upstream); undefined = server latest. */
  timeIso: string | undefined;
  /** Latest camera state at gesture rate (the overlay reads it per frame). */
  viewRef: React.RefObject<WindViewState | null>;
  /** True while the user is gesturing (particles fade + pause). */
  interacting: boolean;
  /** The settled viewport bounds — drives fetch-bbox anchoring. */
  settledBounds: WindBbox | null;
}

/**
 * The wind particle layer's data/lifecycle shell (weather M3): anchors a
 * fetch bbox ~1.5× the settled viewport, pulls the WCS wind field for
 * (model, bbox, TIME), encodes it for the GL renderer, and mounts the
 * transparent overlay. MapScreen gates WHETHER this renders (wind layer on,
 * 2D, online, the windParticles kill-switch, screen focused, map loaded);
 * this component additionally parks itself while the app is backgrounded —
 * unmounting the GLView stops the render loop entirely (battery honesty).
 *
 * The GLView mounts as soon as the layer is active — before any field
 * arrives — so the GL surface lifecycle is exercised even fully offline
 * (that mount/unmount is the crash surface the e2e flow gates). With no
 * field the loop idles; failures upstream stay silent and the drape alone
 * remains, which is exactly the shipped static wind UX.
 */
export function WindParticleLayer({
  model,
  timeIso,
  viewRef,
  interacting,
  settledBounds,
}: WindParticleLayerProps) {
  // Background/foreground: unmount the GLView while inactive.
  const [appActive, setAppActive] = useState(true);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setAppActive(s === 'active'));
    return () => sub.remove();
  }, []);

  // Fetch-bbox anchor: follows the settled viewport, but only moves when the
  // view escapes the padded bbox (or zooms in deep enough to earn a finer
  // grid) — pans inside the padding cost zero requests.
  const [anchor, setAnchor] = useState<WindBbox | null>(null);
  useEffect(() => {
    if (settledBounds === null) return;
    // Next-tick seed (the useWeatherTimeline idiom): keeps the effect body
    // free of synchronous setState per the set-state-in-effect rule.
    const t = setTimeout(() => {
      setAnchor((prev) => {
        if (prev !== null && !needsReanchor(prev, settledBounds)) return prev;
        const next = windFetchBbox(settledBounds);
        // Same values (e.g. the min-span floor at deep zooms) keep the same
        // identity — no cache/effect/re-seed churn for a no-op re-anchor.
        if (
          prev !== null &&
          next !== null &&
          next.west === prev.west &&
          next.south === prev.south &&
          next.east === prev.east &&
          next.north === prev.north
        ) {
          return prev;
        }
        return next;
      });
    }, 0);
    return () => clearTimeout(t);
  }, [settledBounds]);

  const { field } = useWindField(appActive, model, anchor, timeIso);

  const data = useMemo(() => {
    // anchor === null means the viewport is out of particle scope (e.g.
    // zoomed out past the span gate): hide the streaks even though a stale
    // field may still be in hand — gradient-only is the honest render there.
    if (field === null || anchor === null) return null;
    return {
      ...encodeWindTexture(field),
      lon0: field.lon0,
      latNorth: field.lat0,
      latSpanDeg: field.latSpan,
      lonSpanDeg: field.lonSpan,
    };
  }, [field, anchor]);

  // The overlay re-seeds its particles when this key changes (the grid-UV
  // space the particle state lives in only moves when the anchor does).
  const anchorKey =
    anchor === null ? null : `${anchor.west},${anchor.south},${anchor.east},${anchor.north}`;

  if (!appActive) return null;
  return (
    <WindParticleOverlay
      data={data}
      viewRef={viewRef}
      interacting={interacting}
      anchorKey={anchorKey}
    />
  );
}
