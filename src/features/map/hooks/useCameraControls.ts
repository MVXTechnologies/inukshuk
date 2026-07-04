import type { BoundingBox } from '@core/models';
import type { CameraRef } from '@maplibre/maplibre-react-native';
import { useMapStore } from '@state/mapStore';
import { type RefObject, useEffect, useMemo } from 'react';
import { toLngLatBounds } from '../geojson';

/**
 * Camera-level controls for the 2D map: the one-shot "fit these bounds"
 * request from the Library, the fit-to-active-overlays action, and the
 * compass reset-to-north action.
 */
export function useCameraControls({
  cameraRef,
  overlays,
}: {
  cameraRef: RefObject<CameraRef | null>;
  overlays: readonly { bbox: BoundingBox }[];
}) {
  const setFollowUser = useMapStore((s) => s.setFollowUser);
  const focusBounds = useMapStore((s) => s.focusBounds);
  const setFocusBounds = useMapStore((s) => s.setFocusBounds);

  // Consume a one-shot "fit these bounds" request (e.g. "view trail" from the
  // Library) — fly to the trail instead of staying on the user's location.
  useEffect(() => {
    if (!focusBounds) return;
    setFollowUser(false);
    cameraRef.current?.fitBounds(toLngLatBounds(focusBounds), {
      duration: 600,
      padding: { top: 60, right: 60, bottom: 220, left: 60 },
    });
    setFocusBounds(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusBounds]);

  // Union bounds of all active overlays, for the "fit to page" control.
  const overlaysBbox = useMemo<BoundingBox | null>(() => {
    if (overlays.length === 0) return null;
    return overlays.reduce<BoundingBox | null>(
      (acc, o) =>
        acc === null
          ? o.bbox
          : {
              minLat: Math.min(acc.minLat, o.bbox.minLat),
              minLng: Math.min(acc.minLng, o.bbox.minLng),
              maxLat: Math.max(acc.maxLat, o.bbox.maxLat),
              maxLng: Math.max(acc.maxLng, o.bbox.maxLng),
            },
      null,
    );
  }, [overlays]);

  const fitActiveMap = () => {
    if (overlaysBbox) {
      setFollowUser(false);
      cameraRef.current?.fitBounds(toLngLatBounds(overlaysBbox), {
        duration: 600,
        padding: { top: 48, right: 48, bottom: 48, left: 48 },
      });
    }
  };

  // Tapping the compass snaps the map back to north (bearing 0), keeping the
  // current center and zoom.
  const resetNorth = () => {
    cameraRef.current?.setStop({ bearing: 0, duration: 300 });
  };

  return { fitActiveMap, resetNorth };
}
