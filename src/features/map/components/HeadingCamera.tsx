import { headingCameraMode } from '@core/map/headingCameraMode';
import { Camera, type CameraProps } from '@maplibre/maplibre-react-native';
import { useHeadingCamera } from '../hooks/useHeadingCamera';

/**
 * MapLibre's `<Camera>`, plus the "Rotate map with compass" bearing.
 *
 * Who turns the map is `headingCameraMode`'s call:
 * - **Following you** (`trackUserLocation` set): MapLibre's native follow in
 *   its compass mode (`trackUserLocation="heading"`), animated natively.
 *   A bearing sent from JS here would END the follow on Android (any app
 *   camera move notifies the location component, which drops tracking), so
 *   none is sent.
 * - **Not following**: the display-rate heading (`useHeadingCamera`), one
 *   jump per frame while you turn, nothing at rest. The heading lives in THIS
 *   component's state, so a frame re-renders the camera alone — never
 *   MapScreen.
 *
 * Every other prop (and the ref) passes straight through.
 */
export function HeadingCamera({
  followHeading,
  trackUserLocation,
  ...props
}: CameraProps & { followHeading: boolean }) {
  const mode = headingCameraMode(followHeading, trackUserLocation);
  const bearing = useHeadingCamera(mode.jsBearing);
  return (
    <Camera
      {...props}
      trackUserLocation={mode.trackUserLocation}
      {...(bearing !== undefined ? { bearing, duration: 0 } : {})}
    />
  );
}
