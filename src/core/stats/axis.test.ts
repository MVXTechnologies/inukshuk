import { niceAxisMax } from '@core/dashboard/logbook';

import { tightAxis } from './axis';

describe('tightAxis', () => {
  it('picks the nearest nice maximum with evenly spaced ticks', () => {
    expect(tightAxis(45)).toEqual({ max: 45, ticks: [0, 15, 30, 45] });
    expect(tightAxis(45.3)).toEqual({ max: 50, ticks: [0, 25, 50] });
    expect(tightAxis(11.77)).toEqual({ max: 12, ticks: [0, 4, 8, 12] });
    expect(tightAxis(36)).toEqual({ max: 40, ticks: [0, 10, 20, 30, 40] });
    expect(tightAxis(120)).toEqual({ max: 120, ticks: [0, 40, 80, 120] });
    expect(tightAxis(146)).toEqual({ max: 150, ticks: [0, 50, 100, 150] });
  });

  it('quarters a round maximum rather than leaving it at 0 / half / max', () => {
    // A 91 km month: 100 is the closest nice ceiling (10 % headroom).
    expect(tightAxis(90.69)).toEqual({ max: 100, ticks: [0, 25, 50, 75, 100] });
  });

  it('keeps ticks printable for small values', () => {
    expect(tightAxis(0.3)).toEqual({ max: 0.3, ticks: [0, 0.1, 0.2, 0.3] });
    expect(tightAxis(2.4)).toEqual({ max: 3, ticks: [0, 1, 2, 3] });
    expect(tightAxis(5)).toEqual({ max: 6, ticks: [0, 2, 4, 6] });
  });

  it('falls back to 0–2 without data', () => {
    for (const v of [0, -4, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(tightAxis(v)).toEqual({ max: 2, ticks: [0, 1, 2] });
    }
  });

  it('covers the data with less headroom than the shared axis', () => {
    let worst = 0;
    let sum = 0;
    let n = 0;
    for (let v = 0.5; v < 5000; v *= 1.037) {
      const axis = tightAxis(v);
      expect(axis.max).toBeGreaterThanOrEqual(v - 1e-9);
      expect(axis.max).toBeLessThanOrEqual(niceAxisMax(v));
      expect(axis.ticks.length).toBeGreaterThanOrEqual(3);
      expect(axis.ticks.length).toBeLessThanOrEqual(5);
      expect(axis.ticks[axis.ticks.length - 1]).toBe(axis.max);
      if (v >= 10) {
        worst = Math.max(worst, axis.max / v - 1);
        sum += axis.max / v - 1;
        n++;
      }
    }
    expect(worst).toBeLessThan(0.25);
    expect(sum / n).toBeLessThan(0.1);
  });
});
