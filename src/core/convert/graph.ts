/**
 * The Convert planner: (source system, target system, point) → ONE explicit
 * PROJ pipeline made only of validated steps (`steps.ts`), or a typed
 * refusal. PROJ's own operation choice is never used (CONVERT §4, TRAPs
 * 1–5): the frame graph below is the complete list of datum changes the app
 * will do, each edge a validated EPSG operation or NRCan/NSGI convention.
 *
 * The walk, for heights that change system:
 *   source coords → source frame (radians)
 *   → [H→h on the source height's grid frame]
 *   → frame route to the target height's grid frame (z = h)
 *   → [h→H]
 *   → frame route to the target frame (z = that height, carried)
 *   → target coordinates.
 * A height that does not change system is carried untouched; a frame change
 * that would leave an ellipsoidal height meaningless (NAD27, OSGB36…) is
 * allowed only when no ellipsoidal height is asked for.
 */
import { BOX, cdBreakBetween, distanceM, inBox, inRegion } from './regions';
import {
  canadianVGrid,
  chHelmertStep,
  csrsEpochStep,
  csrsToItrfStep,
  geocentricStep,
  na83scrsStep,
  nadcon5Step,
  ntv2CaStep,
  ntv2NationalStep,
  NTV2_CA,
  ostn15Step,
  projectionStep,
  rdFallbackStep,
  rdtransStep,
  stationOffsetStep,
  vgridStep,
  VGRIDS,
  type VGrid,
} from './steps';
import { coordSystem, FRAMES, heightSystem } from './systems';
import type {
  ConvertSpec,
  CoordSystem,
  FrameId,
  HeightSystem,
  Plan,
  PlanResult,
  Refusal,
  Region,
  SourcePoint,
  Step,
} from './types';

// ---- chart-datum stations ----------------------------------------------------------

/** A tide station's published chart-datum offsets (H_X = H_CD + CD_in_X). */
export interface CdStation {
  /** "ca-chs:03248", "us-coops:8518750". */
  key: string;
  name: string;
  /** "CHS", "NOAA CO-OPS". */
  agency: string;
  country: 'ca' | 'us';
  lon: number;
  lat: number;
  /** What the agency calls its CD ("Chart datum", "MLLW"). */
  cdName: string;
  /** CD expressed in each datum, metres, as published. */
  offsets: Partial<Record<StationDatum, number>>;
  /** How far from the gauge the offsets may be used. Default 10 km. */
  maxKm?: number;
}

export type StationDatum = 'cgvd2013' | 'cgvd28' | 'igld85' | 'navd88';

const STATION_DATUM_NAME: Record<StationDatum, string> = {
  cgvd2013: 'CGVD2013',
  cgvd28: 'CGVD28',
  igld85: 'IGLD (1985)',
  navd88: 'NAVD88',
};

export const CD_MAX_KM = 10;

export interface PlanContext {
  stations?: readonly CdStation[];
  /**
   * Re-plan after PROJ reported the point outside the rdtrans2018 grid:
   * use NSGI's datum-Helmert fallback (TRAP 8). Set by the engine only.
   */
  rdFallback?: boolean;
}

/** The height systems a station adds to the picker: its CD, plus its offsets' datums. */
export function stationHeights(st: CdStation): HeightSystem[] {
  const hub = stationHub(st);
  const out: HeightSystem[] = [];
  if (hub) {
    out.push({
      id: `cd@${st.key}`,
      kind: 'cd-station',
      name: `${st.cdName} · ${st.name}`,
      note: `${st.agency} station datum · valid near the gauge (${st.maxKm ?? CD_MAX_KM} km)`,
      frames: st.country === 'ca' ? ['csrs'] : ['nad83-2011'],
      chart: true,
      validation: stationValidation(st),
    });
  }
  for (const d of Object.keys(st.offsets) as StationDatum[]) {
    if (d === hub || st.offsets[d] === undefined) continue;
    out.push({
      id: `${d}@${st.key}`,
      kind: 'station-offset',
      name: `${STATION_DATUM_NAME[d]} (${st.agency} offset)`,
      note: `${st.name} · from the station’s published offset`,
      frames: [],
      validation: stationValidation(st),
    });
  }
  return out;
}

