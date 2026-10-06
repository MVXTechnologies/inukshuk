import type { LngLat, TrackPoint } from '@core/models';

/**
 * Synthetic trails for the photo tests: straight east-west lines near the
 * Lac des Cygnes trailhead (Grands-Jardins), one fix every `stepM` metres at
 * a steady pace, so distances and times are easy to reason about.
 */

export const T0 = Date.UTC(2026, 8, 27, 13, 12, 0); // 09:12 EDT
export const ORIGIN: LngLat = [-70.6274, 47.6658];
const M_PER_DEG_LAT = (6371008.8 * Math.PI) / 180; // the haversine sphere
const M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos((ORIGIN[1] * Math.PI) / 180);

/** The point `eastM` metres east and `northM` metres north of the origin. */
export function offset(eastM: number, northM = 0): LngLat {
  return [ORIGIN[0] + eastM / M_PER_DEG_LNG, ORIGIN[1] + northM / M_PER_DEG_LAT];
}

export interface LineOptions {
  /** Total length (m). */
  lengthM: number;
  stepM?: number;
  /** Seconds per metre (1 = 3.6 km/h). */
  secPerM?: number;
  /** Climb per metre along the line. */
  grade?: number;
  startTime?: number;
  /** Leave the timestamps off (a planned route). */
  untimed?: boolean;
}

function point(eastM: number, time: number, ele: number, untimed: boolean): TrackPoint {
  const [longitude, latitude] = offset(eastM);
  const p: TrackPoint = { latitude, longitude, altitude: ele, time: untimed ? 0 : time };
  if (untimed) p.hasTime = false;
  return p;
}

/** One way, east. */
export function lineTrack({
  lengthM,
  stepM = 10,
  secPerM = 1,
  grade = 0.1,
  startTime = T0,
  untimed = false,
}: LineOptions): TrackPoint[] {
  const pts: TrackPoint[] = [];
  for (let d = 0; d <= lengthM + 1e-9; d += stepM) {
    pts.push(point(d, startTime + d * secPerM * 1000, 500 + d * grade, untimed));
  }
  return pts;
}

/**
 * East for `lengthM`, a `pauseS` stop at the far end, then back west along
 * the same line: every spot is passed twice.
 */
export function outAndBack(opts: LineOptions & { pauseS?: number }): TrackPoint[] {
  const { lengthM, stepM = 10, secPerM = 1, grade = 0.1, startTime = T0, pauseS = 0 } = opts;
  const out = lineTrack({ lengthM, stepM, secPerM, grade, startTime });
  const turnTime = out[out.length - 1]!.time + pauseS * 1000;
  const back: TrackPoint[] = [];
  for (let k = 1; k * stepM <= lengthM + 1e-9; k++) {
    const d = lengthM - k * stepM;
    back.push(point(d, turnTime + k * stepM * secPerM * 1000, 500 + d * grade, false));
  }
  // The pause: a second fix at the turnaround, `pauseS` later.
  const turn = out[out.length - 1]!;
  const pauseFix = pauseS > 0 ? [{ ...turn, time: turnTime }] : [];
  return [...out, ...pauseFix, ...back];
}
