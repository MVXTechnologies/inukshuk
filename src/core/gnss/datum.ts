/**
 * Output coordinates of a fix in the user's project datum (owner decision
 * A4, 2026-10-06: a user-chosen project datum, default WGS 84).
 *
 * A fix is in the frame of whatever corrected it (GNSS.md §4.3):
 * - autonomous / SBAS → the broadcast frame, WGS 84;
 * - DGPS / RTK from a correction profile → that profile's frame and epoch
 *   (NAD83(CSRS) 1997.0 for Québec's MRNF network, ITRF2014 at the current
 *   epoch for Polaris…); unknown → WGS 84 with ⚠ "frame unknown" (A5).
 *
 * Every datum change is planned by Convert (`@core/convert/graph`), which
 * emits only operations validated against the agencies' own tools, and is
 * run by an injected `Engine` (native PROJ on the phone). This module adds
 * exactly one thing Convert deliberately does not do (HIDDEN_SYSTEMS: "WGS 84
 * (G2296) ↔ NAD83(CSRS) / ITRF — use ITRF2020 at an epoch"): it takes the
 * WGS 84 of a GNSS fix to BE ITRF2020 at the observation epoch, and says so as
 * an explicit step carrying the EPSG ensemble accuracy of WGS 84 (2 m).
 *
 * Every output carries its method, steps, stated accuracy and validation
 * pairs; anything outside a validated route is refused with Convert's reason.
 */
import { combinedAccuracy } from '../convert/accuracy';
import { plan as planConvert, resolveHeight, type PlanContext } from '../convert/graph';
import { runPlan, type Engine } from '../convert/run';
import { FRAMES } from '../convert/systems';
import type { FrameId, Plan, Refusal, Step } from '../convert/types';
import { frameLabel, type CorrectionFrame, type EpochSpec } from './casters';
import { usesCorrections, type FixKind } from './quality';

export interface ProjectDatum {
  frame: FrameId;
  /** Dynamic frames: a fixed epoch (1997, 2010…) or the observation epoch. */
  epoch?: EpochSpec;
  /** Convert height-system id ('ell', 'cgvd2013a', 'navd88', 'egm2008'…), or null for 2D. */
  height: string | null;
}

export const DEFAULT_PROJECT_DATUM: ProjectDatum = { frame: 'wgs84', height: 'ell' };

export interface ReceiverFrame {
  frame: FrameId;
  epoch: EpochSpec | null;
  /** No correction frame was declared: WGS 84 assumed, show ⚠ "frame unknown". */
  frameUnknown: boolean;
  basis: 'broadcast' | 'corrections' | 'assumed';
}

/**
 * The frame a fix's coordinates are in.
 *
 * `corrections`: the active correction profile's frame; null when the profile
 * declares none (RTK2go, a radio base of unknown setup); 'none' when no
 * correction source is configured (a DGPS fix is then SBAS: broadcast frame).
 */
export function receiverFrame(
  kind: FixKind,
  corrections: CorrectionFrame | null | 'none',
): ReceiverFrame {
  const broadcast: ReceiverFrame = {
    frame: 'wgs84',
    epoch: null,
    frameUnknown: false,
    basis: 'broadcast',
  };
  if (!usesCorrections(kind)) return broadcast;
  if (corrections === 'none') {
    // RTK without a profile = corrections the receiver manages (radio, its own NTRIP): unknown.
    return kind === 'dgps' ? broadcast : { ...broadcast, frameUnknown: true, basis: 'assumed' };
  }
  if (corrections === null) return { ...broadcast, frameUnknown: true, basis: 'assumed' };
  return {
    frame: corrections.frame,
    epoch: FRAMES[corrections.frame].dynamic ? (corrections.epoch ?? null) : null,
    frameUnknown: false,
    basis: 'corrections',
  };
}

/** UTC ms → decimal year (coordinate epoch), exact to the millisecond across leap years. */
export function decimalYear(ms: number): number {
  const y = new Date(ms).getUTCFullYear();
  const a = Date.UTC(y, 0, 1);
  const b = Date.UTC(y + 1, 0, 1);
  return y + (ms - a) / (b - a);
}

/** EPSG datum ensemble "World Geodetic System 1984 ensemble" (EPSG:6326): ensemble accuracy 2.0 m. */
export const WGS84_ENSEMBLE_M = 2.0;

const ITRF: readonly FrameId[] = ['itrf2020', 'itrf2014', 'itrf2008'];

function ensembleStep(from: string, to: string, t: number): Step {
  return {
    name: `${from} taken as ${to} at ${t.toFixed(2)} (null transformation)`,
    accuracyM: WGS84_ENSEMBLE_M,
    accuracySource: 'EPSG:6326 datum ensemble accuracy (WGS 84 realizations G730…G2296)',
    grids: [],
    proj: [],
    validation: [],
    note: 'WGS 84 is aligned to ITRF; this identity is a modelling choice, not a validated conversion',
    flag: 'amber',
    epochIn: t,
    epochOut: t,
    gridFree: true,
  };
}

