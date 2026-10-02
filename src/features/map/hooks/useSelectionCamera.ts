import type { LngLat } from '@core/models';
import { useCallback, useMemo, useRef, type RefObject } from 'react';

/** The slice of MapLibre's CameraRef this uses. */
interface CameraLike {
  setStop(stop: { center: LngLat; zoom: number; duration: number }): void;
}

/** The slice of MapLibre's MapRef this uses. */
interface MapLike {
  getViewState(): Promise<{ center: LngLat; zoom: number }>;
}

/**
 * The camera around a trail/heat selection: the view from BEFORE the first
 * selection-driven fit, kept so the selection's ✕ can glide back to it.
 *
 * - `fitAfterCapture(fit, canRead)`: snapshot the current view (once per
 *   selection "session": switching from one trail to another keeps the
 *   original snapshot), then run the fit. `canRead` must be the map-loaded
 *   gate — getViewState before the native view is up crashes natively.
 * - `restore()`: the ✕ on the panel or the carousel — glide back, and clear.
 * - `forget()`: leaving the focus by tapping the map elsewhere (2.1.1) —
 *   clear WITHOUT moving: the camera stays where the user put it.
 */
export function useSelectionCamera(
  cameraRef: RefObject<CameraLike | null>,
  mapRef: RefObject<MapLike | null>,
) {
  const saved = useRef<{ center: LngLat; zoom: number } | null>(null);

  const fitAfterCapture = useCallback(
    (fit: () => void, canRead: boolean) => {
      if (saved.current === null && canRead && mapRef.current) {
        void mapRef.current
          .getViewState()
          .then((vs) => {
            saved.current = { center: vs.center, zoom: vs.zoom };
          })
          .catch(() => {
            // Map mid-teardown: no snapshot, so the ✕ just won't glide back.
          })
          .finally(fit);
      } else {
        fit();
      }
    },
    [mapRef],
  );

  const restore = useCallback(() => {
    const prev = saved.current;
    if (!prev) return;
    saved.current = null;
    cameraRef.current?.setStop({ center: prev.center, zoom: prev.zoom, duration: 600 });
  }, [cameraRef]);

  const forget = useCallback(() => {
    saved.current = null;
  }, []);

  // One identity across renders: MapScreen's memoized tap handler depends on it.
  return useMemo(() => ({ fitAfterCapture, restore, forget }), [fitAfterCapture, restore, forget]);
}