function stationHub(st: CdStation): StationDatum | null {
  if (st.country === 'ca') return st.offsets.cgvd2013 !== undefined ? 'cgvd2013' : null;
  return st.offsets.navd88 !== undefined ? 'navd88' : null;
}

function stationValidation(st: CdStation): string[] {
  return st.country === 'ca'
    ? ['CD-CHS-NAD83-vs-CGVD2013+CGG2013a', 'CD-CHS-BM-vs-NRCan']
    : ['CD-US-VDatum-vs-COOPS', 'US-GEOID18'];
}

interface StationRef {
  st: CdStation;
  datum: StationDatum | 'cd';
}

function parseStationHeight(id: string, ctx: PlanContext): StationRef | null {
  const at = id.indexOf('@');
  if (at < 0) return null;
  const datum = id.slice(0, at);
  const key = id.slice(at + 1);
  const st = ctx.stations?.find((s) => s.key === key);
  if (!st) return null;
  if (datum === 'cd') return { st, datum: 'cd' };
  if (datum in STATION_DATUM_NAME && st.offsets[datum as StationDatum] !== undefined) {
    return { st, datum: datum as StationDatum };
  }
  return null;
}

/** CD_in_X of a station reference (0 for the CD itself). */
function offsetOf(ref: StationRef): number {
  return ref.datum === 'cd' ? 0 : (ref.st.offsets[ref.datum] ?? NaN);
}

function datumLabel(ref: StationRef): string {
  return ref.datum === 'cd' ? ref.st.cdName : STATION_DATUM_NAME[ref.datum];
}

// ---- the frame graph -----------------------------------------------------------------

type ZState =
  | { kind: 'none' }
  | { kind: 'h' }
  | { kind: 'H'; sys: string }
  /** z no longer means anything (after a 2D datum shift of an ellipsoidal height). */
  | { kind: 'dead' };

interface Walk {
  frame: FrameId;
  epoch: number | undefined;
  z: ZState;
  steps: Step[];
  /** The ITRF Helmert evaluation epoch, passed as the 4th coordinate. */
  t?: number;
  ctx: PlanContext;
}

type EdgeKind = '2d' | 'helmert' | 'ch';
interface Edge {
  a: FrameId;
  b: FrameId;
  kind: EdgeKind;
  /** Region where the edge's grid applies (refusal when the point is elsewhere). */
  region?: Region;
}

const EDGES: readonly Edge[] = [
  { a: 'csrs', b: 'itrf2020', kind: 'helmert' },
  { a: 'csrs', b: 'itrf2014', kind: 'helmert' },
  { a: 'csrs', b: 'itrf2008', kind: 'helmert' },
  { a: 'csrs', b: 'nad27-qc', kind: '2d', region: BOX.qc },
  { a: 'csrs', b: 'nad27-on', kind: '2d', region: BOX.on },
  { a: 'csrs', b: 'nad27-sk', kind: '2d', region: BOX.sk },
  { a: 'csrs', b: 'nad27-nb', kind: '2d', region: BOX.nb },
  { a: 'csrs', b: 'nad27-bc', kind: '2d', region: BOX.bc },
  { a: 'csrs', b: 'nad83-ca', kind: '2d', region: BOX.qc },
  { a: 'nad83-ca', b: 'nad27-ca', kind: '2d', region: BOX.canada },
  { a: 'nad83-2011', b: 'nad27-us', kind: '2d', region: 'conus' },
  { a: 'nad83-2011', b: 'nad83-1986-us', kind: '2d', region: 'conus' },
  { a: 'etrs89-uk', b: 'osgb36', kind: '2d', region: BOX.gb },
  { a: 'etrs89-nl', b: 'amersfoort', kind: '2d' },
  { a: 'etrs89-ch', b: 'ch1903p', kind: 'ch', region: BOX.switzerland },
];

