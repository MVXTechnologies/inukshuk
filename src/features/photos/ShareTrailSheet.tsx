import type { TrackPhoto } from '@core/photos/model';
import type { TrackSummary } from '@core/models';

/**
 * Share a trail (#587, owner Q8): the GPX alone by default, or "Trail +
 * photos" as a zip. STUB — built in the share slice.
 */
export interface ShareTrailSheetProps {
  visible: boolean;
  track: TrackSummary;
  /** The trail's own photos (note photos are never shared in the zip). */
  photos: readonly TrackPhoto[];
  onClose: () => void;
  /** A one-line message for the screen's snackbar. */
  onMessage: (message: string) => void;
}

export function ShareTrailSheet(_props: ShareTrailSheetProps) {
  return null;
}
