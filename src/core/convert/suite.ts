/**
 * The official-tool reference suite (`fixtures/reference.json`, frozen by
 * `scripts/convert-fixtures.py` from the Phase-1 study) and its comparison
 * rules — a line-for-line port of `run_validation.py`, so Jest, the host
 * runner and the on-device self-test all judge a result the same way:
 *
 * - `pass` points: |result − agency value| within the pair's tolerance
 *   (horizontal in metres on GRS80, vertical in metres);
 * - `fail-known` points (a diagnosed disagreement with the agency): the
 *   result must reproduce the frozen PROJ value to 1e-6 m — a PROJ or grid
 *   update that moves a known gap fails as well;
 * - `informational` points are skipped.
 */
import { num } from './steps';

export type CompareKind =
  'lon' | 'lat' | 'x' | 'y' | 'x_ftus' | 'y_ftus' | 'h' | 'cx' | 'cy' | 'cz' | 'none';

export interface SuitePoint {
  id: string;
  input: (number | null)[];
  expected: (number | null)[];
  status: 'pass' | 'fail-known' | 'informational' | 'FAIL' | 'ERROR' | null;
  source: { tool?: string; version?: string; date?: string };
  params?: Record<string, number>;
  /** The PROJ 9.8.1 result frozen by the study. */
  proj?: number[];
  /** compute = model_value: the value under test (no PROJ op). */
  model?: number;
}

export interface SuitePair {
  id: string;
  title: string;
  status: string | null;
  group: string | null;
  pipeline: string | null;
  compute: 'sum_inputs' | 'model_value' | null;
  epsg: string[];
  io: { input: string[]; output: string[] };
  compare: CompareKind[];
  tol: { h: number | null; v: number | null };
  known: { points: 'all' | string[] | null; diagnosis: string | null } | null;
  points: SuitePoint[];
}

export interface Suite {
  _meta: Record<string, unknown>;
  pairs: SuitePair[];
}

const A = 6378137.0;
const F = 1 / 298.257222101;
const E2 = F * (2 - F);
const FTUS = 1200 / 3937;
/** fail-known points must reproduce the frozen PROJ value this closely (metres). */
export const KNOWN_REPRO_M = 1e-6;

/** Fill `{dt}`-style placeholders with the point's params (same number format as graph.ts). */
export function fillPipeline(template: string, params?: Record<string, number>): string {
  if (!params) return template;
  let out = template;
  for (const [k, v] of Object.entries(params)) out = out.split(`{${k}}`).join(num(v));
  return out;
}

function scale(lat: number): [number, number] {
  const s = Math.sin((lat * Math.PI) / 180);
  const w = Math.sqrt(1 - E2 * s * s);
  const M = (A * (1 - E2)) / w ** 3;
  const N = A / w;
  return [M, N * Math.cos((lat * Math.PI) / 180)];
}

export interface Delta {
  horizontalM: number | null;
  verticalM: number | null;
}

export function deltas(
  kinds: readonly CompareKind[],
  got: readonly number[],
  exp: readonly (number | null)[],
  refLat: number,
): Delta {
  const hz: number[] = [];
  const vt: number[] = [];
  const cc: number[] = [];
  kinds.forEach((k, i) => {
    const e = exp[i];
    const g = got[i];
    if (k === 'none' || e === null || e === undefined || g === undefined) return;
    const d = g - e;
    if (k === 'lon') hz.push(((d * Math.PI) / 180) * scale(refLat)[1]);
    else if (k === 'lat') hz.push(((d * Math.PI) / 180) * scale(refLat)[0]);
    else if (k === 'x' || k === 'y') hz.push(d);
    else if (k === 'x_ftus' || k === 'y_ftus') hz.push(d * FTUS);
    else if (k === 'h') vt.push(d);
    else cc.push(Math.abs(d));
  });
  const horizontalM = hz.length
    ? Math.sqrt(hz.reduce((a, x) => a + x * x, 0))
    : cc.length
      ? Math.max(...cc)
      : null;
  const verticalM = vt.length ? Math.abs(vt[0] as number) : null;
  return { horizontalM, verticalM };
}