/** The unique path of frames from `a` to `b` (the graph is a forest), or null. */
export function framePath(a: FrameId, b: FrameId): FrameId[] | null {
  if (a === b) return [a];
  const prev = new Map<FrameId, FrameId>([[a, a]]);
  const queue: FrameId[] = [a];
  while (queue.length > 0) {
    const f = queue.shift() as FrameId;
    for (const e of EDGES) {
      const next = e.a === f ? e.b : e.b === f ? e.a : null;
      if (next === null || prev.has(next)) continue;
      prev.set(next, f);
      if (next === b) {
        const path: FrameId[] = [b];
        let cur: FrameId = b;
        while (cur !== a) {
          cur = prev.get(cur) as FrameId;
          path.unshift(cur);
        }
        return path;
      }
      queue.push(next);
    }
  }
  return null;
}

function edgeBetween(a: FrameId, b: FrameId): Edge | undefined {
  return EDGES.find((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a));
}

const ITRF: readonly FrameId[] = ['itrf2020', 'itrf2014', 'itrf2008'];
const isItrf = (f: FrameId): f is 'itrf2020' | 'itrf2014' | 'itrf2008' => ITRF.includes(f);

class RefuseError extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusal.message);
  }
}
const refuse = (code: Refusal['code'], message: string, grids?: string[]): never => {
  throw new RefuseError({ code, message, ...(grids ? { grids } : {}) });
};

function keepZ(z: ZState): boolean {
  return z.kind === 'H';
}

/** Move the walk to CSRS epoch `t` (no-op when already there). */
function toCsrsEpoch(w: Walk, t: number): void {
  if (w.frame !== 'csrs' || w.epoch === undefined) return;
  if (Math.abs(w.epoch - t) < 1e-9) return;
  w.steps.push(csrsEpochStep(w.epoch, t, keepZ(w.z)));
  w.epoch = t;
}

