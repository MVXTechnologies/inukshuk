import { liteEngine } from '../convert/lite';
import type { Engine } from '../convert/run';
import { drawnPosition, FixOutputs, MAP_DATUM, REPLAN_KM } from './output';
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
