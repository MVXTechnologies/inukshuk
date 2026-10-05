/**
 * The native regression gate (CONVERT §5.5 step 3): everything the real
 * PROJ module must reproduce, as one engine-agnostic run.
 *
 * 1. Reference points: every pair of `fixtures/reference.json` with a pinned
 *    pipeline, every point (`pass` within tolerance, `fail-known` reproducing
 *    the frozen PROJ 9.8.1 value to 1e-6 m).
 * 2. Family checks: every projected zone we offer, our pipeline vs proj.db's
 *    own definition of that EPSG CRS, at a point inside the zone (≤ 0.1 mm).
 * 3. EPSG claims: every operation the panel quotes as "EPSG-stated" has that
 *    name and accuracy in the bundled proj.db.
 * 4. Round trips: every direction we offer that the agency tool did not hit
 *    (reverse NADCON5, NAD27 → CSRS, ITRF → CSRS, ETRS89 → LN02, …) inverts
 *    the validated one to 1 mm.
 *
 * The engine is batched so the host runner can stream all requests to one
 * process; on a device every call is a synchronous JSI call.
 */
import { plan } from './graph';
import { inputCoords } from './run';
import { epsgClaims } from './steps';
import {
  evaluatePoint,
  fillPipeline,
  pointInput,
  summarize,
  type PairSummary,
  type PointResult,
  type Suite,
} from './suite';
import { COORD_SYSTEMS, FRAMES } from './systems';
import type { ConvertSpec, SourcePoint } from './types';

export type SuiteRequest =
  | { kind: 'T'; pipeline: string; coords: number[]; dim: 2 | 3 | 4 }
  | { kind: 'C'; src: string; dst: string; coords: number[]; dim: 2 | 3 | 4 }
  | { kind: 'E'; code: string };

export type SuiteReply =
  | { ok: true; coords: number[] }
  | { ok: true; accuracy: number; name: string }
  | { ok: false; error: string; message: string };

export interface SuiteEngine {
  run(reqs: readonly SuiteRequest[]): Promise<SuiteReply[]>;
}

export interface CheckResult {
  kind: 'family' | 'epsg' | 'roundtrip';
  id: string;
  ok: boolean;
  detail: string;
}

export interface NativeSuiteReport {
  points: PointResult[];
  pairs: PairSummary[];
  checks: CheckResult[];
  totals: { pass: number; known: number; fail: number; skip: number; checksFailed: number };
  ok: boolean;
}

const FAMILY_TOL_M = 1e-4;
const ROUNDTRIP_TOL_M = 0.001;

/** Pairs judged on data alone (no PROJ op): CHS sums, VDatum / BathyElli model values. */
function dataResult(
  pair: Suite['pairs'][number],
  pt: Suite['pairs'][number]['points'][number],
): number[] | null {
  if (pair.compute === 'sum_inputs') return [pt.input.reduce<number>((a, x) => a + (x ?? 0), 0)];
  if (pair.compute === 'model_value' && pt.model !== undefined) return [pt.model];
  return null;
}

function pointsPart(suite: Suite): {
  reqs: SuiteRequest[];
  finish: (r: SuiteReply[]) => PointResult[];
} {
  const reqs: SuiteRequest[] = [];
  const slots: {
    pair: Suite['pairs'][number];
    pt: Suite['pairs'][number]['points'][number];
    i: number | null;
  }[] = [];
  for (const pair of suite.pairs) {
    for (const pt of pair.points) {
      if (!pair.pipeline) {
        slots.push({ pair, pt, i: null });
        continue;
      }
      const { coords, dim } = pointInput(pt);
      slots.push({ pair, pt, i: reqs.length });
      reqs.push({ kind: 'T', pipeline: fillPipeline(pair.pipeline, pt.params), coords, dim });
    }
  }
  return {
    reqs,
    finish: (replies) =>
      slots.map(({ pair, pt, i }) => {
        if (i === null) return evaluatePoint(pair, pt, dataResult(pair, pt));
        const r = replies[i];
        if (!r || !r.ok || !('coords' in r))
          return evaluatePoint(
            pair,
            pt,
            null,
            r && !r.ok ? `${r.error}: ${r.message}` : 'no reply',
          );
        return evaluatePoint(pair, pt, r.coords);
      }),
  };
}

