import {
  overlapHits,
  pickOverlap,
  type AreaCandidate,
  type OverlapPick,
  type TrailCandidate,
} from '@core/map/overlapPick';
import type { LngLat } from '@core/models';
import type { LineString, MultiLineString } from 'geojson';

/** A trail's line as `useTrackHeat.lineFor` gives it (null: not loaded). */
type LineFor = (trackId: string) => { geometry: LineString | MultiLineString } | null;

/**
 * The map tap's overlap pick (#745): the heat grid's coarse candidates
 * (`heatAt`'s track ids) refined against their real lines, plus the shown
 * areas, through the pure `@core/map/overlapPick`.
 */
export function overlapAtTap(
  at: LngLat,
  toleranceM: number,
  trackIds: readonly string[],
  lineFor: LineFor,
  areas: readonly AreaCandidate[],
): OverlapPick {
  const trails: TrailCandidate[] = trackIds.map((id) => {
    const g = lineFor(id)?.geometry;
    if (!g) return { id, parts: null };
    const parts =
      g.type === 'LineString' ? [g.coordinates as LngLat[]] : (g.coordinates as LngLat[][]);
    return { id, parts };
  });
  return pickOverlap(overlapHits(at, toleranceM, trails, areas));
}