/** One frame-graph hop from w.frame to `next`. */
function hop(
  w: Walk,
  next: FrameId,
  point: SourcePoint,
  finalEpoch: number | undefined,
  nextIsFinal: boolean,
): void {
  const e = edgeBetween(w.frame, next);
  if (!e)
    return refuse(
      'unvalidated-pair',
      `No validated operation from ${FRAMES[w.frame].name} to ${FRAMES[next].name}`,
    );
  if (e.region && !inRegion(e.region, point.lon, point.lat)) {
    return refuse(
      'outside-region',
      `${FRAMES[e.a].name} ↔ ${FRAMES[e.b].name} only applies in its own region; this point is outside it`,
    );
  }
  const from = w.frame;
  if (e.kind === '2d') {
    // A 2D datum shift leaves z untouched: fine for an orthometric height
    // (H is the same number in either horizontal datum), meaningless for h.
    if (w.z.kind === 'h') w.z = { kind: 'dead' };
    if (from === 'csrs' || next === 'csrs') {
      const other = (from === 'csrs' ? next : from) as FrameId;
      if (other === 'nad83-ca') {
        if (from === 'csrs') toCsrsEpoch(w, 1997);
        w.steps.push(na83scrsStep(from === 'csrs'));
        w.epoch = next === 'csrs' ? 1997 : undefined;
      } else {
        const d = NTV2_CA[other as keyof typeof NTV2_CA];
        if (from === 'csrs') toCsrsEpoch(w, d.epoch);
        w.steps.push(ntv2CaStep(other as keyof typeof NTV2_CA, from === 'csrs'));
        w.epoch = next === 'csrs' ? d.epoch : undefined;
      }
    } else if (
      (from === 'nad83-ca' && next === 'nad27-ca') ||
      (from === 'nad27-ca' && next === 'nad83-ca')
    ) {
      w.steps.push(ntv2NationalStep(next === 'nad27-ca'));
    } else if (from === 'nad83-2011' || next === 'nad83-2011') {
      const old = (from === 'nad83-2011' ? next : from) as 'nad27-us' | 'nad83-1986-us';
      w.steps.push(nadcon5Step(old, from === 'nad83-2011'));
    } else if (from === 'etrs89-uk' || next === 'etrs89-uk') {
      w.steps.push(ostn15Step(next === 'osgb36'));
    } else if (from === 'etrs89-nl' || next === 'etrs89-nl') {
      if (w.ctx.rdFallback) {
        // TRAP 8: NSGI's own rule outside the rdtrans2018 grid (forward only).
        if (next !== 'amersfoort')
          return refuse(
            'outside-grid',
            'RD → ETRS89 outside the RDNAPTRANS2018 grid is not validated',
          );
        w.steps.push(rdFallbackStep());
      } else {
        w.steps.push(rdtransStep(next === 'amersfoort'));
      }
    }
    w.frame = next;
    return;
  }
  if (e.kind === 'ch') {
    // TRAP 10: the 3-parameter shift needs the real height.
    if (w.z.kind === 'none' || w.z.kind === 'dead') {
      return refuse(
        'needs-height',
        'The ETRS89 ↔ CH1903+ (LV95) shift needs the point’s height: enter it (an LN02, LHN95 or ellipsoidal height)',
      );
    }
    const carry = w.z.kind === 'H';
    w.steps.push(chHelmertStep(next === 'ch1903p', carry));
    if (!carry && next === 'ch1903p') w.z = { kind: 'dead' }; // now a Bessel h
    w.frame = next;
    return;
  }
  // csrs ↔ ITRF (TRX convention), 3D.
  if (from === 'csrs' && isItrf(next)) {
    if (w.epoch === undefined)
      return refuse('needs-epoch', 'Enter the NAD83(CSRS) coordinate epoch');
    const T = nextIsFinal ? (finalEpoch ?? w.epoch) : w.epoch;
    if (w.t !== undefined && Math.abs(w.t - T) > 1e-9)
      return refuse('unvalidated-pair', 'Two ITRF epochs in one conversion are not supported');
    w.steps.push(csrsToItrfStep(next, w.epoch, T, true, keepZ(w.z)));
    w.t = T;
    w.epoch = T;
    w.frame = next;
    return;
  }
  if (isItrf(from) && next === 'csrs') {
    if (w.epoch === undefined)
      return refuse('needs-epoch', `Enter the ${FRAMES[from].name} coordinate epoch`);
    const t = nextIsFinal ? (finalEpoch ?? w.epoch) : w.epoch;
    if (w.t !== undefined && Math.abs(w.t - w.epoch) > 1e-9)
      return refuse('unvalidated-pair', 'Two ITRF epochs in one conversion are not supported');
    w.steps.push(csrsToItrfStep(from, t, w.epoch, false, keepZ(w.z)));
    w.t = w.epoch;
    w.epoch = t;
    w.frame = next;
    return;
  }
  return refuse(
    'unvalidated-pair',
    `No validated operation from ${FRAMES[from].name} to ${FRAMES[next].name}`,
  );
}

function route(
  w: Walk,
  target: FrameId,
  point: SourcePoint,
  finalEpoch: number | undefined,
  isFinal: boolean,
): void {
  const path = framePath(w.frame, target);
  if (!path) {
    return refuse(
      'unvalidated-pair',
      `No validated conversion between ${FRAMES[w.frame].name} and ${FRAMES[target].name}`,
    );
  }
  for (let i = 1; i < path.length; i++) {
    hop(w, path[i] as FrameId, point, finalEpoch, isFinal && i === path.length - 1);
  }
}

// ---- heights -----------------------------------------------------------------------

const CA_EPOCHS = [1997, 2002, 2010] as const;

/** Which grid frame a height system is applied on, given where we are. */
function gridFrameFor(sys: HeightSystem, w: Walk, dstFrame: FrameId): FrameId {
  if (sys.frames.includes(w.frame)) return w.frame;
  if (sys.frames.includes(dstFrame)) return dstFrame;
  // EGM96 / EGM2008 from NAD83(CSRS): through ITRF2020 (TRAP 9).
  for (const f of sys.frames) if (framePath(w.frame, f)) return f;
  return refuse(
    'unvalidated-pair',
    `${sys.name} can’t be reached from ${FRAMES[w.frame].name} by a validated route`,
  );
}

