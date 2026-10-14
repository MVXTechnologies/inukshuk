import { Camera, type CameraProps } from '@maplibre/maplibre-react-native';
import { useHeadingCamera } from '../hooks/useHeadingCamera';

/**
 * MapLibre's `<Camera>`, plus the "Rotate map with compass" bearing.
 *
 * While `followHeading` is on, the bearing follows the display-rate heading
 * (`useHeadingCamera`): one jump per animation frame while you turn, nothing
 * at rest. The heading lives in THIS component's state, so a heading frame
 * re-renders the camera alone — never MapScreen, which 2.6.0 re-rendered on
 * every heading sample. Every other prop (and the ref) passes straight through.
 *
 * We deliberately do NOT use `trackUserLocation="heading"`: that maps to
 * MapLibre's native CameraMode.TRACKING_COMPASS, which drives the bearing
 * from the platform's own compass — not the filtered heading the cone and the
 * tape show — so the map would disagree with them.
 */
export function HeadingCamera({
  followHeading,
  ...props
}: CameraProps & { followHeading: boolean }) {
  const bearing = useHeadingCamera(followHeading);
  return <Camera {...props} {...(bearing !== undefined ? { bearing, duration: 0 } : {})} />;
}