/** A point inside a projected system's domain, for the family check. */
function domainPoint(sys: (typeof COORD_SYSTEMS)[number]): [number, number] | null {
  const d = sys.domain;
  if (!d) return null;
  if (d.bbox) return [(d.bbox[0] + d.bbox[2]) / 2, (d.bbox[1] + d.bbox[3]) / 2];
  if (d.lon0 === undefined) return null;
  const region = FRAMES[sys.frame].region;
  const lat = region === 'conus' ? 40 : Math.min(Math.max(48, region[1] + 1), region[3] - 1);
  const south = sys.proj?.includes('+south');
  return [d.lon0 + 0.7, south ? -35 : lat];
}

function familyPart(): { reqs: SuiteRequest[]; finish: (r: SuiteReply[]) => CheckResult[] } {
  const reqs: SuiteRequest[] = [];
  const meta: { id: string }[] = [];
  for (const sys of COORD_SYSTEMS) {
    if (sys.kind !== 'projected' || sys.epsg === undefined || !sys.proj) continue;
    const p = domainPoint(sys);
    if (!p) continue;
    meta.push({ id: `${sys.id} = EPSG:${sys.epsg}` });
    reqs.push({
      kind: 'T',
      pipeline: `+proj=pipeline +step +proj=unitconvert +xy_in=deg +xy_out=rad +step ${sys.proj}`,
      coords: p,
      dim: 2,
    });
    reqs.push({ kind: 'C', src: 'BASE', dst: `EPSG:${sys.epsg}`, coords: p, dim: 2 });
  }
  return {
    reqs,
    finish: (replies) =>
      meta.map((m, k) => {
        const a = replies[2 * k];
        const b = replies[2 * k + 1];
        if (!a?.ok || !b?.ok || !('coords' in a) || !('coords' in b)) {
          return {
            kind: 'family',
            id: m.id,
            ok: false,
            detail: `engine error: ${JSON.stringify(a)} / ${JSON.stringify(b)}`,
          };
        }
        const d = Math.hypot(
          (a.coords[0] ?? NaN) - (b.coords[0] ?? NaN),
          (a.coords[1] ?? NaN) - (b.coords[1] ?? NaN),
        );
        return {
          kind: 'family',
          id: m.id,
          ok: d <= FAMILY_TOL_M,
          detail: `Δ ${(d * 1000).toFixed(4)} mm`,
        };
      }),
  };
}

function epsgPart(): { reqs: SuiteRequest[]; finish: (r: SuiteReply[]) => CheckResult[] } {
  const claims = epsgClaims();
  const uniq = [...new Map(claims.map((c) => [`${c.code}`, c])).values()];
  return {
    reqs: uniq.map((c) => ({ kind: 'E', code: c.code })),
    finish: (replies) =>
      uniq.map((c, i) => {
        const r = replies[i];
        if (!r || !r.ok || !('name' in r))
          return { kind: 'epsg', id: `EPSG:${c.code}`, ok: false, detail: 'not in proj.db' };
        const accOk =
          c.accuracyM === null ? r.accuracy < 0 : Math.abs(r.accuracy - c.accuracyM) < 1e-9;
        const nameOk = c.name.includes(r.name) || r.name.includes(c.name);
        return {
          kind: 'epsg',
          id: `EPSG:${c.code}`,
          ok: accOk && nameOk,
          detail: `proj.db: “${r.name}” ${r.accuracy} m; claimed “${c.name}” ${c.accuracyM} m`,
        };
      }),
  };
}

interface Trip {
  id: string;
  fwd: ConvertSpec;
  back: ConvertSpec;
  pt: SourcePoint;
  /** Output of fwd is geographic (lon/lat) → compare in metres. */
  geo: boolean;
}

const qc = (lon: number, lat: number, h = 0): SourcePoint => ({ xy: [lon, lat], h, lon, lat });

