/**
 * Coarse position cells: a list sorted by distance from you (the tide
 * stations near you, the waypoints in a target picker) re-sorts when you
 * change cell, never on each fix or tick — a fix inside the cell costs a
 * rounding and a compare.
 */
import type { LatLng } from '@core/models';

/** The editor's distance-sorted lists: ~50 m cells (0.00045° of latitude). */
export const LIST_CELL_DEG = 0.00045;

/** The cell `at` falls in, as its rounded centre: equal by value for every point in it. */
export function cellOf(at: LatLng, cellDeg: number): LatLng {
  const round = (v: number) => Math.round(v / cellDeg) * cellDeg;
  return { latitude: round(at.latitude), longitude: round(at.longitude) };
}
