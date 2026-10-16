import { MAP_MAX_PITCH_DEG } from '@core/map/tiltRelief';
import type { RegionPayload } from '@core/map/regionPayload';
import { TERRAIN_MAX_PITCH_DEG } from '@core/terrain3d/morph';
import { is3dPitch, toggleView, VIEW_TOGGLE_MS } from '@core/terrain3d/viewToggle';
import { nativeTerrain } from '@lib/nativeTerrain';
import type { CameraRef } from '@maplibre/maplibre-react-native';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** After the native pitch animation: margin before the camera is read back. */
export const VIEW_TOGGLE_SETTLE_MARGIN_MS = 100;

export interface ViewToggleOptions {
  cameraRef: RefObject<CameraRef | null>;
  /** The native terrain's view tag (null: not attached). */
  viewTag: number | null;
  /** The native 3D terrain draws (the pitch ceiling goes past 60°). */
  terrainActive: boolean;
  /** Reads the settled camera (parsed; null when there is none). */
  readView: () => Promise<RegionPayload | null>;
  /** The screen's settled-camera handler: what an `onRegionDidChange` would run. */
  onSettled: (view: RegionPayload) => void;
}

export interface ViewToggleBinding {
  /** The map reads as 3D: the button offers 2D. */
  is3d: boolean;
  /** The 3D/2D button. */
  onPress: () => void;
  /** Feed every settled camera pitch (onRegionDidChange). */
  onSettledPitch: (pitchDeg: number) => void;
}

/**
 * The map's 3D/2D button (#720). From a tilted view it flattens to 2D and
 * remembers the tilt; from a flat view it goes back to it
 * (`@core/terrain3d/viewToggle`).
 *
 * The native terrain animates the pitch itself (past MapLibre's 60° clamp)
 * by setting the tilt frame by frame, and MapLibre reports no camera settle
 * for that: no `onRegionDidChange`. The screen's settled state (this button,
 * the tilt relief, the scale) then stayed on the old pitch until the next
 * camera move — the button kept offering 3D on a 3D map, and its next press
 * "went to 3D" again, doing nothing. So the button takes its target at the
 * press, and once the animation has run the camera is read back ONCE and
 * handed to `onSettled`, as a settle would have been. MapLibre's own camera
 * animation (no native terrain) does report its settle: nothing to add.
 */
export function useViewToggle(o: ViewToggleOptions): ViewToggleBinding {
  const [pitch, setPitch] = useState(0);
  const remembered3dRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The latest handlers: the timer runs after the press's render is gone.
  const readRef = useRef(o.readView);
  const settledRef = useRef(o.onSettled);
  useLayoutEffect(() => {
    readRef.current = o.readView;
    settledRef.current = o.onSettled;
  });
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  const onSettledPitch = useCallback((p: number) => setPitch(Math.round(p)), []);

  const { cameraRef, viewTag, terrainActive } = o;
  const onPress = useCallback(() => {
    const module = nativeTerrain();
    const maxPitch = terrainActive ? TERRAIN_MAX_PITCH_DEG : MAP_MAX_PITCH_DEG;
    const t = toggleView(pitch, remembered3dRef.current, maxPitch);
    if (t.remember !== null) remembered3dRef.current = t.remember;
    // The button answers the press at once.
    setPitch(t.pitch);
    if (module?.animatePitch !== undefined && viewTag !== null) {
      void module.animatePitch(viewTag, t.pitch, VIEW_TOGGLE_MS);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        readRef
          .current()
          .then((view) => {
            if (view !== null) settledRef.current(view);
          })
          .catch(() => undefined); // mid-teardown: the next settle seeds it
      }, VIEW_TOGGLE_MS + VIEW_TOGGLE_SETTLE_MARGIN_MS);
    } else {
      void cameraRef.current?.setStop({
        pitch: Math.min(t.pitch, MAP_MAX_PITCH_DEG),
        duration: VIEW_TOGGLE_MS,
        easing: 'ease',
      });
    }
  }, [pitch, cameraRef, viewTag, terrainActive]);

  return { is3d: is3dPitch(pitch), onPress, onSettledPitch };
}