/** Directions offered beyond what the agency tools hit, each inverted by a validated one. */
export const ROUND_TRIPS: readonly Trip[] = [
  {
    id: 'CSRS → NAD27 (QC) → CSRS',
    fwd: { from: 'csrs:geo', fromHeight: null, to: 'nad27-qc:geo', toHeight: null, epoch: 1997 },
    back: { from: 'nad27-qc:geo', fromHeight: null, to: 'csrs:geo', toHeight: null, toEpoch: 1997 },
    pt: qc(-71.2386, 46.8512),
    geo: true,
  },
  {
    id: 'CSRS → NAD27 (ON) → CSRS',
    fwd: { from: 'csrs:geo', fromHeight: null, to: 'nad27-on:geo', toHeight: null, epoch: 1997 },
    back: { from: 'nad27-on:geo', fromHeight: null, to: 'csrs:geo', toHeight: null, toEpoch: 1997 },
    pt: qc(-79.61, 43.73),
    geo: true,
  },
  {
    id: 'CSRS → NAD27 (SK) → CSRS',
    fwd: { from: 'csrs:geo', fromHeight: null, to: 'nad27-sk:geo', toHeight: null, epoch: 1997 },
    back: { from: 'nad27-sk:geo', fromHeight: null, to: 'csrs:geo', toHeight: null, toEpoch: 1997 },
    pt: qc(-106.6, 52.1),
    geo: true,
  },
  {
    id: 'CSRS → NAD27 (NB) → CSRS',
    fwd: { from: 'csrs:geo', fromHeight: null, to: 'nad27-nb:geo', toHeight: null, epoch: 1997 },
    back: { from: 'nad27-nb:geo', fromHeight: null, to: 'csrs:geo', toHeight: null, toEpoch: 1997 },
    pt: qc(-66.11, 45.3),
    geo: true,
  },
  {
    id: 'CSRS → NAD27 (BC) → CSRS',
    fwd: { from: 'csrs:geo', fromHeight: null, to: 'nad27-bc:geo', toHeight: null, epoch: 2002 },
    back: { from: 'nad27-bc:geo', fromHeight: null, to: 'csrs:geo', toHeight: null, toEpoch: 2002 },
    pt: qc(-123.1, 49.25),
    geo: true,
  },
  {
    id: 'CSRS → NAD83 → NAD27 (national) → back',
    fwd: { from: 'csrs:geo', fromHeight: null, to: 'nad27-ca:geo', toHeight: null, epoch: 1997 },
    back: { from: 'nad27-ca:geo', fromHeight: null, to: 'csrs:geo', toHeight: null, toEpoch: 1997 },
    pt: qc(-71.2386, 46.8512),
    geo: true,
  },
  {
    id: 'CSRS 2010 → ITRF2020 @ 2026.75 → back',
    fwd: {
      from: 'csrs:geo',
      fromHeight: 'ell',
      to: 'itrf2020:geo',
      toHeight: 'ell',
      epoch: 2010,
      toEpoch: 2026.75,
    },
    back: {
      from: 'itrf2020:geo',
      fromHeight: 'ell',
      to: 'csrs:geo',
      toHeight: 'ell',
      epoch: 2026.75,
      toEpoch: 2010,
    },
    pt: qc(-71.2386, 46.8512, 30),
    geo: true,
  },
  {
    id: 'CSRS 1997 → 2010 → 1997',
    fwd: {
      from: 'csrs:geo',
      fromHeight: 'ell',
      to: 'csrs:geo',
      toHeight: 'ell',
      epoch: 1997,
      toEpoch: 2010,
    },
    back: {
      from: 'csrs:geo',
      fromHeight: 'ell',
      to: 'csrs:geo',
      toHeight: 'ell',
      epoch: 2010,
      toEpoch: 1997,
    },
    pt: qc(-123.1, 49.25, 50),
    geo: true,
  },
  {
    id: 'h → NAVD88 → h',
    fwd: { from: 'nad83-2011:geo', fromHeight: 'ell', to: 'nad83-2011:geo', toHeight: 'navd88' },
    back: { from: 'nad83-2011:geo', fromHeight: 'navd88', to: 'nad83-2011:geo', toHeight: 'ell' },
    pt: qc(-122.34, 47.6, -18.79),
    geo: true,
  },
  {
    id: 'h → CGVD2013a(1997) → h',
    fwd: {
      from: 'csrs:geo',
      fromHeight: 'ell',
      to: 'csrs:geo',
      toHeight: 'cgvd2013a',
      epoch: 1997,
    },
    back: {
      from: 'csrs:geo',
      fromHeight: 'cgvd2013a',
      to: 'csrs:geo',
      toHeight: 'ell',
      epoch: 1997,
    },
    pt: qc(-71.2386, 46.8512, -3.127),
    geo: true,
  },
  {
    id: 'h → CGVD28 (1997) → h',
    fwd: { from: 'csrs:geo', fromHeight: 'ell', to: 'csrs:geo', toHeight: 'cgvd28', epoch: 1997 },
    back: { from: 'csrs:geo', fromHeight: 'cgvd28', to: 'csrs:geo', toHeight: 'ell', epoch: 1997 },
    pt: qc(-71.2386, 46.8512, -3.127),
    geo: true,
  },
  {
    id: 'h → EGM96 → h',
    fwd: { from: 'wgs84:geo', fromHeight: 'ell', to: 'wgs84:geo', toHeight: 'egm96' },
    back: { from: 'wgs84:geo', fromHeight: 'egm96', to: 'wgs84:geo', toHeight: 'ell' },
    pt: qc(-71.2386, 46.8512, 10),
    geo: true,
  },
  {
    id: 'ETRS89 → LN02 → ETRS89',
    fwd: { from: 'etrs89-ch:geo', fromHeight: 'ell', to: 'etrs89-ch:geo', toHeight: 'ln02' },
    back: { from: 'etrs89-ch:geo', fromHeight: 'ln02', to: 'etrs89-ch:geo', toHeight: 'ell' },
    pt: qc(7.4653, 46.8771, 947.149),
    geo: true,
  },
  {
    id: 'ETRS89 → NGF-IGN69 → ETRS89',
    fwd: { from: 'rgf93v2b:geo', fromHeight: 'ell', to: 'rgf93v2b:geo', toHeight: 'ngf-ign69' },
    back: { from: 'rgf93v2b:geo', fromHeight: 'ngf-ign69', to: 'rgf93v2b:geo', toHeight: 'ell' },
    pt: qc(1.481, 43.5567, 194.778),
    geo: true,
  },
  {
    id: 'ETRS89 → NN2000 → ETRS89',
    fwd: { from: 'euref89-no:geo', fromHeight: 'ell', to: 'euref89-no:geo', toHeight: 'nn2000' },
    back: { from: 'euref89-no:geo', fromHeight: 'nn2000', to: 'euref89-no:geo', toHeight: 'ell' },
    pt: qc(10.74, 59.91, 40),
    geo: true,
  },
  {
    id: 'Belfast → ETRS89 → Belfast',
    fwd: { from: 'etrs89-uk:geo', fromHeight: 'ell', to: 'etrs89-uk:geo', toHeight: 'belfast' },
    back: { from: 'etrs89-uk:geo', fromHeight: 'belfast', to: 'etrs89-uk:geo', toHeight: 'ell' },
    pt: qc(-5.93, 54.6, 100),
    geo: true,
  },
];

