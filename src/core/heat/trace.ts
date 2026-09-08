import { HEAT_CELL_M, cellAt, cellKey, ringKeys } from './grid';

/**
 * A track's footprint on the heat grid. `perPoint` contains undilated keys
 * for the sampled fixes (all fixes for tracks within the input limit);
 * `dilated` (segment-interpolated + 1-ring) feeds overlap
 * matching, so two GPS traces of the same physical path wobbling 10–20 m
 * apart still meet in shared cells.
 */
export interface CellTrace {
  perPoint: string[];
  dilated: Set<string>;
}

const M_PER_DEG_LAT = 111320;
// Bound synchronous map work, including input stamps (each adds at most 9 cells).
const MAX_TRACE_POINTS = 100_000;
const MAX_SEGMENT_SAMPLES = 2_048;
const MAX_INTERPOLATED_SAMPLES = 20_000;

/**
 * Samples at most 100,000 input fixes evenly, always retaining first and last.
 * The source geometry is never modified. Gaps exceeding the segment limit and
 * segments after the interpolation budget is exhausted receive endpoint stamps
 * only, rather than fabricating a sparse heat corridor across missing data.
 * Rejects invalid sampled coordinates and unsafe grid sizes before building
 * the footprint. Unsampled fixes do not contribute to heat or tap matching.
 */
export function traceCells(
  points: readonly { latitude: number; longitude: number }[],
  cellSizeM: number = HEAT_CELL_M,
): CellTrace {
  if (!Number.isFinite(cellSizeM) || cellSizeM < 1 || cellSizeM > M_PER_DEG_LAT * 180) {
    throw new RangeError('Heat cell size must be between 1 metre and half the world');
  }
  let tracePoints = points;
  if (points.length > MAX_TRACE_POINTS) {
    const sampled: { latitude: number; longitude: number }[] = [];
    for (let i = 0; i < MAX_TRACE_POINTS; i++) {
      const point = points[Math.floor((i * (points.length - 1)) / (MAX_TRACE_POINTS - 1))];
      if (point) sampled.push(point);
    }
    tracePoints = sampled;
  }
  for (const point of tracePoints) {
    if (
      !Number.isFinite(point.latitude) ||
      !Number.isFinite(point.longitude) ||
      Math.abs(point.latitude) > 90 ||
      Math.abs(point.longitude) > 180
    ) {
      throw new RangeError('Heat trace requires valid geographic coordinates');
    }
  }
  let remainingSamples = MAX_INTERPOLATED_SAMPLES;
  const perPoint: string[] = [];
  const dilated = new Set<string>();

  const stamp = (lng: number, lat: number) => {
    for (const k of ringKeys(cellAt(lng, lat, cellSizeM), cellSizeM)) dilated.add(k);
  };

  for (let i = 0; i < tracePoints.length; i++) {
    const p = tracePoints[i];
    if (!p) continue;
    perPoint.push(cellKey(cellAt(p.longitude, p.latitude, cellSizeM)));
    stamp(p.longitude, p.latitude);

    const next = tracePoints[i + 1];
    if (!next) continue;
    if (remainingSamples === 0) continue;
    // Interpolate along the segment at half-cell spacing so a sparse
    // recording cannot skip grid cells between fixes within the work budget.
    const dLatM = (next.latitude - p.latitude) * M_PER_DEG_LAT;
    // Follow the short arc at the dateline instead of sweeping around Earth.
    const dLng = ((((next.longitude - p.longitude + 180) % 360) + 360) % 360) - 180;
    const dLngM = dLng * M_PER_DEG_LAT * Math.cos((p.latitude * Math.PI) / 180);
    const lengthM = Math.hypot(dLatM, dLngM);
    const steps = Math.floor(lengthM / (cellSizeM / 2));
    if (steps > MAX_SEGMENT_SAMPLES || steps > remainingSamples) continue;
    remainingSamples -= steps;
    for (let s = 1; s <= steps; s++) {
      const t = s / (steps + 1);
      stamp(
        ((((p.longitude + dLng * t + 180) % 360) + 360) % 360) - 180,
        p.latitude + (next.latitude - p.latitude) * t,
      );
    }
  }
  return { perPoint, dilated };
}