/** The grid of a static height system, or of a Canadian one at the walk's epoch. */
function vgridOf(sys: HeightSystem, w: Walk): VGrid {
  if (sys.id === 'cgvd2013a' || sys.id === 'cgvd28' || sys.id === 'cgvd2013') {
    const want =
      sys.id === 'cgvd2013'
        ? 2010
        : (CA_EPOCHS as readonly number[]).includes(w.epoch ?? NaN)
          ? (w.epoch as number)
          : 2010;
    toCsrsEpoch(w, want);
    return canadianVGrid(sys.id, want as 1997 | 2002 | 2010);
  }
  const v = (VGRIDS as Record<string, VGrid>)[sys.id];
  if (!v) return refuse('unvalidated-pair', `${sys.name} has no validated grid`);
  return v;
}

function checkStation(ref: StationRef, point: SourcePoint): void {
  const max = (ref.st.maxKm ?? CD_MAX_KM) * 1000;
  const d = distanceM(point.lon, point.lat, ref.st.lon, ref.st.lat);
  if (d > max) {
    refuse(
      'cd-too-far',
      `${ref.st.name}’s chart datum is only used within ${ref.st.maxKm ?? CD_MAX_KM} km of the gauge; this point is ${(d / 1000).toFixed(1)} km away`,
    );
  }
  const brk = cdBreakBetween(point, ref.st);
  if (brk)
    refuse('cd-cross-zone', `Chart datum is never carried across the ${brk.name} datum break`);
}

/** H (in `sys`, already in its grid frame) → ellipsoidal h. */
function heightToEllipsoid(
  w: Walk,
  sysId: string,
  dstFrame: FrameId,
  point: SourcePoint,
  ctx: PlanContext,
): void {
  const st = parseStationHeight(sysId, ctx);
  if (st) {
    checkStation(st, point);
    const hub = stationHub(st.st);
    if (!hub)
      return refuse(
        'unvalidated-pair',
        `${st.st.name} publishes no ${st.st.country === 'ca' ? 'CGVD2013' : 'NAVD88'} offset`,
      );
    const dh = (st.st.offsets[hub] ?? NaN) - offsetOf(st);
    w.steps.push(
      stationOffsetStep(
        st.st.name,
        st.st.agency,
        datumLabel(st),
        STATION_DATUM_NAME[hub],
        dh,
        stationValidation(st.st),
      ),
    );
    w.z = { kind: 'H', sys: hub === 'cgvd2013' ? 'cgvd2013a' : 'navd88' };
    const hubSys = heightSystem(w.z.sys) as HeightSystem;
    route(w, hubSys.frames[0] as FrameId, point, undefined, false);
    if (hubSys.id === 'cgvd2013a') toCsrsEpoch(w, 2010);
    w.steps.push(vgridStep(vgridOf(hubSys, w), false));
    w.z = { kind: 'h' };
    return;
  }
  const sys = heightSystem(sysId);
  if (!sys) return refuse('unvalidated-pair', 'Unknown height system');
  const gf = gridFrameFor(sys, w, dstFrame);
  route(w, gf, point, undefined, false);
  // Canadian height datums are tied to an epoch: refuse a source height at
  // an epoch the grids don't define rather than guess one.
  if (sys.id === 'cgvd2013' && w.epoch !== 2010) {
    return refuse(
      'needs-epoch',
      'CGVD2013 (CGG2013) heights are defined at coordinate epoch 2010.0',
    );
  }
  if (
    (sys.id === 'cgvd2013a' || sys.id === 'cgvd28') &&
    !(CA_EPOCHS as readonly number[]).includes(w.epoch ?? NaN)
  ) {
    return refuse(
      'needs-epoch',
      `${sys.name} heights are defined at coordinate epochs 1997.0, 2002.0 or 2010.0`,
    );
  }
  w.steps.push(vgridStep(vgridOf(sys, w), false));
  w.z = { kind: 'h' };
}

