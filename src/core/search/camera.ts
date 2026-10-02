import type { LngLat } from '@core/models';
import type { Place, PlaceBbox } from './place';
import { PLACE_TYPES } from './placeTypes';

/**
 * Where the camera goes for a chosen result: a fixed zoom on the point that
 * suits the kind of place (a city at ~z12 shows the town, a peak at z14 shows
 * the mountain, a trailhead at z16 the parking lot), or — for areas whose
 * outline the index knows (lakes, parks, islands, regions, your own trails and
 * maps) — the outline framed on screen.
 */
export type CameraTarget =
  { kind: 'point'; center: LngLat; zoom: number } | { kind: 'bounds'; bbox: PlaceBbox };

/**
 * Smaller than this (≈ 300 m) and framing would zoom past street level, so a
 * tiny pond flies to its point like anything else. Larger than 20° and the
 * outline is probably a data error (or a whole country), so we fly to the
 * point at the type's zoom.
 */
const MIN_FIT_SPAN_DEG = 0.003;
const MAX_FIT_SPAN_DEG = 20;

function fitWorthy(bbox: PlaceBbox): boolean {
  const [w, s, e, n] = bbox;
  const span = Math.max(e - w, n - s);
  return span >= MIN_FIT_SPAN_DEG && span <= MAX_FIT_SPAN_DEG && e >= w;
}

export function cameraTargetFor(place: Place): CameraTarget {
  const info = PLACE_TYPES[place.type];
  if (info.fitBounds && place.bbox !== undefined && fitWorthy(place.bbox)) {
    return { kind: 'bounds', bbox: place.bbox };
  }
  return { kind: 'point', center: [place.longitude, place.latitude], zoom: info.zoom };
}
