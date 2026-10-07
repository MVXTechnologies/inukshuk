import type { TrackPhoto } from '@core/photos/model';

/**
 * A trail's photos on a MapLibre map (#587): clustered circles with count
 * badges, and the selected photo. STUB — built in the map-layer slice.
 */
export interface TrailPhotoLayersProps {
  /** Unique per map: source and layer ids are prefixed with it. */
  id: string;
  photos: readonly TrackPhoto[];
  /** The photo to ring (profile cursor, viewer "Show on map"). */
  selectedId?: string | null;
  /** Below this zoom nothing is drawn (main map setting); 0 = always. */
  minZoom?: number;
  /** A single photo, or a stack that cannot be split further (its photos, time order). */
  onPhotoPress?: (photoIds: string[]) => void;
}

export function TrailPhotoLayers(_props: TrailPhotoLayersProps) {
  return null;
}
