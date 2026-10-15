/**
 * Who turns the map in heading-up ("Rotate map with compass"): our display-rate
 * heading, or MapLibre's native follow mode.
 *
 * ## Why not always ours
 *
 * Any camera move an app makes while MapLibre follows the user ENDS the
 * follow on Android: `MapLibreMap.moveCamera` / `easeCamera` /
 * `animateCamera` notify the "developer animation" listeners first, and the
 * location component's listener answers with `setCameraMode(NONE)`.
 * maplibre-react-native applies every `<Camera>` bearing through those
 * methods, then reports the follow as ended (`onTrackUserLocationChange`
 * with null), and the app drops Locate back to idle — after one heading step
 * (2.6.1 QA). Only the location component's own camera moves (which go
 * through `Transform` directly) keep the follow alive.
 *
 * So while the map follows you, the bearing is left to the follow itself:
 * `trackUserLocation="heading"` (Android CameraMode.TRACKING_COMPASS, iOS
 * MLNUserTrackingModeFollowWithHeading), animated natively from the
 * platform's fused compass. When it does not follow (you panned away, or an
 * external receiver drives the position), no follow can end, and our own
 * heading turns the camera.
 */
export type TrackUserLocationMode = 'default' | 'heading' | 'course';

export interface HeadingCameraMode {
  /** The native follow mode for `<Camera trackUserLocation>`, or undefined (no follow). */
  trackUserLocation: TrackUserLocationMode | undefined;
  /** Whether OUR display-rate heading sets the camera bearing. */
  jsBearing: boolean;
}

/**
 * `followHeading`: heading-up is on (and not paused, e.g. by team drawing).
 * `trackUserLocation`: the follow mode the screen wants without heading-up.
 */
export function headingCameraMode(
  followHeading: boolean,
  trackUserLocation: TrackUserLocationMode | undefined,
): HeadingCameraMode {
  if (!followHeading) return { trackUserLocation, jsBearing: false };
  if (trackUserLocation === undefined) return { trackUserLocation, jsBearing: true };
  // Following: never move the camera from JS (it would end the follow); let
  // the native follow turn it with the compass.
  return { trackUserLocation: 'heading', jsBearing: false };
}