function tripPart(): {
  reqs: SuiteRequest[];
  finish: (r: SuiteReply[]) => Promise<CheckResult[]>;
  second: (r: SuiteReply[]) => SuiteRequest[];
} {
  const plans = ROUND_TRIPS.map((t) => ({
    t,
    a: plan(t.fwd, t.pt),
    b: null as ReturnType<typeof plan> | null,
  }));
  const reqs: SuiteRequest[] = plans.map(({ a, t }) =>
    a.ok
      ? {
          kind: 'T',
          pipeline: a.plan.pipeline,
          coords: inputCoords(a.plan, t.pt),
          dim: a.plan.inDim,
        }
      : { kind: 'E', code: '__refused__' },
  );
  let pending: { idx: number; fwdOut: number[] }[] = [];
  return {
    reqs,
    second: (replies) => {
      const out: SuiteRequest[] = [];
      pending = [];
      plans.forEach((p, i) => {
        const r = replies[i];
        if (!p.a.ok || !r?.ok || !('coords' in r)) return;
        const fwdOut = r.coords;
        const back: SourcePoint = {
          xy: fwdOut.slice(0, 2),
          h: fwdOut[2] ?? 0,
          lon: fwdOut[0] ?? 0,
          lat: fwdOut[1] ?? 0,
        };
        p.b = plan(p.t.back, back);
        if (!p.b.ok) return;
        pending.push({ idx: i, fwdOut });
        out.push({
          kind: 'T',
          pipeline: p.b.plan.pipeline,
          coords: inputCoords(p.b.plan, back),
          dim: p.b.plan.inDim,
        });
      });
      return out;
    },
    finish: async (replies2) =>
      plans.map((p, i) => {
        if (!p.a.ok)
          return {
            kind: 'roundtrip',
            id: p.t.id,
            ok: false,
            detail: `forward refused: ${p.a.refusal.message}`,
          };
        if (p.b && !p.b.ok)
          return {
            kind: 'roundtrip',
            id: p.t.id,
            ok: false,
            detail: `back refused: ${p.b.refusal.message}`,
          };
        const k = pending.findIndex((x) => x.idx === i);
        const r = k >= 0 ? replies2[k] : undefined;
        if (!r || !r.ok || !('coords' in r))
          return {
            kind: 'roundtrip',
            id: p.t.id,
            ok: false,
            detail: `engine: ${JSON.stringify(r)}`,
          };
        const lat = p.t.pt.lat;
        const mPerDegLat = 111132.954;
        const mPerDegLon = mPerDegLat * Math.cos((lat * Math.PI) / 180);
        const dx = ((r.coords[0] ?? NaN) - (p.t.pt.xy[0] ?? NaN)) * mPerDegLon;
        const dy = ((r.coords[1] ?? NaN) - (p.t.pt.xy[1] ?? NaN)) * mPerDegLat;
        const hBack =
          p.b && p.b.ok && p.b.plan.zOut === 'height' ? (r.coords[2] ?? NaN) - (p.t.pt.h ?? 0) : 0;
        const d = Math.max(Math.hypot(dx, dy), Math.abs(hBack));
        return {
          kind: 'roundtrip',
          id: p.t.id,
          ok: d <= ROUNDTRIP_TOL_M,
          detail: `Δ ${(d * 1000).toFixed(3)} mm`,
        };
      }),
  };
}

