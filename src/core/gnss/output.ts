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
import { withGridPaths, type InstalledGrid } from '../convert/packs';
import type { Engine } from '../convert/run';
import { gridPaths } from '../convert/session';
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

/**
 * The grids on this device, as Convert resolves them (`@core/convert/session`
 * gridPaths): installed packs (their crops) and the bundled directory.
 */
export interface GridEnv {
  installed: readonly InstalledGrid[];
  bundledDir?: string;
}

export const NO_GRIDS: GridEnv = { installed: [] };

/**
 * The best datum to show while `d` waits for a grid download: the same
 * frame and epoch with ellipsoidal heights (no geoid grid), or null when `d`
 * already has no geoid step.
 */
export function fallbackDatum(d: ProjectDatum): ProjectDatum | null {
  return d.height === null || d.height === 'ell' ? null : { ...d, height: 'ell' };
}

/** Corrections as `receiverFrame` takes them (the active profile's frame, or none). */
export type Corrections = CorrectionFrame | null | 'none';

export type PositionResult =
  | { ok: true; plan: OutputPlan; value: ProjectedFix }
  | {
      ok: false;
      /**
       * Why there is no position. `missing-grid` (with `grids`) is "needs a
       * download" — a validated route whose grid isn't on the device yet —
       * not a refusal of the route.
       */
      refusal: Refusal;
      /** The plan, when one was made (missing grid, engine refusal); null: no route. */
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
  /** The plan's grid files → paths on this device, or the ones missing. */
  private grids: { paths: Record<string, string>; missing: string[] } = { paths: {}, missing: [] };
  private readonly cache: OffsetCache;

  constructor(
    private readonly engine: Engine,
    private readonly env: GridEnv,
  ) {
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
      const plan = this.result.ok ? this.result.out.plan : null;
      this.grids =
        plan === null
          ? { paths: {}, missing: [] }
          : gridPaths(
              plan,
              { xy: [pt.lon, pt.lat], lon: pt.lon, lat: pt.lat },
              { engine: this.engine, ...this.env },
            );
    }
    const r = this.result;
    if (!r.ok) return { ok: false, refusal: r.refusal, plan: null };
    if (this.grids.missing.length > 0) {
      return {
        ok: false,
        refusal: {
          code: 'missing-grid',
          message: 'A grid this conversion needs is not on this device',
          grids: this.grids.missing,
        },
        plan: r.out,
      };
    }
    // The pipeline with this device's grid paths, as Convert runs it.
    const out =
      r.out.plan === null
        ? r.out
        : {
            ...r.out,
            plan: { ...r.out.plan, pipeline: withGridPaths(r.out.plan.pipeline, this.grids.paths) },
          };
    const t = this.cache.apply(out, pt);
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
  private readonly fallback: Target;

  constructor(engine: Engine, env: GridEnv = NO_GRIDS) {
    this.map = new Target(engine, env);
    this.project = new Target(engine, env);
    this.fallback = new Target(engine, env);
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

  /**
   * While the project datum waits for a grid: the fix in its fallback
   * (`fallbackDatum`), or null when there is none.
   */
  inFallback(
    fix: GnssFix,
    corrections: Corrections,
    datum: ProjectDatum,
    nowMs: number,
  ): PositionResult | null {
    const d = fallbackDatum(datum);
    return d === null ? null : this.fallback.run(fix, corrections, d, nowMs);
  }
}

/** The grid files a planned route needs that are not on this device at (lon, lat). */
export function gridsMissingFor(
  out: OutputPlan,
  lon: number,
  lat: number,
  env: GridEnv,
  engine: Engine,
): string[] {
  if (out.plan === null) return [];
  return gridPaths(out.plan, { xy: [lon, lat], lon, lat }, { engine, ...env }).missing;
}

/** The grids a result is waiting for (a validated route, not on the device yet). */
export function missingGrids(r: PositionResult | null): string[] {
  return r !== null && !r.ok && r.refusal.code === 'missing-grid' ? (r.refusal.grids ?? []) : [];
}

/** Where to draw a fix: the WGS 84 position, or the receiver's own when the move was refused. */
export function drawnPosition(fix: GnssFix, r: PositionResult): { lat: number; lon: number } {
  return r.ok ? { lat: r.value.lat, lon: r.value.lon } : { lat: fix.lat, lon: fix.lon };
}