/** Ellipsoidal h (current frame) → H in `sysId`. */
function ellipsoidToHeight(
  w: Walk,
  sysId: string,
  dstFrame: FrameId,
  point: SourcePoint,
  ctx: PlanContext,
): void {
  const st = parseStationHeight(sysId, ctx);
  if (st) {
    checkStation(st, point);
    const hub = stationHub(st.st);
    if (!hub)
      return refuse(
        'unvalidated-pair',
        `${st.st.name} publishes no ${st.st.country === 'ca' ? 'CGVD2013' : 'NAVD88'} offset`,
      );
    const hubSys = heightSystem(hub === 'cgvd2013' ? 'cgvd2013a' : 'navd88') as HeightSystem;
    route(w, hubSys.frames[0] as FrameId, point, undefined, false);
    if (hubSys.id === 'cgvd2013a') toCsrsEpoch(w, 2010);
    w.steps.push(vgridStep(vgridOf(hubSys, w), true));
    const dh = offsetOf(st) - (st.st.offsets[hub] ?? NaN);
    w.steps.push(
      stationOffsetStep(
        st.st.name,
        st.st.agency,
        STATION_DATUM_NAME[hub],
        datumLabel(st),
        dh,
        stationValidation(st.st),
      ),
    );
    w.z = { kind: 'H', sys: sysId };
    return;
  }
  const sys = heightSystem(sysId);
  if (!sys) return refuse('unvalidated-pair', 'Unknown height system');
  const gf = gridFrameFor(sys, w, dstFrame);
  route(w, gf, point, undefined, false);
  w.steps.push(vgridStep(vgridOf(sys, w), true));
  w.z = { kind: 'H', sys: sysId };
}

// ---- coordinates in / out --------------------------------------------------------------

function inputStep(src: CoordSystem): Step {
  if (src.kind === 'geographic') {
    return {
      name: 'Degrees → radians',
      accuracyM: 0,
      accuracySource: 'exact',
      grids: [],
      proj: ['+step +proj=unitconvert +xy_in=deg +xy_out=rad'],
      validation: [],
      gridFree: true,
    };
  }
  if (src.kind === 'geocentric') return geocentricStep(FRAMES[src.frame].ellps, true);
  return projectionStep(src.name, src.epsg, src.proj as string, true, src.validation);
}

function outputStep(dst: CoordSystem): Step {
  if (dst.kind === 'geographic') {
    return {
      name: 'Radians → degrees',
      accuracyM: 0,
      accuracySource: 'exact',
      grids: [],
      proj: ['+step +proj=unitconvert +xy_in=rad +xy_out=deg'],
      validation: [],
      gridFree: true,
    };
  }
  if (dst.kind === 'geocentric') return geocentricStep(FRAMES[dst.frame].ellps, false);
  return projectionStep(dst.name, dst.epsg, dst.proj as string, false, dst.validation);
}

/** Refuse a projected position far outside its zone (TRX and PROJ diverge by km there). */
export function checkDomain(sys: CoordSystem, lon: number, lat: number): Refusal | null {
  const d = sys.domain;
  if (!d) return null;
  if (d.lon0 !== undefined && d.maxDLon !== undefined) {
    let dl = Math.abs(lon - d.lon0);
    if (dl > 180) dl = 360 - dl;
    if (dl > d.maxDLon) {
      return {
        code: 'out-of-zone',
        message: `This point is ${dl.toFixed(1)}° from ${sys.name}’s central meridian (limit ${d.maxDLon}°): use the zone it is in`,
      };
    }
  }
  if (d.bbox && !inBox(d.bbox, lon, lat)) {
    return { code: 'out-of-zone', message: `This point is outside ${sys.name}’s area of use` };
  }
  return null;
}

/**
 * Collapse a geocentric round trip (`… +inv +proj=cart X` immediately followed
 * by `+proj=cart X`) so two 3D steps read as the validated pipeline does.
 */
