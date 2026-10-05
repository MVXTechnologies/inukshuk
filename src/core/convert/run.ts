/**
 * Running a plan, engine-agnostic: how its input coordinates are laid out,
 * how its output is read, and the result the screen shows. The engine itself
 * (native PROJ or `lite.ts`) is injected, so this is pure and shared by the
 * app, Jest, the host runner and the on-device suite.
 */
import type { Plan, Refusal, SourcePoint } from './types';

/** One engine call: run `pipeline` on n points × dim. */
export interface EngineRequest {
  pipeline: string;
  coords: number[];
  dim: 2 | 3 | 4;
}

export type EngineReply =
  | { ok: true; coords: number[]; ballpark?: boolean; gridsUsed?: string[] }
  | { ok: false; error: string; message: string; grids?: string[] };

export interface Engine {
  /** 'native' = PROJ module; 'lite' = proj4js, grid-free only. */
  kind: 'native' | 'lite';
  transform(req: EngineRequest): EngineReply;
}

/** The pipeline's input for one point: [x, y, (z), (t)]. */
export function inputCoords(plan: Plan, pt: SourcePoint): number[] {
  const out = [pt.xy[0] ?? NaN, pt.xy[1] ?? NaN];
  if (plan.inDim >= 3) out.push(pt.xy.length >= 3 ? (pt.xy[2] ?? NaN) : (pt.h ?? 0));
  if (plan.inDim === 4) out.push(plan.tValue ?? NaN);
  return out;
}

export interface Converted {
  /** Output coordinates: [lon, lat] / [E, N] / [X, Y, Z]. */
  xy: number[];
  /** Output height (when the plan has one). */
  h?: number;
}

export type RunResult = { ok: true; value: Converted } | { ok: false; refusal: Refusal };

/** Map an engine failure to a refusal the panel can show. */
export function engineRefusal(reply: Extract<EngineReply, { ok: false }>): Refusal {
  switch (reply.error) {
    case 'missing-grid':
      return {
        code: 'missing-grid',
        message: 'A grid this conversion needs is not on this device',
        ...(reply.grids ? { grids: reply.grids } : {}),
      };
    case 'point-failed':
      return {
        code: 'outside-grid',
        message: 'This point is outside a grid the conversion needs (no value there)',
      };
    case 'lite-unsupported':
      return { code: 'lite-unsupported', message: reply.message };
    default:
      return { code: 'engine-error', message: reply.message || reply.error };
  }
}

/**
 * Run one plan on one point. Refuses on any engine error, a non-finite value,
 * a ballpark flag or a grid PROJ did not actually use.
 */
export function runPlan(
  engine: Engine,
  plan: Plan,
  pt: SourcePoint,
  geocentricOut: boolean,
): RunResult {
  if (engine.kind === 'lite' && !plan.gridFree) {
    return {
      ok: false,
      refusal: {
        code: 'lite-unsupported',
        message:
          'This conversion needs the PROJ engine of the current app version: update the app from the store',
      },
    };
  }
  const reply = engine.transform({
    pipeline: plan.pipeline,
    coords: inputCoords(plan, pt),
    dim: plan.inDim,
  });
  if (!reply.ok) return { ok: false, refusal: engineRefusal(reply) };
  if (reply.ballpark)
    return {
      ok: false,
      refusal: { code: 'ballpark', message: 'PROJ reported a ballpark operation: refused' },
    };
  if (reply.gridsUsed) {
    const missing = plan.gridsNeeded.filter((g) => !reply.gridsUsed?.includes(g));
    if (missing.length > 0)
      return {
        ok: false,
        refusal: { code: 'missing-grid', message: 'A grid was not used', grids: missing },
      };
  }
  const c = reply.coords;
  if (c.some((x) => !Number.isFinite(x)))
    return { ok: false, refusal: { code: 'outside-grid', message: 'No value at this point' } };
  const xy = geocentricOut ? c.slice(0, 3) : c.slice(0, 2);
  return {
    ok: true,
    value: { xy, ...(plan.zOut === 'height' && c[2] !== undefined ? { h: c[2] } : {}) },
  };
}
