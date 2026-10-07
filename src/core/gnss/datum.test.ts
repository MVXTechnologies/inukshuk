import { liteEngine } from '../convert/lite';
import type { Engine, EngineRequest } from '../convert/run';
import {
  decimalYear,
  DEFAULT_PROJECT_DATUM,
  OffsetCache,
  planFixOutput,
  receiverFrame,
  receiverFrameLabel,
  transformFix,
  WGS84_ENSEMBLE_M,
  type FixPoint,
  type OutputPlan,
} from './datum';

/** 2026.75 exactly. */
const T = Date.UTC(2026, 0, 1) + 273.75 * 86_400_000;
const QC: FixPoint = { lat: 46.803, lon: -71.217, hEll: 60, timeMs: T };

function planOk(...a: Parameters<typeof planFixOutput>): OutputPlan {
  const r = planFixOutput(...a);
  if (!r.ok) throw new Error(`${r.refusal.code}: ${r.refusal.message}`);
  return r.out;
}

/** An engine that adds fixed offsets, counting calls. */
function fakeEngine(d = [0.0001, -0.0002, 0.5]): Engine & { calls: EngineRequest[] } {
  const calls: EngineRequest[] = [];
  return {
    kind: 'native',
    calls,
    transform(req) {
      calls.push(req);
      const c = req.coords.slice(0, req.dim);
      return { ok: true, coords: c.map((v, i) => (i < 3 ? v + (d[i] ?? 0) : v)) };
    },
  };
}

describe('receiverFrame', () => {
  it('autonomous / SBAS / DR are in the broadcast frame, WGS 84', () => {
    for (const k of ['autonomous', 'sbas', 'dr', 'none'] as const) {
      expect(receiverFrame(k, { frame: 'csrs', epoch: 1997 })).toEqual({
        frame: 'wgs84',
        epoch: null,
        frameUnknown: false,
        basis: 'broadcast',
      });
    }
  });

  it('corrected fixes take the profile frame; unknown → WGS 84 with ⚠', () => {
    expect(receiverFrame('rtk-fixed', { frame: 'csrs', epoch: 1997 })).toEqual({
      frame: 'csrs',
      epoch: 1997,
      frameUnknown: false,
      basis: 'corrections',
    });
    expect(receiverFrame('rtk-float', { frame: 'nad83-2011', epoch: 2010 })).toMatchObject({
      frame: 'nad83-2011',
      epoch: null,
    });
    expect(receiverFrame('rtk-fixed', { frame: 'csrs' })).toMatchObject({ epoch: null });
    expect(receiverFrame('rtk-fixed', null)).toEqual({
      frame: 'wgs84',
      epoch: null,
      frameUnknown: true,
      basis: 'assumed',
    });
    // no profile at all: RTK = receiver-managed corrections (unknown); DGPS = SBAS
    expect(receiverFrame('rtk-fixed', 'none')).toMatchObject({
      frameUnknown: true,
      basis: 'assumed',
    });
    expect(receiverFrame('dgps', 'none')).toMatchObject({
      frameUnknown: false,
      basis: 'broadcast',
    });
    expect(receiverFrameLabel(receiverFrame('rtk-fixed', null))).toBe('WGS 84 · ⚠ frame unknown');
    expect(receiverFrameLabel(receiverFrame('rtk-fixed', { frame: 'csrs', epoch: 1997 }))).toBe(
      'NAD83(CSRS) 1997.0',
    );
    expect(receiverFrameLabel(receiverFrame('autonomous', 'none'))).toBe('WGS 84');
  });
});

describe('decimalYear', () => {
  it('is exact across normal and leap years', () => {
    expect(decimalYear(Date.UTC(2026, 0, 1))).toBe(2026);
    expect(decimalYear(T)).toBeCloseTo(2026.75, 12);
    expect(decimalYear(Date.UTC(2024, 6, 2))).toBeCloseTo(2024 + 183 / 366, 12);
  });
});

