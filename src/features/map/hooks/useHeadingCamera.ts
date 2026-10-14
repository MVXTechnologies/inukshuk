import { useEffect, useState } from 'react';
import { subscribeHeadingMotion } from '../headingMotion';

/** Bearing changes smaller than this are not sent to the native camera, °. */
const MIN_CAMERA_DELTA_DEG = 0.02;

/**
 * Camera bearing for the "Rotate map with compass" setting, at display rate.
 *
 * Returns the display-rate heading ([0, 360)) while `active`, and `undefined`
 * otherwise: pass it to MapLibre's `<Camera bearing={…} duration={0} />`
 * (see `HeadingCamera`, which owns this hook so a heading frame re-renders
 * the camera alone, never MapScreen).
 *
 * Why every frame, with no native transition: on Android, MapLibre's
 * location component moves the camera with `moveCamera` on EVERY animation
 * frame while it follows you, and each `moveCamera` cancels any running
 * camera transition. The 150 ms bearing ease 2.6.0 sent per sensor sample was
 * cut off one frame in whenever follow was on, so the map turned a sliver per
 * sample and froze in between. A per-frame jump composes with the follow
 * animation instead of fighting it; on iOS, while following, MapLibre-RN
 * already applied the bearing without animation. The motion itself comes
 * from the shared display-rate follower (`subscribeHeadingMotion`), so it is
 * the same frame the cone and the tape draw.
 *
 * At rest nothing is sent: the follower settles and the frame loop stops.
 * Like `subscribeHeading`, this expects location permission to already be granted.
 */
export function useHeadingCamera(active: boolean): number | undefined {
  const [bearing, setBearing] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (!active) return;
    return subscribeHeadingMotion((frame) => setBearing(frame.headingDeg), {
      minDeltaDeg: MIN_CAMERA_DELTA_DEG,
    });
  }, [active]);
  // While off, mask any state left over from a previous active period. On
  // re-enable the last heading shows for a frame, then the first frame corrects it.
  return active ? bearing : undefined;
}
