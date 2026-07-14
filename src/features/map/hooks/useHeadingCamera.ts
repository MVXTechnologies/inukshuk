import { signedDeltaDeg } from '@core/signal/heading';
import { useSettingsStore } from '@state/settingsStore';
import { useEffect, useRef, useState } from 'react';
import { subscribeHeading } from '../useCompass';

/** Minimum circular change (degrees) before a new camera heading is emitted. */
const MIN_EMIT_DELTA_DEG = 0.5;
/** Minimum time between camera heading emissions (ms) — caps bridge traffic. */
const MIN_EMIT_INTERVAL_MS = 80;

/**
 * Camera heading for the "Rotate map with compass" setting.
 *
 * Returns the smoothed device heading ([0, 360)) while `rotateMapWithHeading`
 * is on, and `undefined` while it's off. Pass the result straight to
 * MapLibre's `<Camera bearing={...} />` — `undefined` leaves the camera's
 * rotation alone. MapLibre's native transition normalizes bearing changes to
 * the shortest arc, so crossing 0/360 rotates the short way.
 *
 * Perf: the raw sensor stream never touches React state — it comes from the
 * shared smoothed subscription (see `subscribeHeading`), and state (hence a
 * re-render + camera update) is only emitted when the heading moves by at
 * least MIN_EMIT_DELTA_DEG and MIN_EMIT_INTERVAL_MS has elapsed. The old
 * whole-degree rounding + 2° gate made the rotation advance in visible 2°
 * ticks; the finer gate plus a short eased camera transition (set where the
 * Camera is rendered) keeps it fluid. When the setting is off the hook
 * subscribes to nothing.
 *
 * Like `useCompass`, this expects location permission to already be granted.
 */
export function useHeadingCamera(): number | undefined {
  const enabled = useSettingsStore((s) => s.rotateMapWithHeading);
  const [cameraHeading, setCameraHeading] = useState<number | undefined>(undefined);
  const emittedRef = useRef<{ headingDeg: number; atMs: number } | undefined>(undefined);

  useEffect(() => {
    if (!enabled) {
      // Forget the last emission so re-enabling emits fresh state immediately.
      // (The stale `cameraHeading` state is masked by the `enabled` gate below.)
      emittedRef.current = undefined;
      return;
    }
    return subscribeHeading(({ headingDeg }) => {
      const prev = emittedRef.current;
      const now = Date.now();
      if (
        prev !== undefined &&
        (Math.abs(signedDeltaDeg(prev.headingDeg, headingDeg)) < MIN_EMIT_DELTA_DEG ||
          now - prev.atMs < MIN_EMIT_INTERVAL_MS)
      ) {
        return;
      }
      emittedRef.current = { headingDeg, atMs: now };
      setCameraHeading(headingDeg);
    });
  }, [enabled]);

  // While off, mask any state left over from a previous enabled period. On
  // re-enable the last heading shows briefly, then corrects on the first
  // sensor reading (the ref was cleared, so it always emits).
  return enabled ? cameraHeading : undefined;
}
