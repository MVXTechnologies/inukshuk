import { normalizeBearingDeg, shouldSnapToNorth } from '@core/geo/northSnap';
import { useSettingsStore } from '@state/settingsStore';
import { useCallback, useRef, useState } from 'react';

/**
 * How long a snap request suppresses the next one (ms).
 *
 * Comfortably longer than the 250 ms camera move so the settle the snap itself
 * produces cannot ask for another, and short enough that a gesture which
 * interrupts a snap mid-flight is judged on its own merits a moment later.
 * This is a belt-and-braces guard: {@link shouldSnapToNorth} already returns
 * false for the near-zero bearing a completed snap lands on.
 */
const SNAP_REARM_MS = 600;

/**
 * The map's settled bearing, plus the snap-back detent that keeps it honest
 * (#248).
 *
 * Fed from the camera **settle** path (`onRegionDidChange`) — the same one the
 * scale bar uses, never the gesture-rate `onRegionIsChanging`, which would
 * re-render the whole map tree per frame and fight the user mid-pinch.
 *
 * On each settle:
 * - the bearing is published for the compass badge's red north needle, and
 * - if it is a small, almost certainly accidental rotation (see
 *   `shouldSnapToNorth`), the camera is sent back to north. MapLibre's
 *   two-finger pinch starts rotating after a very small twist, so a plain zoom
 *   leaves the map a few degrees crooked; the detent undoes that while leaving
 *   a deliberate twist exactly where the user put it.
 *
 * Not while "rotate map with heading" is on: there the bearing is *owned* by
 * the device compass, and snapping to north would yank the camera out from
 * under the setting on every settle.
 */
export function useMapBearing({ snapToNorth }: { snapToNorth: () => void }) {
  const headingFollow = useSettingsStore((s) => s.rotateMapWithHeading);
  const [mapBearing, setMapBearing] = useState(0);
  // When the last snap was requested. A ref, not state: it is read and written
  // only from the settle handler, and it must never itself cause a render.
  const lastSnapAtRef = useRef(0);

  const onSettleBearing = useCallback(
    (bearingDeg: number) => {
      const bearing = normalizeBearingDeg(bearingDeg);
      setMapBearing((prev) => (prev === bearing ? prev : bearing));
      if (headingFollow) return;
      // `shouldSnapToNorth` is false for an already-north-up bearing, which is
      // what keeps the snap's own settle from asking for another one.
      if (!shouldSnapToNorth(bearing)) return;
      const now = Date.now();
      if (now - lastSnapAtRef.current < SNAP_REARM_MS) return;
      lastSnapAtRef.current = now;
      snapToNorth();
    },
    [headingFollow, snapToNorth],
  );

  return { mapBearing, onSettleBearing };
}
