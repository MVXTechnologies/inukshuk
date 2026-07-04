import { createHeadingSmoother } from '@core/signal/heading';
import { useSettingsStore } from '@state/settingsStore';
import * as Location from 'expo-location';
import { useEffect, useRef, useState } from 'react';

/** Minimum circular change (degrees) before a new camera heading is emitted. */
const MIN_EMIT_DELTA_DEG = 2;

/** Shortest angular distance between two headings, in [0, 180]. */
function circularDeltaDeg(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Camera heading for the "Rotate map with compass" setting.
 *
 * Returns the smoothed device heading in whole degrees ([0, 360)) while
 * `rotateMapWithHeading` is on, and `undefined` while it's off. Pass the
 * result straight to MapLibre's `<Camera heading={...} />` — `undefined`
 * leaves the camera's rotation alone.
 *
 * Perf: the raw sensor stream never touches React state — readings stay in
 * the subscription/ref, and state (hence a re-render) is only emitted when
 * the smoothed heading moves by at least MIN_EMIT_DELTA_DEG degrees, so the
 * camera is not updated at sensor rate. When the setting is off the hook
 * subscribes to nothing.
 *
 * Like `useCompass`, this expects location permission to already be granted.
 */
export function useHeadingCamera(): number | undefined {
  const enabled = useSettingsStore((s) => s.rotateMapWithHeading);
  const [cameraHeading, setCameraHeading] = useState<number | undefined>(undefined);
  const emittedRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!enabled) {
      // Forget the last emission so re-enabling emits fresh state immediately.
      // (The stale `cameraHeading` state is masked by the `enabled` gate below.)
      emittedRef.current = undefined;
      return;
    }
    let cancelled = false;
    let sub: Location.LocationSubscription | undefined;
    const smoother = createHeadingSmoother();

    (async () => {
      sub = await Location.watchHeadingAsync((h) => {
        if (cancelled) return;
        const deg = h.trueHeading >= 0 ? h.trueHeading : h.magHeading;
        const smoothed = smoother.push(deg);
        const prev = emittedRef.current;
        if (prev !== undefined && circularDeltaDeg(prev, smoothed) < MIN_EMIT_DELTA_DEG) return;
        const rounded = Math.round(smoothed) % 360;
        emittedRef.current = rounded;
        setCameraHeading(rounded);
      });
    })();

    return () => {
      cancelled = true;
      sub?.remove();
    };
  }, [enabled]);

  // While off, mask any state left over from a previous enabled period. On
  // re-enable the last heading shows briefly, then corrects on the first
  // sensor reading (the ref was cleared, so it always emits).
  return enabled ? cameraHeading : undefined;
}