export interface FixPoint {
  lat: number;
  lon: number;
  /** Ellipsoidal height in the receiver frame, metres. */
  hEll: number | null;
  /** UTC ms of the observation. */
  timeMs: number;
}

export interface OutputPlan {
  receiver: ReceiverFrame;
  project: ProjectDatum;
  observationEpoch: number;
  /** The Convert plan PROJ runs; null = the coordinates pass through unchanged. */
  plan: Plan | null;
  /** Every step, in order, including the WGS 84 ≡ ITRF2020 identity when used. */
  steps: Step[];
  /** Root-sum-square of the steps' stated accuracies, metres; null if one is unstated. */
  datumAccuracyM: number | null;
  /** One line: "NAD83(CSRS) 1997.0 → ITRF2020 @ 2026.76 → WGS 84". */
  method: string;
  /** Reference-suite pairs (official tools) behind the steps. */
  validation: string[];
  frameUnknown: boolean;
  /** "WGS 84", "NAD83(CSRS) 2010.0", "ITRF2020 @ 2026.76". */
  outputLabel: string;
  /** The output height system id, or null (no height: 2D fix or 2D project). */
  height: string | null;
}

export type OutputPlanResult = { ok: true; out: OutputPlan } | { ok: false; refusal: Refusal };

function resolveEpoch(e: EpochSpec | null | undefined, obs: number): number | undefined {
  if (e === null || e === undefined) return undefined;
  return e === 'observation' ? obs : e;
}

function label(frame: FrameId, epoch: number | undefined): string {
  const f = FRAMES[frame];
  if (!f.dynamic || epoch === undefined) return f.name;
  return `${f.name} ${Number.isInteger(epoch) ? epoch.toFixed(1) : `@ ${epoch.toFixed(2)}`}`;
}

const sameEpoch = (a: number | undefined, b: number | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && Math.abs(a - b) < 1e-9);

/**
 * Plan the conversion of fixes from `receiver` into `project`. Pure; the
 * same plan serves every fix of the same frame, epoch-day and area.
 */
export function planFixOutput(
  pt: FixPoint,
  receiver: ReceiverFrame,
  project: ProjectDatum,
  ctx: PlanContext = {},
): OutputPlanResult {
  const obs = decimalYear(pt.timeMs);
  const refuse = (code: Refusal['code'], message: string): OutputPlanResult => ({
    ok: false,
    refusal: { code, message },
  });
  if (
    !Number.isFinite(pt.lat) ||
    !Number.isFinite(pt.lon) ||
    Math.abs(pt.lat) > 90 ||
    Math.abs(pt.lon) > 180
  )
    return refuse('bad-input', 'The fix has no valid position');
  const dst = FRAMES[project.frame];
  if (dst.dynamic && project.epoch === undefined)
    return refuse('needs-epoch', `Choose the ${dst.name} epoch of the project datum`);
  if (FRAMES[receiver.frame].dynamic && receiver.epoch === null)
    return refuse(
      'needs-epoch',
      `Enter the ${FRAMES[receiver.frame].name} epoch of the corrections`,
    );
  const heightSys = project.height === null ? null : resolveHeight(project.height, ctx);
  if (heightSys === undefined) return refuse('unvalidated-pair', 'Unknown project height system');

  let srcFrame = receiver.frame;
  let srcEpoch = resolveEpoch(receiver.epoch, obs);
  let dstFrame = project.frame;
  let dstEpoch = resolveEpoch(project.epoch, obs);
  const pre: Step[] = [];
  const post: Step[] = [];
  const srcLabel = label(srcFrame, srcEpoch);

  if (srcFrame === 'wgs84' && dstFrame !== 'wgs84') {
    pre.push(ensembleStep('WGS 84', 'ITRF2020', obs));
    srcFrame = 'itrf2020';
    srcEpoch = obs;
  } else if (dstFrame === 'wgs84' && srcFrame !== 'wgs84') {
    if (ITRF.includes(srcFrame) && sameEpoch(srcEpoch, obs)) {
      pre.push(ensembleStep(FRAMES[srcFrame].name, 'WGS 84', obs));
      srcFrame = 'wgs84';
      srcEpoch = undefined;
    } else {
      dstFrame = 'itrf2020';
      dstEpoch = obs;
      post.push(ensembleStep('ITRF2020', 'WGS 84', obs));
    }
  }

  const hEll = pt.hEll;
  const hIn = hEll !== null;
  const outHeight = hIn ? project.height : null;
  const needsPlan =
    srcFrame !== dstFrame ||
    !sameEpoch(srcEpoch, dstEpoch) ||
    (outHeight !== null && outHeight !== 'ell');
  let p: Plan | null = null;
  if (needsPlan) {
    const r = planConvert(
      {
        from: `${srcFrame}:geo`,
        fromHeight: hIn ? 'ell' : null,
        to: `${dstFrame}:geo`,
        toHeight: outHeight,
        ...(srcEpoch !== undefined ? { epoch: srcEpoch } : {}),
        ...(dstEpoch !== undefined ? { toEpoch: dstEpoch } : {}),
      },
      { xy: [pt.lon, pt.lat], ...(hEll !== null ? { h: hEll } : {}), lon: pt.lon, lat: pt.lat },
      ctx,
    );
    if (!r.ok) return { ok: false, refusal: r.refusal };
    p = r.plan;
  }
  const steps = [...pre, ...(p?.steps ?? []), ...post];
  const outputLabel = label(project.frame, resolveEpoch(project.epoch, obs));
  const hops = [srcLabel];
  if (pre.length > 0 && srcFrame !== 'wgs84') hops.push(label(srcFrame, srcEpoch));
  if (post.length > 0) hops.push(label(dstFrame, dstEpoch));
  if (hops[hops.length - 1] !== outputLabel) hops.push(outputLabel);
  const heightPart =
    hIn && heightSys && heightSys.kind !== 'ellipsoidal' ? ` · h → ${heightSys.name}` : '';
  return {
    ok: true,
    out: {
      receiver,
      project,
      observationEpoch: obs,
      plan: p,
      steps,
      datumAccuracyM: combinedAccuracy(steps),
      method: hops.join(' → ') + heightPart,
      validation: p?.validation ?? [],
      frameUnknown: receiver.frameUnknown,
      outputLabel,
      height: outHeight,
    },
  };
}

