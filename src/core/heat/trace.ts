import { HEAT_CELL_M, cellAt, cellKey, ringKeys } from './grid';

/**
 * A track's footprint on the heat grid. `perPoint` (undilated) feeds run
 * splitting; `dilated` (segment-interpolated + 1-ring) feeds overlap
 * matching, so two GPS traces of the same physical path wobbling 10–20 m
 * apart still meet in shared cells.
 */
export interface CellTrace {
  perPoint: string[];
  dilated: Set<string>;
}

const M_PER_DEG_LAT = 111320;

export function traceCells(
  points: readonly { latitude: number; longitude: number }[],
  cellSizeM: number = HEAT_CELL_M,
): CellTrace {
  const perPoint: string[] = [];
  const dilated = new Set<string>();

  const stamp = (lng: number, lat: number) => {
    for (const k of ringKeys(cellAt(lng, lat, cellSizeM))) dilated.add(k);
  };

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!p) continue;
    perPoint.push(cellKey(cellAt(p.longitude, p.latitude, cellSizeM)));
    stamp(p.longitude, p.latitude);

    const next = points[i + 1];
    if (!next) continue;
    // Interpolate along the segment at half-cell spacing so a sparse
    // recording (or an imported route with long straight legs) cannot skip
    // grid cells between fixes.
    const dLatM = (next.latitude - p.latitude) * M_PER_DEG_LAT;
    const dLngM =
      (next.longitude - p.longitude) * M_PER_DEG_LAT * Math.cos((p.latitude * Math.PI) / 180);
    const lengthM = Math.hypot(dLatM, dLngM);
    const steps = Math.floor(lengthM / (cellSizeM / 2));
    for (let s = 1; s <= steps; s++) {
      const t = s / (steps + 1);
      stamp(
        p.longitude + (next.longitude - p.longitude) * t,
        p.latitude + (next.latitude - p.latitude) * t,
      );
    }
  }
  return { perPoint, dilated };
}
