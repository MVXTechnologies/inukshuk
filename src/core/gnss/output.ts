/**
 * A fix's coordinates where the app needs them, through `datum.ts`'s plans:
 *
 * - **on the map** (the blue dot, recording): WGS 84, the frame the map's
 *   tiles are drawn in. A fix corrected in NAD83(CSRS) 1997.0 sits ≈ 1.5 m
 *   from where WGS 84 puts that spot today; the plan moves it, with its
 *   stated accuracy. When the move is refused (no validated route), the dot
 *   is drawn where the receiver put it and the sheet says why, in Convert's
 *   words — never a guessed shift;
 * - **in the project datum** (the detail sheet, owner decision A4): the
 *   user's chosen frame, epoch and height system.
 *
 * Plans are made once per receiver frame, project datum, observation day and
 * ~10 km of travel; each fix then costs one `OffsetCache` addition.
 */
import type { Engine } from '../convert/run';
import type { Refusal } from '../convert/types';
import type { CorrectionFrame } from './casters';
import {
  OffsetCache,
  planFixOutput,
  receiverFrame,
  type FixPoint,
  type OutputPlan,
  type OutputPlanResult,
  type ProjectDatum,
  type ProjectedFix,
} from './datum';
import type { GnssFix } from './fix';

/** The map draws in WGS 84 (2D: the dot needs no height). */
export const MAP_DATUM: ProjectDatum = { frame: 'wgs84', height: null };

/** Re-plan after this much travel, so Convert's region checks follow the user. */
export const REPLAN_KM = 10;

/** Corrections as `receiverFrame` takes them (the active profile's frame, or none). */
export type Corrections = CorrectionFrame | null | 'none';

export type PositionResult =
  | { ok: true; plan: OutputPlan; value: ProjectedFix }
  | {
      ok: false;
      refusal: Refusal;
      /** The plan, when it was the engine that refused (null: no plan was possible). */
      plan: OutputPlan | null;
    };

function fixPoint(fix: GnssFix, nowMs: number): FixPoint {
  return { lat: fix.lat, lon: fix.lon, hEll: fix.hEll, timeMs: fix.timeMs ?? nowMs };
}

/** One target datum: its plan (re-made when its key changes) and its offset cache. */
class Target {
  private key = '';
  private at: { lat: number; lon: number } | null = null;
  private result: OutputPlanResult | null = null;
  private readonly cache: OffsetCache;

  constructor(engine: Engine) {
    this.cache = new OffsetCache(engine);
  }

  run(fix: GnssFix, corrections: Corrections, datum: ProjectDatum, nowMs: number): PositionResult {
    const pt = fixPoint(fix, nowMs);
    const receiver = receiverFrame(fix.kind, corrections);
    const day = Math.floor(pt.timeMs / 86_400_000);
    const key = JSON.stringify([receiver, datum, day]);
    const moved =
      this.at !== null &&
      (Math.abs(this.at.lat - pt.lat) * 111 > REPLAN_KM ||
        Math.abs(this.at.lon - pt.lon) * 111 * Math.cos((pt.lat * Math.PI) / 180) > REPLAN_KM);
    if (this.result === null || key !== this.key || moved) {
      this.key = key;
      this.at = { lat: pt.lat, lon: pt.lon };
      this.result = planFixOutput(pt, receiver, datum);
    }
    const r = this.result;
    if (!r.ok) return { ok: false, refusal: r.refusal, plan: null };
    const t = this.cache.apply(r.out, pt);
    if (!t.ok) return { ok: false, refusal: t.refusal, plan: r.out };
    return { ok: true, plan: r.out, value: t.value };
  }
}

/**
 * The two outputs of one receiver session. The engine is native PROJ when the
 * build has it (`@lib/nativeProj`), else Convert's grid-free `lite` engine,
 * which refuses what needs a grid — shown, not worked around.
 */
export class FixOutputs {
  private readonly map: Target;
  private readonly project: Target;

  constructor(engine: Engine) {
    this.map = new Target(engine);
    this.project = new Target(engine);
  }

  /** Where the dot goes (WGS 84). */
  onMap(fix: GnssFix, corrections: Corrections, nowMs: number): PositionResult {
    return this.map.run(fix, corrections, MAP_DATUM, nowMs);
  }

  /** The fix in the user's project datum. */
  inProject(
    fix: GnssFix,
    corrections: Corrections,
    datum: ProjectDatum,
    nowMs: number,
  ): PositionResult {
    return this.project.run(fix, corrections, datum, nowMs);
  }
}

/** Where to draw a fix: the WGS 84 position, or the receiver's own when the move was refused. */
export function drawnPosition(fix: GnssFix, r: PositionResult): { lat: number; lon: number } {
  return r.ok ? { lat: r.value.lat, lon: r.value.lon } : { lat: fix.lat, lon: fix.lon };
}