export interface ProjectedFix {
  lat: number;
  lon: number;
  /** In `out.height`'s system; null when no height. */
  h: number | null;
}

export type TransformResult = { ok: true; value: ProjectedFix } | { ok: false; refusal: Refusal };

/** Run an output plan on one fix through the engine (native PROJ). */
export function transformFix(engine: Engine, out: OutputPlan, pt: FixPoint): TransformResult {
  if (!out.plan) {
    return {
      ok: true,
      value: { lat: pt.lat, lon: pt.lon, h: out.height === null ? null : pt.hEll },
    };
  }
  const r = runPlan(
    engine,
    out.plan,
    { xy: [pt.lon, pt.lat], ...(pt.hEll !== null ? { h: pt.hEll } : {}), lon: pt.lon, lat: pt.lat },
    false,
  );
  if (!r.ok) return r;
  const lon = Number(r.value.xy[0]);
  const lat = Number(r.value.xy[1]);
  // A 2D fix through a 3D plan (z = 0 in): the horizontal is right, the height means nothing.
  const h = out.height === null || pt.hEll === null ? null : (r.value.h ?? null);
  return { ok: true, value: { lat, lon, h } };
}

/**
 * Per-fix cost of one addition instead of one PROJ call (GNSS.md §4.3.3):
 * the datum shift varies by millimetres per kilometre, so the offset of one
 * engine call is reused within `radiusM` and the same observation day.
 */
export class OffsetCache {
  private key = '';
  private ref: { lat: number; lon: number; dLat: number; dLon: number; dH: number | null } | null =
    null;

  constructor(
    private readonly engine: Engine,
    readonly radiusM = 1000,
  ) {}

  apply(out: OutputPlan, pt: FixPoint): TransformResult {
    if (!out.plan) return transformFix(this.engine, out, pt);
    const key = `${out.plan.pipeline}|${out.height}|${Math.floor(out.observationEpoch * 365.25)}`;
    const r = this.ref;
    const near =
      r !== null &&
      key === this.key &&
      (r.dH === null) === (pt.hEll === null || out.height === null) &&
      approxDistanceM(r.lat, r.lon, pt.lat, pt.lon) <= this.radiusM;
    if (!near) {
      const t = transformFix(this.engine, out, pt);
      if (!t.ok) return t;
      this.key = key;
      this.ref = {
        lat: pt.lat,
        lon: pt.lon,
        dLat: t.value.lat - pt.lat,
        dLon: t.value.lon - pt.lon,
        dH: t.value.h === null || pt.hEll === null ? null : t.value.h - pt.hEll,
      };
      return t;
    }
    const ref = r as NonNullable<typeof r>;
    return {
      ok: true,
      value: {
        lat: pt.lat + ref.dLat,
        lon: pt.lon + ref.dLon,
        h: ref.dH === null || pt.hEll === null ? null : pt.hEll + ref.dH,
      },
    };
  }
}

function approxDistanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const k = 111_320;
  const dx = (lon2 - lon1) * k * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  const dy = (lat2 - lat1) * k;
  return Math.hypot(dx, dy);
}

/** The correction frame label for the status line ("NAD83(CSRS) 1997.0", "WGS 84 ⚠ frame unknown"). */
export function receiverFrameLabel(r: ReceiverFrame): string {
  if (r.frameUnknown) return 'WGS 84 · ⚠ frame unknown';
  return frameLabel({ frame: r.frame, ...(r.epoch !== null ? { epoch: r.epoch } : {}) });
}
