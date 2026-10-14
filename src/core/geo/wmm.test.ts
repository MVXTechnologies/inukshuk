import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { declinationAt, magneticField, trueToMagnetic } from './wmm';
import { WMM2025_COEFFS } from './wmm2025';

/**
 * NOAA's published WMM2025 test values, verbatim from the WMM2025COF
 * distribution (NCEI, 2024-12):
 * - `wmm2025-test-values.txt`: the 100 points of `WMM2025_TestValues.txt`
 *   (year, height km, lat, lon, D, I, H, X, Y, Z, F, …);
 * - `wmm2025-test-values-official.txt`: the 12 points of the report's table
 *   (`WMM2025_TEST_VALUES.txt`: year, height km, lat, lon, X, Y, Z, H, F, I, D, …).
 */
function rows(file: string): number[][] {
  return readFileSync(join(__dirname, '__fixtures__', file), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '' && !l.startsWith('#'))
    .map((l) => l.trim().split(/\s+/).map(Number));
}

const TOL_DEG = 0.1;

describe('WMM2025', () => {
  it('has every coefficient through degree and order 12', () => {
    expect(WMM2025_COEFFS).toHaveLength(90);
  });

  it("matches all 100 points of NOAA's WMM2025_TestValues.txt to ≤ 0.1° (declination and inclination)", () => {
    const points = rows('wmm2025-test-values.txt');
    expect(points).toHaveLength(100);
    let worstD = 0;
    let worstI = 0;
    for (const [year, hKm, lat, lon, d, i, , , , , f] of points) {
      const m = magneticField(lat!, lon!, hKm!, year!);
      worstD = Math.max(worstD, Math.abs(m.declinationDeg - d!));
      worstI = Math.max(worstI, Math.abs(m.inclinationDeg - i!));
      expect(Math.abs(m.declinationDeg - d!)).toBeLessThanOrEqual(TOL_DEG);
      expect(Math.abs(m.f - f!)).toBeLessThan(0.001); // nT: the file has 6 decimals
    }
    // The values are published to 0.01°: we agree to their rounding.
    expect(worstD).toBeLessThanOrEqual(0.006);
    expect(worstI).toBeLessThanOrEqual(0.006);
  });

  it("matches the report's 12 official test points, components to their 0.1 nT rounding", () => {
    const points = rows('wmm2025-test-values-official.txt');
    expect(points).toHaveLength(12);
    for (const [year, hKm, lat, lon, x, y, z, h, f, i, d] of points) {
      const m = magneticField(lat!, lon!, hKm!, year!);
      expect(Math.abs(m.x - x!)).toBeLessThanOrEqual(0.051);
      expect(Math.abs(m.y - y!)).toBeLessThanOrEqual(0.051);
      expect(Math.abs(m.z - z!)).toBeLessThanOrEqual(0.051);
      expect(Math.abs(m.h - h!)).toBeLessThanOrEqual(0.051);
      expect(Math.abs(m.f - f!)).toBeLessThanOrEqual(0.051);
      expect(Math.abs(m.inclinationDeg - i!)).toBeLessThanOrEqual(0.006);
      expect(Math.abs(m.declinationDeg - d!)).toBeLessThanOrEqual(0.006);
      expect(m.inModel).toBe(true);
    }
  });

  it('Québec City in October 2026 is about 14.6° W, as the mockup shows', () => {
    const d = declinationAt(46.81394, -71.20761, Date.UTC(2026, 9, 13));
    expect(d).toBeGreaterThan(-15.2);
    expect(d).toBeLessThan(-14.2);
  });

  it('flags dates outside 2025.0–2030.0 as extrapolated', () => {
    expect(magneticField(45, -73, 0, 2031).inModel).toBe(false);
    expect(magneticField(45, -73, 0, 2024.5).inModel).toBe(false);
  });

  it('stays finite at the poles (clamped a hair inside them)', () => {
    for (const lat of [90, -90]) {
      const m = magneticField(lat, 0, 0, 2026);
      expect(Number.isFinite(m.declinationDeg)).toBe(true);
    }
  });

  it('turns a true bearing magnetic, wrapped into [0, 360)', () => {
    expect(trueToMagnetic(42, -14.6)).toBeCloseTo(56.6);
    expect(trueToMagnetic(5, 10)).toBeCloseTo(355);
    expect(trueToMagnetic(355, -10)).toBeCloseTo(5);
  });
});