/**
 * Run the whole gate on an engine. `suite` is `fixtures/reference.json`
 * (passed in, so the app bundle never carries it: the device run reads it
 * from the file `scripts/convert-native-suite.sh` pushes).
 */
export async function runNativeSuite(
  engine: SuiteEngine,
  suite: Suite,
): Promise<NativeSuiteReport> {
  const pts = pointsPart(suite);
  const fam = familyPart();
  const eps = epsgPart();
  const trip = tripPart();
  const first = [...pts.reqs, ...fam.reqs, ...eps.reqs, ...trip.reqs];
  const r1 = await engine.run(first);
  let o = 0;
  const take = (n: number) => {
    const s = r1.slice(o, o + n);
    o += n;
    return s;
  };
  const points = pts.finish(take(pts.reqs.length));
  const famChecks = fam.finish(take(fam.reqs.length));
  const epsChecks = eps.finish(take(eps.reqs.length));
  const tripFirst = take(trip.reqs.length);
  const r2 = await engine.run(trip.second(tripFirst));
  const tripChecks = await trip.finish(r2);
  const checks = [...famChecks, ...epsChecks, ...tripChecks];
  const pairs = summarize(suite.pairs, points);
  const totals = {
    pass: points.filter((p) => p.verdict === 'pass').length,
    known: points.filter((p) => p.verdict === 'known-reproduced').length,
    fail: points.filter((p) => p.verdict === 'FAIL').length,
    skip: points.filter((p) => p.verdict === 'skip').length,
    checksFailed: checks.filter((c) => !c.ok).length,
  };
  return { points, pairs, checks, totals, ok: totals.fail === 0 && totals.checksFailed === 0 };
}

/** A compact text report (the self-test screen and the scripts print it). */
export function formatReport(r: NativeSuiteReport, header: string): string {
  const lines = [
    header,
    `points: pass ${r.totals.pass} · known-gap reproduced ${r.totals.known} · FAIL ${r.totals.fail} · skipped ${r.totals.skip}`,
    `checks: ${r.checks.length - r.totals.checksFailed}/${r.checks.length} ok`,
  ];
  for (const p of r.points.filter((x) => x.verdict === 'FAIL'))
    lines.push(
      `FAIL ${p.pair} ${p.point} ${p.error ?? ''} H=${p.delta.horizontalM} V=${p.delta.verticalM} repro=${p.reproM ?? ''}`,
    );
  for (const c of r.checks.filter((x) => !x.ok))
    lines.push(`CHECK FAIL ${c.kind} ${c.id}: ${c.detail}`);
  lines.push(r.ok ? 'RESULT: PASS' : 'RESULT: FAIL');
  return lines.join('\n');
}
