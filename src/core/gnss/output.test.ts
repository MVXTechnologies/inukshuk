import { liteEngine } from '../convert/lite';
import type { Engine } from '../convert/run';
import {
  drawnPosition,
  fallbackDatum,
  FixOutputs,
  gridsMissingFor,
  MAP_DATUM,
  missingGrids,
  NO_GRIDS,
  REPLAN_KM,
} from './output';
import { projectDatumOption } from './projectDatum';
import { fixOf } from './testUtils';

const NOW = Date.UTC(2026, 9, 7, 12);
const MRNF = { frame: 'csrs' as const, epoch: 1997 };

/**
 * A stand-in for native PROJ (Jest has none; `lite` refuses time-dependent
 * Helmerts): a fixed shift of ≈ 1.5 m, counting its calls. The real numbers
 * are gated by `datumVectors.test.ts` against TRX / GPS·H / NCAT.
 */
function counting(): Engine & { calls: number } {
  const e = {
    kind: 'native' as const,
    calls: 0,
    transform(req: Parameters<Engine['transform']>[0]) {
      e.calls += 1;
      const d = [0.000012, 0.000008, -0.5];
      return {
        ok: true as const,
        coords: req.coords.slice(0, req.dim).map((v, i) => v + (d[i] ?? 0)),
      };
    },
  };
  return e;
}

