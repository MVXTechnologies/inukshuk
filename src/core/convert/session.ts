/**
 * One Convert evaluation, end to end and pure (the engine and the grid
 * lookup are injected): parse the typed fields → plan → find every grid on
 * the device (the crop covering the point) → run → accuracy panel → the rows
 * the screen shows and "Copy all" copies.
 */
import { buildPanel, refusalPanel, type AccuracyPanel } from './accuracy';
import {
  formatAngle,
  formatHeight,
  formatMetres,
  parseAngle,
  parseEpoch,
  parseMetres,
  type AngleFormat,
} from './format';
import { plan as makePlan, resolveHeight, type PlanContext } from './graph';
import { BUNDLED_GRIDS, gridByFile } from './grids';
import { compileLite } from './lite';
import { resolveGrid, withGridPaths, type InstalledGrid } from './packs';
import type { ConvertRequest } from './prefill';
import { runPlan, type Engine } from './run';
import { coordSystem, FRAMES } from './systems';
import type { Plan, Refusal, SourcePoint, Step } from './types';

export interface ResultRow {
  key: 'lat' | 'lon' | 'e' | 'n' | 'x' | 'y' | 'z' | 'h' | 'h2';
  label: string;
  value: string;
  /** Under the value: datum, published comparison… */
  note?: string;
  /** What the row's copy button copies. */
  copy: string;
}

export interface Evaluation {
  status: 'empty' | 'input-error' | 'refused' | 'ok';
  /** Field-level input problems: field → message. */
  inputErrors?: Partial<Record<'a' | 'b' | 'c' | 'h' | 'epoch' | 'toEpoch', string>>;
  refusal?: Refusal;
  plan?: Plan;
  rows: ResultRow[];
  panel?: AccuracyPanel;
  /** The raw output (swap fills the source with it). */
  output?: { xy: number[]; h?: number };
  /** Target position in lon/lat for "Show on map" (≈, for display). */
  mapPoint?: { lon: number; lat: number };
  copyAll: string;
  /** Precision of the input, metres. */
  inputPrecisionM?: number;
  sourcePoint?: SourcePoint;
}

export interface EvalEnv {
  engine: Engine;
  /** Files of every installed pack (crops). */
  installed: readonly InstalledGrid[];
  /** Absolute directory of the bundled grids (native), if known. */
  bundledDir?: string;
  angleFormat?: AngleFormat;
}

const empty = (status: Evaluation['status'], extra: Partial<Evaluation> = {}): Evaluation => ({
  status,
  rows: [],
  copyAll: '',
  ...extra,
});

/** Parse the request's typed fields into a source point (lon/lat found through lite for projected input). */
export function parseSource(
  req: ConvertRequest,
): { point: SourcePoint; precisionM: number } | { errors: NonNullable<Evaluation['inputErrors']> } {
  const sys = coordSystem(req.spec.from);
  const errors: NonNullable<Evaluation['inputErrors']> = {};
  if (!sys) return { errors: { a: 'Unknown system' } };
  let xy: number[] = [];
  let lon = NaN;
  let lat = NaN;
  let precisionM = 0;
  if (sys.kind === 'geographic') {
    const la = parseAngle(req.a, 'lat');
    const lo = parseAngle(req.b, 'lon');
    if (!la) errors.a = 'Not a latitude';
    if (!lo) errors.b = 'Not a longitude';
    if (la && lo) {
      lon = lo.value;
      lat = la.value;
      xy = [lon, lat];
      precisionM = Math.max(la.precisionM, lo.precisionM);
    }
  } else {
    const a = parseMetres(req.a);
    const b = parseMetres(req.b);
    const c = sys.kind === 'geocentric' ? parseMetres(req.c ?? '') : null;
    if (!a) errors.a = 'Not a number';
    if (!b) errors.b = 'Not a number';
    if (sys.kind === 'geocentric' && !c) errors.c = 'Not a number';
    if (a && b && (sys.kind !== 'geocentric' || c)) {
      xy = c ? [a.value, b.value, c.value] : [a.value, b.value];
      precisionM = Math.max(a.precisionM, b.precisionM, c?.precisionM ?? 0);
      // Back to lon/lat with the grid-free inverse (regions, zones, packs).
      const inv =
        sys.kind === 'geocentric'
          ? `+proj=pipeline +step +inv +proj=cart +ellps=${FRAMES[sys.frame].ellps} +step +proj=unitconvert +xy_in=rad +xy_out=deg`
          : `+proj=pipeline +step +inv ${sys.proj} +step +proj=unitconvert +xy_in=rad +xy_out=deg`;
      const ops = compileLite(inv);
      if (ops) {
        let p = [...xy];
        for (const op of ops) p = op(p);
        lon = p[0] ?? NaN;
        lat = p[1] ?? NaN;
      }
      if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90)
        errors.a = 'These coordinates are not in this system’s range';
    }
  }
  let h: number | undefined;
  if (req.spec.fromHeight) {
    const hv = parseMetres(req.h ?? '');
    if (!hv) errors.h = 'Enter the height';
    else h = hv.value;
  }
  if (Object.keys(errors).length > 0) return { errors };
  return { point: { xy, ...(h !== undefined ? { h } : {}), lon, lat }, precisionM };
}

