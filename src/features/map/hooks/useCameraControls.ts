import { zoomForVisibleWidth } from '@core/geo/zoomForVisibleWidth';
import type { BoundingBox } from '@core/models';
import type { CameraRef, MapRef } from '@maplibre/maplibre-react-native';
import { useMapStore } from '@state/mapStore';
import { type RefObject, useEffect } from 'react';
import { Dimensions } from 'react-native';
import { toLngLatBounds } from '../geojson';

/** Locate view target: ~2.5 km of terrain across the screen. */
const LOCATE_VIEW_WIDTH_M = 2500;

/**
 * Camera-level controls for the 2D map: the one-shot "fit these bounds"
 * request from the Library, the fit-to-active-overlays action, the locate
 * zoom-in, and the compass reset-to-north action.
 */
export function useCameraControls({
  cameraRef,
  mapRef,
  overlays,
}: {
  cameraRef: RefObject<CameraRef | null>;
  mapRef: RefObject<MapRef | null>;
  overlays: readonly { bbox: BoundingBox }[];
}) {
  const setFollowUser = useMapStore((s) => s.setFollowUser);
  const focusBounds = useMapStore((s) => s.focusBounds);
  const setFocusBounds = useMapStore((s) => s.setFocusBounds);
  const focusWaypoint = useMapStore((s) => s.focusWaypoint);
  const setFocusWaypoint = useMapStore((s) => s.setFocusWaypoint);

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

  // Consume a one-shot "show this waypoint" request (Library → ⋮ → Show on
  // map): fly to the pin at the same comfortable width the locate button uses.
  useEffect(() => {
    if (!focusWaypoint) return;
    setFollowUser(false);
    cameraRef.current?.flyTo({
      center: [focusWaypoint.longitude, focusWaypoint.latitude],
      zoom: zoomForVisibleWidth(
        LOCATE_VIEW_WIDTH_M,
        focusWaypoint.latitude,
        Dimensions.get('window').width,
      ),
      duration: 600,
    });
    setFocusWaypoint(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusWaypoint]);

  /** Fly the camera to one overlay's bounds (the fit FAB's PDF tour). */
  const fitOverlayBounds = (bbox: BoundingBox) => {
    setFollowUser(false);
    cameraRef.current?.fitBounds(toLngLatBounds(bbox), {
      duration: 600,
      padding: { top: 48, right: 48, bottom: 48, left: 48 },
    });
  };

  // Tapping the compass snaps the map back to north (bearing 0), keeping the
  // current center and zoom.
  const resetNorth = () => {
    cameraRef.current?.setStop({ bearing: 0, duration: 300 });
  };

  /**
   * Locate button: alongside re-enabling follow-user (the caller's job), zoom
   * IN until roughly {@link LOCATE_VIEW_WIDTH_M} of terrain spans the screen.
   * Never zooms out — a user who is already closer keeps their zoom.
   */
  const zoomToLocateLevel = async (latitude: number) => {
    const target = zoomForVisibleWidth(
      LOCATE_VIEW_WIDTH_M,
      latitude,
      Dimensions.get('window').width,
    );
    let current: number | undefined;
    try {
      current = await mapRef.current?.getZoom();
    } catch {
      return; // map mid-teardown — leave the zoom alone
    }
    if (current !== undefined && target > current) {
      cameraRef.current?.zoomTo(target, { duration: 600 });
    }
  };

  return { fitOverlayBounds, resetNorth, zoomToLocateLevel };
}
