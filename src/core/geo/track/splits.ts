import type { TrackPoint } from '@core/models';
import { haversineMeters } from '@core/geo/geomath';
import { STEP_BREAK, STEP_INVALID, STEP_MOVING } from './movingTime';

/**
 * Per-kilometre (or per-mile) splits for the trail view (#511): how long each
 * unit of distance took, its moving pace, and the climb/descent inside it.
 *
 * Distance is measured like the trail's stats: a hop between two `<trkseg>`
 * (a recording pause) is not walked, so the splits add up to the trail's
 * distance. Time is the time spent inside the split (stops included);
 * moving time comes from the same per-step classification as the trail's
 * moving time, so the splits' moving times add up to it too. A step that
 * crosses a split boundary is shared between the two splits by distance.
 */
export interface Split {
  /** 0-based split number. */
  index: number;
  /** Ground covered in this split, in metres (the unit, except a partial last one). */
  distanceM: number;
  /** Time spent in this split (stops included), seconds; null on an untimed trail. */
  elapsedS: number | null;
  /** Moving time in this split, seconds; null on an untimed trail. */
  movingS: number | null;
  /**
   * Average moving speed, m/s (distance ÷ moving time; elapsed time when
   * nothing counted as moving). Null when untimed.
   */
  speedMps: number | null;
  ascentM: number;
  descentM: number;
  /** True for a last split shorter than the unit. */
  partial: boolean;
}

export interface SplitOpts {
  /** Split length in metres: 1000 (km) or 1609.344 (mile). */
  unitM: number;
  /**
   * Per-step verdicts from `classifySegmentedSteps` (moving time). Without
   * them, every timed step counts as moving.
   */
  steps?: Uint8Array;
  /** Segment starts (pauses): steps into them are never walked or timed. */
  segmentStarts?: readonly number[];
  /** Climb hysteresis, as in the trail stats (default 3 m). */
  elevationThresholdM?: number;
  /**
   * A trailing remainder shorter than this fraction of the unit is folded
   * into the previous split instead of shown as a near-empty one.
   */
  minPartialFraction?: number;
}

const isTimed = (p: TrackPoint): boolean => p.hasTime !== false && Number.isFinite(p.time);
const hasAlt = (p: TrackPoint): boolean => p.altitude !== undefined && Number.isFinite(p.altitude);

interface Acc {
  distanceM: number;
  elapsedS: number;
  movingS: number;
  movingM: number;
  ascentM: number;
  descentM: number;
}

const emptyAcc = (): Acc => ({
  distanceM: 0,
  elapsedS: 0,
  movingS: 0,
  movingM: 0,
  ascentM: 0,
  descentM: 0,
});

/** Splits for a trail; empty for fewer than two points or a non-positive unit. */
export function computeSplits(points: readonly TrackPoint[], opts: SplitOpts): Split[] {
  const unitM = opts.unitM;
  if (points.length < 2 || !(unitM > 0)) return [];
  const threshold = opts.elevationThresholdM ?? 3;
  const steps = opts.steps;
  const breaks = new Set(opts.segmentStarts ?? []);
  let timed = false;

  const accs: Acc[] = [emptyAcc()];
  let walked = 0;
  // Climb hysteresis state, reset at every segment start like the stats.
  let ref: number | undefined;

  const current = (): Acc => accs[accs.length - 1]!;

  const first = points[0]!;
  if (hasAlt(first)) ref = first.altitude;

  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1]!;
    const b = points[k]!;
    const verdict = steps?.[k];
    const isBreak = breaks.has(k) || verdict === STEP_BREAK;
    if (isBreak) {
      ref = hasAlt(b) ? b.altitude : undefined;
      continue;
    }
    const stepM = haversineMeters(a, b);
    const bothTimed = isTimed(a) && isTimed(b);
    const dtS = bothTimed ? (b.time - a.time) / 1000 : 0;
    const timedStep = bothTimed && dtS >= 0 && verdict !== STEP_INVALID;
    if (bothTimed && dtS > 0) timed = true;
    const moving = timedStep && (steps === undefined || verdict === STEP_MOVING);

    // Share the step between splits as it crosses unit boundaries.
    let remaining = stepM;
    if (stepM <= 0) {
      if (timedStep) current().elapsedS += dtS;
      if (moving) current().movingS += dtS;
    }
    while (remaining > 0) {
      const room = unitM * accs.length - walked;
      const take = Math.min(remaining, room);
      const f = stepM > 0 ? take / stepM : 0;
      const acc = current();
      acc.distanceM += take;
      if (timedStep) acc.elapsedS += dtS * f;
      if (moving) {
        acc.movingS += dtS * f;
        acc.movingM += take;
      }
      walked += take;
      remaining -= take;
      if (remaining > 1e-9) accs.push(emptyAcc());
      else break;
    }

    // Climb: the stats' hysteresis (stepElevationGainLoss), booked to the split
    // the point lands in.
    if (hasAlt(b)) {
      const alt = b.altitude!;
      if (ref === undefined) ref = alt;
      else if (alt - ref >= threshold) {
        current().ascentM += alt - ref;
        ref = alt;
      } else if (ref - alt >= threshold) {
        current().descentM += ref - alt;
        ref = alt;
      }
    }
  }

  // An exact multiple leaves an empty trailing accumulator; a tiny remainder
  // folds into the previous split.
  const minPartial = (opts.minPartialFraction ?? 0.02) * unitM;
  const lastAcc = accs[accs.length - 1]!;
  if (accs.length > 1 && lastAcc.distanceM < minPartial) {
    const prev = accs[accs.length - 2]!;
    prev.distanceM += lastAcc.distanceM;
    prev.elapsedS += lastAcc.elapsedS;
    prev.movingS += lastAcc.movingS;
    prev.movingM += lastAcc.movingM;
    prev.ascentM += lastAcc.ascentM;
    prev.descentM += lastAcc.descentM;
    accs.pop();
  }
  if (accs.length === 1 && accs[0]!.distanceM <= 0) return [];

  return accs.map((acc, index) => {
    const speedMps = !timed
      ? null
      : acc.movingS > 0
        ? acc.movingM / acc.movingS
        : acc.elapsedS > 0
          ? acc.distanceM / acc.elapsedS
          : null;
    return {
      index,
      distanceM: acc.distanceM,
      elapsedS: timed ? acc.elapsedS : null,
      movingS: timed ? acc.movingS : null,
      speedMps,
      ascentM: acc.ascentM,
      descentM: acc.descentM,
      partial: acc.distanceM < unitM * 0.999,
    };
  });
}
