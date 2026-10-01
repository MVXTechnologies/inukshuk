import type { BoundingBox, TrackPoint } from '@core/models';
import { sampleGridBilinear } from '@core/geo/terrain';

/** A DEM heightmap: row-major `grid × grid` metres over `bbox` (row 0 = north). */
export interface DemGrid {
  data: ArrayLike<number>;
  grid: number;
  bbox: BoundingBox;
}

/**
 * Replace each point's altitude with the terrain (DEM) height sampled directly
 * under it, so the elevation profile reads the terrain surface itself, and it
 * works even for GPX with no recorded elevation. Sampling: fx from longitude,
 * fy from latitude measured down from the north edge. Points outside
 * the grid clamp to the edge (`sampleGridBilinear` clamps).
 */
export function withDemElevations(points: readonly TrackPoint[], dem: DemGrid): TrackPoint[] {
  const { data, grid, bbox } = dem;
  const spanLng = bbox.maxLng - bbox.minLng || 1;
  const spanLat = bbox.maxLat - bbox.minLat || 1;
  return points.map((p) => ({
    ...p,
    altitude: sampleGridBilinear(
      data,
      grid,
      grid,
      (p.longitude - bbox.minLng) / spanLng,
      (bbox.maxLat - p.latitude) / spanLat,
    ),
  }));
}