describe('planFixOutput', () => {
  it('default project datum, autonomous fix: nothing to convert', () => {
    const out = planOk(QC, receiverFrame('autonomous', 'none'), DEFAULT_PROJECT_DATUM);
    expect(out).toMatchObject({
      plan: null,
      steps: [],
      datumAccuracyM: 0,
      method: 'WGS 84',
      outputLabel: 'WGS 84',
      height: 'ell',
      frameUnknown: false,
      validation: [],
    });
  });

  it('MRNF RTK (NAD83(CSRS) 1997.0) → WGS 84: TRX-convention step to ITRF2020 @ t, then the ensemble identity', () => {
    const out = planOk(
      QC,
      receiverFrame('rtk-fixed', { frame: 'csrs', epoch: 1997 }),
      DEFAULT_PROJECT_DATUM,
    );
    expect(out.method).toBe('NAD83(CSRS) 1997.0 → ITRF2020 @ 2026.75 → WGS 84');
    expect(out.plan?.inDim).toBe(4);
    expect(out.plan?.tValue).toBeCloseTo(2026.75, 12);
    expect(out.validation).toEqual(['CA-CSRS-ITRF2020-math', 'CA-CSRS-ITRF2020-TRXdefault']);
    const last = out.steps[out.steps.length - 1];
    expect(last).toMatchObject({ accuracyM: WGS84_ENSEMBLE_M, flag: 'amber', proj: [] });
    expect(last?.name).toBe('ITRF2020 taken as WGS 84 at 2026.75 (null transformation)');
    expect(out.datumAccuracyM).toBeCloseTo(Math.hypot(0.025, 2), 9);
  });

  it('MRNF RTK → project NAD83(CSRS) 2010.0: the velocity-grid epoch step only', () => {
    const out = planOk(QC, receiverFrame('rtk-fixed', { frame: 'csrs', epoch: 1997 }), {
      frame: 'csrs',
      epoch: 2010,
      height: 'ell',
    });
    expect(out.method).toBe('NAD83(CSRS) 1997.0 → NAD83(CSRS) 2010.0');
    expect(out.datumAccuracyM).toBeCloseTo(0.025, 9);
    expect(out.plan?.pipeline).toContain('+proj=deformation +dt=13 ');
  });

  it('MRNF RTK → NAD83(CSRS) 1997.0 + CGVD2013: the CGG2013a geoid step, named in the method', () => {
    const out = planOk(QC, receiverFrame('rtk-fixed', { frame: 'csrs', epoch: 1997 }), {
      frame: 'csrs',
      epoch: 1997,
      height: 'cgvd2013a',
    });
    expect(out.method).toBe('NAD83(CSRS) 1997.0 · h → CGVD2013 (CGG2013a)');
    expect(out.plan?.gridsNeeded).toEqual(['ca_nrc_CGG2013an83.tif']);
    expect(out.height).toBe('cgvd2013a');
  });

  it('autonomous fix → NAD83(CSRS) 2010.0: WGS 84 taken as ITRF2020 @ t first (amber, 2 m)', () => {
    const out = planOk({ ...QC, hEll: null }, receiverFrame('autonomous', 'none'), {
      frame: 'csrs',
      epoch: 2010,
      height: 'ell',
    });
    expect(out.method).toBe('WGS 84 → ITRF2020 @ 2026.75 → NAD83(CSRS) 2010.0');
    expect(out.steps[0]).toMatchObject({
      name: 'WGS 84 taken as ITRF2020 at 2026.75 (null transformation)',
      accuracyM: 2,
    });
    expect(out.height).toBeNull(); // no height in, none out
  });

  it('ITRF2020 current-epoch fix anywhere → WGS 84: identity, allowed outside Canada', () => {
    const paris: FixPoint = { lat: 48.85, lon: 2.35, hEll: 80, timeMs: T };
    const out = planOk(
      paris,
      receiverFrame('rtk-fixed', { frame: 'itrf2020', epoch: 'observation' }),
      DEFAULT_PROJECT_DATUM,
    );
    expect(out).toMatchObject({
      plan: null,
      method: 'ITRF2020 @ 2026.75 → WGS 84',
      datumAccuracyM: 2,
    });
    const egm = planOk(
      paris,
      receiverFrame('rtk-fixed', { frame: 'itrf2020', epoch: 'observation' }),
      { frame: 'wgs84', height: 'egm2008' },
    );
    expect(egm.plan?.gridsNeeded).toEqual(['us_nga_egm08_25.tif']);
    expect(egm.method).toBe('ITRF2020 @ 2026.75 → WGS 84 · h → EGM2008');
  });

  it('a fixed-epoch ITRF profile is not the observation epoch: Convert refuses two ITRF epochs', () => {
    const r = planFixOutput(
      QC,
      receiverFrame('rtk-fixed', { frame: 'itrf2014', epoch: 2010 }),
      DEFAULT_PROJECT_DATUM,
    );
    expect(r).toMatchObject({ ok: false, refusal: { code: 'unvalidated-pair' } });
  });

  it('frame unknown is carried to the output', () => {
    const out = planOk(QC, receiverFrame('rtk-fixed', null), DEFAULT_PROJECT_DATUM);
    expect(out.frameUnknown).toBe(true);
    expect(out.plan).toBeNull();
  });

  it('refuses outside validated routes, with the reason', () => {
    const ref = (...a: Parameters<typeof planFixOutput>) => {
      const r = planFixOutput(...a);
      if (r.ok) throw new Error('expected a refusal');
      return r.refusal.code;
    };
    const den: FixPoint = { lat: 39.7392, lon: -104.9903, hEll: 1600, timeMs: T };
    // US RTN (NAD83(2011)) → WGS 84: no validated NAD83(2011) ↔ ITRF operation yet
    expect(
      ref(den, receiverFrame('rtk-fixed', { frame: 'nad83-2011' }), DEFAULT_PROJECT_DATUM),
    ).toBe('unvalidated-pair');
    // ITRF2020 rover in France → NAD83(CSRS): outside the validated region
    expect(
      ref(
        { lat: 48.85, lon: 2.35, hEll: 80, timeMs: T },
        receiverFrame('rtk-fixed', { frame: 'itrf2020', epoch: 'observation' }),
        { frame: 'csrs', epoch: 2010, height: 'ell' },
      ),
    ).toBe('outside-region');
    expect(
      ref(QC, receiverFrame('rtk-fixed', { frame: 'csrs', epoch: 1997 }), {
        frame: 'csrs',
        height: 'ell',
      }),
    ).toBe('needs-epoch');
    expect(ref(QC, receiverFrame('rtk-fixed', { frame: 'csrs' }), DEFAULT_PROJECT_DATUM)).toBe(
      'needs-epoch',
    );
    expect(ref(QC, receiverFrame('autonomous', 'none'), { frame: 'wgs84', height: 'nope' })).toBe(
      'unvalidated-pair',
    );
    expect(
      ref({ ...QC, lat: 91 }, receiverFrame('autonomous', 'none'), DEFAULT_PROJECT_DATUM),
    ).toBe('bad-input');
    expect(
      ref({ ...QC, lon: NaN }, receiverFrame('autonomous', 'none'), DEFAULT_PROJECT_DATUM),
    ).toBe('bad-input');
    expect(
      ref({ ...QC, lon: 181 }, receiverFrame('autonomous', 'none'), DEFAULT_PROJECT_DATUM),
    ).toBe('bad-input');
  });

  it('NAD83(2011) RTN → NAD83(1986), 2D project: NADCON5 (NOAA NCAT-validated)', () => {
    const den: FixPoint = { lat: 39.7392, lon: -104.9903, hEll: 1600, timeMs: T };
    const out = planOk(den, receiverFrame('rtk-fixed', { frame: 'nad83-2011' }), {
      frame: 'nad83-1986-us',
      height: null,
    });
    expect(out.method).toBe('NAD83(2011) → NAD83(1986) · US');
    expect(out.height).toBeNull();
    expect(out.validation).toContain('US-NADCON5-NAD83_2011-to-NAD83_1986');
  });
});

