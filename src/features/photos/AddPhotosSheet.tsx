import type { TrackPoint, TrackSummary } from '@core/models';

/**
 * The Add-photos sheet (#587): pick from the library, see the three groups
 * and the camera clock, add. STUB — built in the add-photos slice.
 */
export interface AddPhotosSheetProps {
  visible: boolean;
  track: TrackSummary;
  /** The trail's points (the time/GPS placement runs against them). */
  points: readonly TrackPoint[];
  /** Where a ticked "not from this outing" photo without GPS goes (the profile cursor). */
  fallbackDistanceM?: number;
  onClose: () => void;
  /** A one-line result for the screen's snackbar ("Added 33 photos"). */
  onDone: (message: string) => void;
}

export function AddPhotosSheet(_props: AddPhotosSheetProps) {
  return null;
}