export function withinTolerance(d: Delta, tol: { h: number | null; v: number | null }): boolean {
  let good = true;
  if (d.horizontalM !== null && tol.h !== null) good = good && d.horizontalM <= tol.h + 1e-12;
  if (d.verticalM !== null && tol.v !== null) good = good && d.verticalM <= tol.v + 1e-12;
  return good;
}

export function refLatOf(pair: SuitePair, pt: SuitePoint): number {
  const i = pair.compare.indexOf('lat');
  if (i >= 0) {
    const e = pt.expected[i];
    if (typeof e === 'number') return e;
  }
  if (
    pair.io.input[0] === 'lon_deg' &&
    pair.io.input[1] === 'lat_deg' &&
    typeof pt.input[1] === 'number'
  )
    return pt.input[1];
  return 45;
}

export type Verdict = 'pass' | 'known-reproduced' | 'FAIL' | 'skip';

export interface PointResult {
  pair: string;
  point: string;
  verdict: Verdict;
  /** vs the agency value. */
  delta: Delta;
  /** fail-known: vs the frozen PROJ value. */
  reproM?: number;
  got?: number[];
  error?: string;
}

/** Judge one engine result for one reference point. */
export function evaluatePoint(
  pair: SuitePair,
  pt: SuitePoint,
  got: readonly number[] | null,
  error?: string,
): PointResult {
  const base = { pair: pair.id, point: pt.id };
  if (pt.status === 'informational')
    return { ...base, verdict: 'skip', delta: { horizontalM: null, verticalM: null } };
  if (!got || got.some((x) => !Number.isFinite(x))) {
    return {
      ...base,
      verdict: 'FAIL',
      delta: { horizontalM: null, verticalM: null },
      error: error ?? 'no result',
    };
  }
  const refLat = refLatOf(pair, pt);
  const delta = deltas(pair.compare, got, pt.expected, refLat);
  if (pt.status === 'fail-known') {
    // Must reproduce the frozen PROJ result (the agency value is documentation).
    const frozen = pt.proj ?? [];
    const d = deltas(pair.compare, got, frozen, refLat);
    const repro = Math.max(d.horizontalM ?? 0, d.verticalM ?? 0);
    return {
      ...base,
      verdict: repro <= KNOWN_REPRO_M ? 'known-reproduced' : 'FAIL',
      delta,
      reproM: repro,
      got: [...got],
    };
  }
  return {
    ...base,
    verdict: withinTolerance(delta, pair.tol) ? 'pass' : 'FAIL',
    delta,
    got: [...got],
  };
}

/** The coordinates one point feeds the engine (pyproj convention: 2D → z 0; t only when given). */
export function pointInput(pt: SuitePoint): { coords: number[]; dim: 2 | 3 | 4 } {
  const v = pt.input.map((x) => (x === null ? 0 : x));
  const dim = Math.min(4, Math.max(2, v.length)) as 2 | 3 | 4;
  return { coords: v.slice(0, dim), dim };
}

export interface PairSummary {
  pair: string;
  title: string;
  status: string | null;
  n: number;
  pass: number;
  known: number;
  fail: number;
  skip: number;
  maxH: number | null;
  maxV: number | null;
  tool: string;
}

export function summarize(
  pairs: readonly SuitePair[],
  results: readonly PointResult[],
): PairSummary[] {
  return pairs.map((p) => {
    const rs = results.filter((r) => r.pair === p.id);
    const maxOf = (k: 'horizontalM' | 'verticalM') => {
      const xs = rs.map((r) => r.delta[k]).filter((x): x is number => x !== null);
      return xs.length ? Math.max(...xs) : null;
    };
    const tools = [...new Set(p.points.map((q) => q.source.tool).filter(Boolean))];
    return {
      pair: p.id,
      title: p.title,
      status: p.status,
      n: rs.length,
      pass: rs.filter((r) => r.verdict === 'pass').length,
      known: rs.filter((r) => r.verdict === 'known-reproduced').length,
      fail: rs.filter((r) => r.verdict === 'FAIL').length,
      skip: rs.filter((r) => r.verdict === 'skip').length,
      maxH: maxOf('horizontalM'),
      maxV: maxOf('verticalM'),
      tool: tools.join('; '),
    };
  });
}