describe('transformFix and the offset cache', () => {
  const csrs2010 = planOk(QC, receiverFrame('rtk-fixed', { frame: 'csrs', epoch: 1997 }), {
    frame: 'csrs',
    epoch: 2010,
    height: 'ell',
  });

  it('passes through when there is no plan; height only when the project has one', () => {
    const e = fakeEngine();
    const none = planOk(QC, receiverFrame('autonomous', 'none'), DEFAULT_PROJECT_DATUM);
    expect(transformFix(e, none, QC)).toEqual({
      ok: true,
      value: { lat: 46.803, lon: -71.217, h: 60 },
    });
    const flat = planOk(QC, receiverFrame('autonomous', 'none'), { frame: 'wgs84', height: null });
    expect(transformFix(e, flat, QC)).toEqual({
      ok: true,
      value: { lat: 46.803, lon: -71.217, h: null },
    });
    expect(e.calls).toHaveLength(0);
  });

  it('runs the plan through the engine (lon, lat, h order) and maps refusals', () => {
    const e = fakeEngine();
    const r = transformFix(e, csrs2010, QC);
    expect(e.calls[0]).toMatchObject({ dim: 3, coords: [-71.217, 46.803, 60] });
    expect(r).toEqual({
      ok: true,
      value: { lat: expect.closeTo(46.8028, 9), lon: expect.closeTo(-71.2169, 9), h: 60.5 },
    });
    const flat = planOk(
      { ...QC, hEll: null },
      receiverFrame('rtk-fixed', { frame: 'csrs', epoch: 1997 }),
      { frame: 'csrs', epoch: 2010, height: 'ell' },
    );
    expect(transformFix(e, flat, { ...QC, hEll: null })).toMatchObject({
      ok: true,
      value: { h: null },
    });
    // the grid-free fallback engine refuses a velocity-grid plan instead of guessing
    expect(transformFix(liteEngine, csrs2010, QC)).toMatchObject({
      ok: false,
      refusal: { code: 'lite-unsupported' },
    });
    const failing: Engine = {
      kind: 'native',
      transform: () => ({ ok: false, error: 'missing-grid', message: '', grids: ['x.tif'] }),
    };
    expect(transformFix(failing, csrs2010, QC)).toMatchObject({
      ok: false,
      refusal: { code: 'missing-grid' },
    });
    const hNull: Engine = {
      kind: 'native',
      transform: (q) => ({ ok: true, coords: q.coords.slice(0, 2) }),
    };
    expect(transformFix(hNull, csrs2010, QC)).toMatchObject({ ok: true, value: { h: null } });
  });

  it('reuses one engine call within 1 km and the same day; recomputes otherwise', () => {
    const e = fakeEngine();
    const c = new OffsetCache(e);
    expect(c.apply(csrs2010, QC)).toMatchObject({ ok: true, value: { h: 60.5 } });
    const near = c.apply(csrs2010, { ...QC, lat: QC.lat + 0.001, hEll: 61 });
    expect(near).toEqual({
      ok: true,
      value: {
        lat: expect.closeTo(46.804 - 0.0002, 9),
        lon: expect.closeTo(-71.217 + 0.0001, 9),
        h: expect.closeTo(61.5, 9),
      },
    });
    expect(e.calls).toHaveLength(1);
    c.apply(csrs2010, { ...QC, lat: QC.lat + 0.02 }); // ~2.2 km
    expect(e.calls).toHaveLength(2);
    // a 2D fix after a 3D one: recompute (the height offset is meaningless)
    expect(c.apply(csrs2010, { ...QC, lat: QC.lat + 0.02, hEll: null })).toMatchObject({
      ok: true,
      value: { h: null },
    });
    expect(e.calls).toHaveLength(3);
    // ... and a 2D fix near a 2D reference reuses it
    expect(c.apply(csrs2010, { ...QC, lat: QC.lat + 0.0201, hEll: null })).toMatchObject({
      ok: true,
      value: { h: null },
    });
    expect(e.calls).toHaveLength(3);
    // another plan → recompute; no plan → passthrough
    const wgs = planOk(
      QC,
      receiverFrame('rtk-fixed', { frame: 'csrs', epoch: 1997 }),
      DEFAULT_PROJECT_DATUM,
    );
    c.apply(wgs, QC);
    expect(e.calls).toHaveLength(4);
    expect(
      c.apply(planOk(QC, receiverFrame('autonomous', 'none'), DEFAULT_PROJECT_DATUM), QC),
    ).toEqual({ ok: true, value: { lat: 46.803, lon: -71.217, h: 60 } });
    const failing: Engine = {
      kind: 'native',
      transform: () => ({ ok: false, error: 'boom', message: 'x' }),
    };
    expect(new OffsetCache(failing).apply(csrs2010, QC)).toMatchObject({ ok: false });
  });
});