/** Grid file → absolute path of the copy covering the point (bundled, else the right crop). */
export function gridPaths(
  plan: Plan,
  pt: SourcePoint,
  env: EvalEnv,
): { paths: Record<string, string>; missing: string[] } {
  const paths: Record<string, string> = {};
  const missing: string[] = [];
  for (const g of plan.gridsNeeded) {
    if (BUNDLED_GRIDS.includes(g)) {
      if (env.bundledDir) paths[g] = `${env.bundledDir}/${g}`;
      continue;
    }
    const hit = resolveGrid(env.installed, g, pt.lon, pt.lat);
    if (hit) paths[g] = hit.path;
    else missing.push(g);
  }
  return { paths, missing };
}

function epochShiftStep(steps: readonly Step[]): Step | undefined {
  return steps.find(
    (s) =>
      s.grids.some((g) => g.file === 'ca_nrc_NAD83v70VG.tif') &&
      s.epochIn !== undefined &&
      s.epochOut !== undefined,
  );
}

/** How far the velocity grid moves the point (horizontal, m), for the TRAP 7 amber rule. */
function measureEpochShift(
  plan: Plan,
  pt: SourcePoint,
  env: EvalEnv,
  paths: Record<string, string>,
): number | undefined {
  const s = epochShiftStep(plan.steps);
  if (!s || s.epochIn === undefined || s.epochOut === undefined || !Number.isFinite(pt.lon))
    return undefined;
  const dt = s.epochOut - s.epochIn;
  const grid = paths['ca_nrc_NAD83v70VG.tif'] ?? 'ca_nrc_NAD83v70VG.tif';
  const pipeline = `+proj=pipeline +step +proj=unitconvert +xy_in=deg +xy_out=rad +step +proj=cart +ellps=GRS80 +step +proj=deformation +dt=${dt} +grids=${grid} +ellps=GRS80 +step +inv +proj=cart +ellps=GRS80 +step +proj=unitconvert +xy_in=rad +xy_out=deg`;
  const r = env.engine.transform({ pipeline, coords: [pt.lon, pt.lat, 0], dim: 3 });
  if (!r.ok) return undefined;
  const dLon = ((r.coords[0] ?? NaN) - pt.lon) * 111320 * Math.cos((pt.lat * Math.PI) / 180);
  const dLat = ((r.coords[1] ?? NaN) - pt.lat) * 110574;
  return Math.hypot(dLon, dLat);
}

/** The target height's label: "CGVD2013a(1997)", "NAVD88 (GEOID18)", "h, NAD83(CSRS) 1997.0". */
export function heightLabel(plan: Plan, ctx: PlanContext): string {
  const id = plan.spec.toHeight;
  if (!id) return '';
  if (id === 'ell') {
    const dst = plan.spec.to === 'same' ? coordSystem(plan.spec.from) : coordSystem(plan.spec.to);
    const f = dst ? FRAMES[dst.frame] : undefined;
    return `ellipsoidal h, ${f?.name ?? ''}${plan.outEpoch !== undefined ? ` ${plan.outEpoch.toFixed(1)}` : ''}`;
  }
  const v = [...plan.steps]
    .reverse()
    .find((s) => s.grids.some((g) => /CGG2013a/.test(g.label)) && !s.name.startsWith('Inverse'));
  if (id === 'cgvd2013a' && v?.epsgOp) {
    const epoch = v.epsgOp === '10111' ? '1997' : v.epsgOp === '10110' ? '2002' : '2010';
    return `CGVD2013a(${epoch})`;
  }
  return resolveHeight(id, ctx)?.name ?? id;
}