function simplify(proj: string[]): string[] {
  const out: string[] = [];
  for (const s of proj) {
    const last = out[out.length - 1];
    const m = /^\+step \+inv \+proj=cart \+ellps=(\S+)$/.exec(last ?? '');
    if (m && s === `+step +proj=cart +ellps=${m[1]}`) {
      out.pop();
      continue;
    }
    out.push(s);
  }
  return out;
}

export function composePipeline(steps: readonly Step[]): string {
  return ['+proj=pipeline', ...simplify(steps.flatMap((s) => s.proj))].join(' ');
}

/** Resolve a height system id (static or a station's). */
export function resolveHeight(id: string, ctx: PlanContext = {}): HeightSystem | undefined {
  const s = heightSystem(id);
  if (s) return s;
  const ref = parseStationHeight(id, ctx);
  return ref ? stationHeights(ref.st).find((h) => h.id === id) : undefined;
}

function heightAllowedOn(sys: HeightSystem, frame: FrameId): boolean {
  if (sys.kind !== 'ellipsoidal') return true;
  // An ellipsoidal height of these frames isn't something anyone publishes.
  return ![
    'nad83-ca',
    'nad27-qc',
    'nad27-on',
    'nad27-sk',
    'nad27-nb',
    'nad27-bc',
    'nad27-ca',
    'nad83-1986-us',
    'nad27-us',
    'osgb36',
    'ch1903p',
    'amersfoort',
  ].includes(frame);
}

/**
 * Plan a conversion. Pure: no grid is opened here; the engine runs
 * `plan.pipeline` and refuses again if PROJ reports a missing grid or a
 * point outside one.
 */
export function plan(spec: ConvertSpec, point: SourcePoint, ctx: PlanContext = {}): PlanResult {
  try {
    return { ok: true, plan: planOrThrow(spec, point, ctx) };
  } catch (e) {
    if (e instanceof RefuseError) return { ok: false, refusal: e.refusal };
    throw e;
  }
}

