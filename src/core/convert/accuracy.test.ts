import {
  buildPanel,
  combinedAccuracy,
  formatAccuracy,
  refusalPanel,
  validatedAgainst,
} from './accuracy';
import { plan } from './graph';
import type { Plan } from './types';

const qc = { xy: [-71.238585, 46.851168], h: -3.127, lon: -71.238585, lat: 46.851168 };
const mustPlan = (r: ReturnType<typeof plan>): Plan => {
  if (!r.ok) throw new Error(r.refusal.message);
  return r.plan;
};

describe('accuracy panel', () => {
  it('formats accuracies', () => {
    expect(formatAccuracy(0)).toBe('exact');
    expect(formatAccuracy(0.0005)).toBe('±0.5 mm');
    expect(formatAccuracy(0.008)).toBe('±8 mm');
    expect(formatAccuracy(0.05)).toBe('±5 cm');
    expect(formatAccuracy(1.5)).toBe('±1.5 m');
  });

  it('81KM003 → MTM 7 + CGVD2013a(1997): green, EPSG 10111 quoted, validated by NRCan', () => {
    const p = mustPlan(
      plan(
        {
          from: 'csrs:geo',
          fromHeight: 'ell',
          to: 'csrs:mtm7',
          toHeight: 'cgvd2013a',
          epoch: 1997,
        },
        qc,
      ),
    );
    const panel = buildPanel(p, { inputPrecisionM: 0.0003, available: () => true });
    expect(panel.status).toBe('green');
    expect(panel.combinedM).toBeCloseTo(0.05, 6);
    expect(
      panel.lines.some((l) =>
        l.text.includes('NAD83(CSRS)v3 to CGVD2013a(1997) height (1) (EPSG:10111)'),
      ),
    ).toBe(true);
    expect(panel.lines.some((l) => /Validated against .*NRCan/.test(l.text))).toBe(true);
    expect(panel.grids).toEqual([
      {
        file: 'ca_nrc_CGG2013an83.tif',
        label: 'CGG2013a (NRCan)',
        bundled: false,
        available: true,
      },
    ]);
    expect(panel.credits).toEqual(['NRCan · OGL-Canada']);
    expect(panel.copyLines[0]).toMatch(/^Accuracy: ±5 cm/);
  });

  it('goes amber when the input is coarse, a grid is missing or the velocity grid moved > 1 cm', () => {
    const p = mustPlan(
      plan(
        {
          from: 'csrs:geo',
          fromHeight: 'ell',
          to: 'csrs:mtm7',
          toHeight: 'cgvd2013a',
          epoch: 1997,
        },
        qc,
      ),
    );
    expect(buildPanel(p, { inputPrecisionM: 0.11, available: () => true }).status).toBe('amber');
    expect(buildPanel(p, { inputPrecisionM: null, available: () => false }).status).toBe('amber');
    const e = mustPlan(
      plan(
        {
          from: 'csrs:geo',
          fromHeight: 'ell',
          to: 'csrs:geo',
          toHeight: 'ell',
          epoch: 1997,
          toEpoch: 2026,
        },
        qc,
      ),
    );
    expect(
      buildPanel(e, { inputPrecisionM: null, available: () => true, epochShiftM: 0.004 }).status,
    ).toBe('green');
    expect(
      buildPanel(e, { inputPrecisionM: null, available: () => true, epochShiftM: 0.03 }).status,
    ).toBe('amber');
  });

  it('is amber for NAD27 (±1.5 m) and for unstated accuracies', () => {
    const p = mustPlan(
      plan(
        { from: 'csrs:geo', fromHeight: null, to: 'nad27-ca:geo', toHeight: null, epoch: 1997 },
        qc,
      ),
    );
    const panel = buildPanel(p, { inputPrecisionM: null, available: () => true });
    expect(panel.status).toBe('amber');
    expect(combinedAccuracy(p.steps)).toBeNull(); // NA83SCRS states none
    expect(panel.headline).toMatch(/not stated/);
  });

  it('says a pure projection is exact', () => {
    const p = mustPlan(
      plan(
        { from: 'csrs:geo', fromHeight: null, to: 'csrs:mtm7', toHeight: null, epoch: 1997 },
        qc,
      ),
    );
    const panel = buildPanel(p, { inputPrecisionM: null, available: () => true });
    expect(panel.status).toBe('green');
    expect(panel.headline).toBe('exact (stated, combined)');
  });

  it('names the official tools behind pair ids', () => {
    expect(validatedAgainst(['US-NADCON5-NAD27-to-NAD83_2011'])).toEqual(['NOAA NCAT llh']);
    expect(validatedAgainst(['FR-CC44-Circe'])).toEqual(['IGN Circé France 5.5.0']);
  });

  it('turns a refusal into a red panel', () => {
    const r = refusalPanel({
      code: 'missing-grid',
      message: 'Needs CGG2013a',
      grids: ['ca_nrc_CGG2013an83.tif'],
    });
    expect(r.status).toBe('red');
    expect(r.grids[0]?.available).toBe(false);
  });
});