function frameLabel(plan: Plan): string {
  const dst = plan.spec.to === 'same' ? coordSystem(plan.spec.from) : coordSystem(plan.spec.to);
  if (!dst) return '';
  const f = FRAMES[dst.frame];
  const sys = dst.kind === 'geographic' ? 'geographic' : dst.name;
  return `${f.name} / ${sys}${plan.outEpoch !== undefined ? ` · epoch ${plan.outEpoch.toFixed(2)}` : ''}`;
}

export function evaluate(req: ConvertRequest, env: EvalEnv): Evaluation {
  if (req.a.trim() === '' && req.b.trim() === '') return empty('empty');
  const parsed = parseSource(req);
  if ('errors' in parsed) return empty('input-error', { inputErrors: parsed.errors });
  const epoch =
    req.epoch !== undefined && req.epoch.trim() !== '' ? parseEpoch(req.epoch) : undefined;
  const toEpoch =
    req.toEpoch !== undefined && req.toEpoch.trim() !== '' ? parseEpoch(req.toEpoch) : undefined;
  if (epoch === null)
    return empty('input-error', { inputErrors: { epoch: 'A decimal year, e.g. 1997.0' } });
  if (toEpoch === null)
    return empty('input-error', { inputErrors: { toEpoch: 'A decimal year, e.g. 2010.0' } });
  const spec = { ...req.spec };
  if (epoch !== undefined) spec.epoch = epoch;
  else delete spec.epoch;
  if (toEpoch !== undefined) spec.toEpoch = toEpoch;
  else delete spec.toEpoch;
  const ctx: PlanContext = { stations: req.stations ?? [] };
  const pt = parsed.point;
  const refused = (refusal: Refusal, plan?: Plan): Evaluation => ({
    status: 'refused',
    refusal,
    ...(plan ? { plan } : {}),
    rows: [],
    panel: refusalPanel(refusal),
    copyAll: `Refused: ${refusal.message}`,
    inputPrecisionM: parsed.precisionM,
    sourcePoint: pt,
  });

  let p = makePlan(spec, pt, ctx);
  if (!p.ok) return refused(p.refusal);
  let { paths, missing } = gridPaths(p.plan, pt, env);
  if (missing.length > 0) {
    const names = missing.map((m) => gridByFile(m)?.label ?? m).join(', ');
    return refused(
      {
        code: 'missing-grid',
        message: `Needs ${names}: download the grid pack for this area`,
        grids: missing,
      },
      p.plan,
    );
  }
  const dstSys = spec.to === 'same' ? coordSystem(spec.from) : coordSystem(spec.to);
  const geocentricOut = dstSys?.kind === 'geocentric';
  let run = runPlan(
    env.engine,
    { ...p.plan, pipeline: withGridPaths(p.plan.pipeline, paths) },
    pt,
    geocentricOut,
  );
  // TRAP 8: outside the RDNAPTRANS2018 grid, NSGI's own fallback.
  if (
    !run.ok &&
    run.refusal.code === 'outside-grid' &&
    p.plan.pipeline.includes('nl_nsgi_rdtrans2018.tif')
  ) {
    const q = makePlan(spec, pt, { ...ctx, rdFallback: true });
    if (q.ok) {
      p = q;
      ({ paths, missing } = gridPaths(q.plan, pt, env));
      if (missing.length === 0)
        run = runPlan(
          env.engine,
          { ...q.plan, pipeline: withGridPaths(q.plan.pipeline, paths) },
          pt,
          geocentricOut,
        );
    }
  }
  const plan = p.plan;
  if (!run.ok) return refused(run.refusal, plan);

  const epochShiftM =
    env.engine.kind === 'native' ? measureEpochShift(plan, pt, env, paths) : undefined;
  const panel = buildPanel(plan, {
    inputPrecisionM: parsed.precisionM,
    ...(req.approxPosition ? { approxSource: req.approxPosition } : {}),
    available: (f) => BUNDLED_GRIDS.includes(f) || !!paths[f],
    ...(epochShiftM !== undefined ? { epochShiftM } : {}),
  });

  const rows: ResultRow[] = [];
  const v = run.value;
  const fmt = env.angleFormat ?? 'dd';
  const fl = frameLabel(plan);
  let mapPoint: Evaluation['mapPoint'];
  if (spec.to !== 'same' && dstSys) {
    if (dstSys.kind === 'geographic') {
      const [lon = NaN, lat = NaN] = v.xy;
      const la = formatAngle(lat, 'lat', fmt);
      const lo = formatAngle(lon, 'lon', fmt);
      rows.push({ key: 'lat', label: 'Latitude', value: la, copy: `${la} (${fl})` });
      rows.push({ key: 'lon', label: 'Longitude', value: lo, copy: `${lo} (${fl})` });
      mapPoint = { lon, lat };
    } else if (dstSys.kind === 'projected') {
      const [e = NaN, n = NaN] = v.xy;
      rows.push({
        key: 'e',
        label: 'Easting',
        value: `${formatMetres(e)} m`,
        copy: `E ${e.toFixed(3)} m (${fl})`,
      });
      rows.push({
        key: 'n',
        label: 'Northing',
        value: `${formatMetres(n)} m`,
        copy: `N ${n.toFixed(3)} m (${fl})`,
      });
    } else {
      const [x = NaN, y = NaN, z = NaN] = v.xy;
      rows.push({
        key: 'x',
        label: 'X',
        value: `${formatMetres(x)} m`,
        copy: `X ${x.toFixed(3)} m (${fl})`,
      });
      rows.push({
        key: 'y',
        label: 'Y',
        value: `${formatMetres(y)} m`,
        copy: `Y ${y.toFixed(3)} m (${fl})`,
      });
      rows.push({
        key: 'z',
        label: 'Z',
        value: `${formatMetres(z)} m`,
        copy: `Z ${z.toFixed(3)} m (${fl})`,
      });
    }
  }
  if (v.h !== undefined) {
    const label = heightLabel(plan, ctx);
    const published = req.published?.find((x) => x.heightId === spec.toHeight);
    const note = [label, published ? `published ${published.text}` : null]
      .filter(Boolean)
      .join(' · ');
    rows.push({
      key: 'h',
      label: 'Height',
      value: formatHeight(v.h),
      note,
      copy: `${v.h.toFixed(3)} m ${label}`,
    });
  }
  // A chart-datum source: also show the ellipsoidal height (mockup 09).
  const fromChart = spec.fromHeight?.startsWith('cd@');
  if (fromChart && spec.toHeight !== 'ell') {
    const e2 = makePlan({ ...spec, toHeight: 'ell', to: spec.to }, pt, ctx);
    if (e2.ok) {
      const g2 = gridPaths(e2.plan, pt, env);
      if (g2.missing.length === 0) {
        const r2 = runPlan(
          env.engine,
          { ...e2.plan, pipeline: withGridPaths(e2.plan.pipeline, g2.paths) },
          pt,
          false,
        );
        if (r2.ok && r2.value.h !== undefined) {
          const l2 = heightLabel(e2.plan, ctx);
          rows.push({
            key: 'h2',
            label: 'Ellipsoid',
            value: formatHeight(r2.value.h),
            note: l2,
            copy: `${r2.value.h.toFixed(3)} m ${l2}`,
          });
        }
      }
    }
  }
  if (!mapPoint && Number.isFinite(pt.lon)) mapPoint = { lon: pt.lon, lat: pt.lat };

  const copyAll = [
    req.origin?.label ?? 'Inukshuk Convert',
    `From: ${coordSystem(spec.from) ? `${FRAMES[coordSystem(spec.from)?.frame ?? 'wgs84'].name} / ${coordSystem(spec.from)?.name}` : spec.from}${spec.epoch !== undefined ? ` · epoch ${spec.epoch}` : ''} — ${req.a}, ${req.b}${req.h ? `, h ${req.h} m (${resolveHeight(spec.fromHeight ?? '', ctx)?.name ?? ''})` : ''}`,
    `To: ${fl}`,
    ...rows.map((r) => `${r.label}: ${r.copy}`),
    ...panel.copyLines,
    'Inukshuk · not for navigation',
  ].join('\n');

  return {
    status: 'ok',
    plan,
    rows,
    panel,
    output: v,
    ...(mapPoint ? { mapPoint } : {}),
    copyAll,
    inputPrecisionM: parsed.precisionM,
    sourcePoint: pt,
  };
}