function planOrThrow(spec: ConvertSpec, point: SourcePoint, ctx: PlanContext): Plan {
  const src = coordSystem(spec.from);
  if (!src) return refuse('unvalidated-pair', `Unknown source system ${spec.from}`);
  const sameSpot = spec.to === 'same';
  const dst = sameSpot ? src : coordSystem(spec.to);
  if (!dst) return refuse('unvalidated-pair', `Unknown target system ${spec.to}`);
  const v1 = spec.fromHeight ? resolveHeight(spec.fromHeight, ctx) : null;
  const v2 = spec.toHeight ? resolveHeight(spec.toHeight, ctx) : null;
  if (spec.fromHeight && !v1) return refuse('unvalidated-pair', 'Unknown source height system');
  if (spec.toHeight && !v2) return refuse('unvalidated-pair', 'Unknown target height system');
  if (v1 && !heightAllowedOn(v1, src.frame))
    return refuse(
      'unvalidated-pair',
      `Ellipsoidal heights aren’t used with ${FRAMES[src.frame].name}`,
    );
  if (v2 && !heightAllowedOn(v2, dst.frame))
    return refuse(
      'unvalidated-pair',
      `Ellipsoidal heights aren’t used with ${FRAMES[dst.frame].name}`,
    );
  if (sameSpot && !v2) return refuse('bad-input', 'Pick a target height system');

  const f1 = FRAMES[src.frame];
  const f2 = FRAMES[dst.frame];
  if (f1.dynamic && spec.epoch === undefined) {
    return refuse('needs-epoch', `Enter the ${f1.name} coordinate epoch (it is on the datasheet)`);
  }
  if (!inRegion(f1.region, point.lon, point.lat)) {
    return refuse(
      'outside-region',
      `This point is outside the area where ${f1.name} conversions are validated`,
    );
  }
  const srcDomain = checkDomain(src, point.lon, point.lat);
  if (srcDomain) throw new RefuseError(srcDomain);
  if (!sameSpot) {
    const dstDomain = checkDomain(dst, point.lon, point.lat);
    if (dstDomain) throw new RefuseError(dstDomain);
  }
  if (v1 && v1.region && !inRegion(v1.region, point.lon, point.lat))
    return refuse('outside-region', `${v1.name} doesn’t cover this point`);
  if (v2 && v2.region && !inRegion(v2.region, point.lon, point.lat))
    return refuse('outside-region', `${v2.name} doesn’t cover this point`);

  const finalEpoch = f2.dynamic ? (spec.toEpoch ?? spec.epoch) : undefined;
  const w: Walk = {
    frame: src.frame,
    epoch: f1.dynamic ? spec.epoch : undefined,
    z: v1
      ? v1.kind === 'ellipsoidal'
        ? { kind: 'h' }
        : { kind: 'H', sys: v1.id }
      : { kind: 'none' },
    steps: [inputStep(src)],
    ctx,
  };

  const heightChanges = !!v1 && !!v2 && v1.id !== v2.id;
  if (v2 && !v1)
    return refuse('needs-height', 'Enter a height (and its system) to get a height out');

  if (heightChanges && v1 && v2) {
    // Station ↔ station of the same gauge: one offset, no grid.
    const s1 = parseStationHeight(v1.id, ctx);
    const s2 = parseStationHeight(v2.id, ctx);
    if (s1 && s2 && s1.st.key === s2.st.key) {
      checkStation(s1, point);
      w.steps.push(
        stationOffsetStep(
          s1.st.name,
          s1.st.agency,
          datumLabel(s1),
          datumLabel(s2),
          offsetOf(s2) - offsetOf(s1),
          stationValidation(s1.st),
        ),
      );
      w.z = { kind: 'H', sys: v2.id };
    } else {
      if (v1.kind !== 'ellipsoidal') heightToEllipsoid(w, v1.id, dst.frame, point, ctx);
      if (v2.kind === 'ellipsoidal') {
        route(w, dst.frame, point, finalEpoch, true);
      } else {
        ellipsoidToHeight(w, v2.id, dst.frame, point, ctx);
      }
    }
  }
  route(w, dst.frame, point, finalEpoch, true);
  if (f2.dynamic && finalEpoch !== undefined) {
    if (dst.frame === 'csrs') toCsrsEpoch(w, finalEpoch);
    else if (w.epoch !== undefined && Math.abs(w.epoch - finalEpoch) > 1e-9) {
      return refuse(
        'unvalidated-pair',
        `${f2.name} epoch changes are only done through NAD83(CSRS)`,
      );
    }
  }
  if (v2 && (w.z.kind === 'dead' || w.z.kind === 'none')) {
    return refuse('unvalidated-pair', `An ellipsoidal height can’t be carried into ${f2.name}`);
  }
  if (v2 && v2.kind === 'ellipsoidal' && w.z.kind !== 'h') {
    return refuse('unvalidated-pair', 'No validated route gives an ellipsoidal height here');
  }
  w.steps.push(outputStep(dst));

  const steps = w.steps;
  const grids = [...new Set(steps.flatMap((s) => s.grids.map((g) => g.file)))];
  const validation = [...new Set(steps.flatMap((s) => [...s.validation]))];
  const inDim: 2 | 3 | 4 =
    w.t !== undefined
      ? 4
      : src.kind === 'geocentric' ||
          v1 ||
          w.steps.some((s) => s.proj.some((p) => /proj=(helmert|cart)/.test(p)))
        ? 3
        : 2;
  return {
    spec,
    steps,
    pipeline: composePipeline(steps),
    inDim,
    zIn: v1 ? 'height' : inDim > 2 ? 'zero' : 'none',
    zOut: v2 ? 'height' : 'none',
    ...(finalEpoch !== undefined ? { outEpoch: finalEpoch } : {}),
    ...(w.t !== undefined ? { tValue: w.t } : {}),
    gridsNeeded: grids,
    gridFree: steps.every((s) => s.gridFree),
    validation,
  };
}