describe('FixOutputs', () => {
  it('an autonomous fix is WGS 84 already: drawn as received, no engine call', () => {
    const engine = counting();
    const o = new FixOutputs(engine);
    const fix = fixOf('autonomous', { timeMs: NOW });
    const r = o.onMap(fix, 'none', NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.plan).toBeNull();
    expect(r.value).toEqual({ lat: fix.lat, lon: fix.lon, h: null });
    expect(engine.calls).toBe(0);
    expect(drawnPosition(fix, r)).toEqual({ lat: fix.lat, lon: fix.lon });
  });

  it('MRNF RTK (NAD83(CSRS) 1997.0) is moved to WGS 84 with its method and accuracy', () => {
    const engine = counting();
    const o = new FixOutputs(engine);
    const fix = fixOf('rtk-fixed', { timeMs: NOW });
    const r = o.onMap(fix, MRNF, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.method).toBe('NAD83(CSRS) 1997.0 → ITRF2020 @ 2026.77 → WGS 84');
    expect(r.plan.datumAccuracyM).toBeGreaterThan(2);
    // ≈ 1.5 m in Québec between NAD83(CSRS) 1997.0 and today's ITRF.
    const moved = Math.hypot(
      (r.value.lat - fix.lat) * 111_320,
      (r.value.lon - fix.lon) * 111_320 * Math.cos((fix.lat * Math.PI) / 180),
    );
    expect(moved).toBeGreaterThan(1);
    expect(moved).toBeLessThan(2);
    // The next fixes nearby reuse the offset (one engine call).
    o.onMap(fixOf('rtk-fixed', { timeMs: NOW, lat: fix.lat + 0.0001 }), MRNF, NOW);
    expect(engine.calls).toBe(1);
  });

  it('re-plans after REPLAN_KM of travel or a new day, and keeps the frame label', () => {
    const o = new FixOutputs(counting());
    const a = o.onMap(fixOf('rtk-fixed', { timeMs: NOW }), MRNF, NOW);
    const far = o.onMap(
      fixOf('rtk-fixed', { timeMs: NOW, lat: 46.8 + (REPLAN_KM + 1) / 111 }),
      MRNF,
      NOW,
    );
    const east = o.onMap(
      fixOf('rtk-fixed', { timeMs: NOW, lat: 46.8 + (REPLAN_KM + 1) / 111, lon: -71.0 }),
      MRNF,
      NOW,
    );
    const tomorrow = o.onMap(fixOf('rtk-fixed', { timeMs: NOW + 86_400_000 }), MRNF, NOW);
    for (const r of [a, far, east, tomorrow]) expect(r.ok).toBe(true);
  });

  it('a fix without a date is planned at its arrival time', () => {
    const o = new FixOutputs(counting());
    const r = o.onMap(fixOf('rtk-fixed', { timeMs: null }), MRNF, NOW);
    expect(r.ok && r.plan.observationEpoch).toBeCloseTo(2026.77, 2);
  });

  it('an unvalidated route is refused: drawn where the receiver put it, Convert says why', () => {
    const o = new FixOutputs(liteEngine);
    const fix = fixOf('rtk-fixed', { timeMs: NOW, lat: 39.7, lon: -105 });
    const r = o.onMap(fix, { frame: 'nad83-2011' }, NOW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.plan).toBeNull();
    expect(r.refusal.code).toBe('unvalidated-pair');
    expect(drawnPosition(fix, r)).toEqual({ lat: 39.7, lon: -105 });
  });

  it('an engine refusal keeps the plan (the sheet shows what was tried)', () => {
    const broken: Engine = {
      kind: 'lite',
      transform: () => ({ ok: false, error: 'lite-unsupported', message: 'needs PROJ' }),
    };
    const r = new FixOutputs(broken).onMap(fixOf('rtk-fixed', { timeMs: NOW }), MRNF, NOW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.plan?.method).toContain('NAD83(CSRS) 1997.0');
    expect(r.refusal.message).toMatch(/PROJ/);
  });

  it('project datum: NAD83(CSRS) 2010.0 + CGVD2013 from MRNF RTK', () => {
    const o = new FixOutputs(liteEngine);
    const datum = projectDatumOption('csrs-1997').datum;
    const r = o.inProject(fixOf('rtk-fixed', { timeMs: NOW }), MRNF, datum, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Same frame and epoch: nothing to do, exact.
    expect(r.plan.datumAccuracyM).toBe(0);
    expect(r.value.h).toBe(20);
    expect(MAP_DATUM).toEqual({ frame: 'wgs84', height: null });
  });
});

describe('grids: needs a download, not a refusal', () => {
  const datum = projectDatumOption('csrs-2010-cgvd2013').datum;
  const fix = fixOf('rtk-fixed', { timeMs: NOW });

  it('a validated route whose geoid grid is not on the device: missing-grid, with its plan', () => {
    const o = new FixOutputs(counting());
    const r = o.inProject(fix, MRNF, datum, NOW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal.code).toBe('missing-grid');
    expect(r.plan?.method).toContain('CGVD2013');
    const grids = missingGrids(r);
    expect(grids.length).toBeGreaterThan(0);
    expect(r.plan && gridsMissingFor(r.plan, fix.lon, fix.lat, NO_GRIDS, liteEngine)).toEqual(
      grids,
    );
    // Meanwhile: the same frame and epoch, ellipsoidal heights, no grid needed.
    const f = o.inFallback(fix, MRNF, datum, NOW);
    expect(f?.ok).toBe(true);
    if (!f?.ok) return;
    expect(f.plan.outputLabel).toBe('NAD83(CSRS) 2010.0');
    expect(f.plan.height).toBe('ell');
  });

  it('once installed, the engine runs the pipeline with this device’s grid paths', () => {
    const probe = new FixOutputs(liteEngine).inProject(fix, MRNF, datum, NOW);
    const grids = missingGrids(probe);
    const engine = counting();
    const seen: string[] = [];
    const spy: Engine = {
      kind: 'native',
      transform: (req) => {
        seen.push(req.pipeline);
        return engine.transform(req);
      },
    };
    const env = {
      installed: grids.map((name) => ({ pack: 'qc', name, path: `/grids/${name}`, crop: null })),
    };
    const r = new FixOutputs(spy, env).inProject(fix, MRNF, datum, NOW);
    expect(r.ok).toBe(true);
    for (const g of grids) expect(seen[0]).toContain(`/grids/${g}`);
    expect(missingGrids(r)).toEqual([]);
  });

  it('fallbacks exist only for datums with a geoid step', () => {
    expect(fallbackDatum({ frame: 'wgs84', height: 'ell' })).toBeNull();
    expect(fallbackDatum({ frame: 'wgs84', height: null })).toBeNull();
    expect(fallbackDatum({ frame: 'csrs', epoch: 2010, height: 'cgvd2013a' })).toEqual({
      frame: 'csrs',
      epoch: 2010,
      height: 'ell',
    });
    expect(new FixOutputs(liteEngine).inFallback(fix, MRNF, MAP_DATUM, NOW)).toBeNull();
    const asIs = new FixOutputs(liteEngine).onMap(
      fixOf('autonomous', { timeMs: NOW }),
      'none',
      NOW,
    );
    expect(asIs.ok && gridsMissingFor(asIs.plan, 0, 0, NO_GRIDS, liteEngine)).toEqual([]);
    expect(missingGrids(null)).toEqual([]);
    expect(
      missingGrids({ ok: false, refusal: { code: 'missing-grid', message: '' }, plan: null }),
    ).toEqual([]);
  });
});
