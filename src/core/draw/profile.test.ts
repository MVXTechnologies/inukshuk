import type { LngLat } from '@core/models';
import { haversineM } from '@core/trails/geometry';

import { buildDrawProfile, profilePaths, scrubProfile, thinProfile } from './profile';

// A straight line north, ~111 m per 0.001° of latitude.
const line = (n: number): LngLat[] => Array.from({ length: n }, (_, i) => [-70.9, 47 + i * 0.001]);

describe('buildDrawProfile', () => {
  it('charts elevation against distance along the line, min and max included', () => {
    const p = buildDrawProfile(line(5), [100, 110, 130, 120, 140]);
    expect(p).not.toBeNull();
    expect(p!.points).toHaveLength(5);
    expect(p!.minM).toBe(100);
    expect(p!.maxM).toBe(140);
    expect(p!.points[0]!.distanceM).toBe(0);
    expect(p!.totalM).toBeCloseTo(haversineM(line(5)[0]!, line(5)[4]!), 3);
  });

  it('skips missing elevations but keeps their distance; needs two', () => {
    const p = buildDrawProfile(line(4), [100, undefined, Number.NaN, 130]);
    expect(p!.points.map((x) => x.elevationM)).toEqual([100, 130]);
    expect(p!.points[1]!.distanceM).toBeCloseTo(p!.totalM, 6);
    expect(buildDrawProfile(line(3), [undefined, 5, undefined])).toBeNull();
    expect(buildDrawProfile([], [])).toBeNull();
  });
});

describe('thinProfile / profilePaths', () => {
  it('keeps the ends when thinning, and draws inside the box', () => {
    const p = buildDrawProfile(
      line(500),
      Array.from({ length: 500 }, (_, i) => 100 + (i % 50)),
    )!;
    const thin = thinProfile(p.points, 10);
    expect(thin).toHaveLength(10);
    expect(thin[0]).toBe(p.points[0]);
    expect(thin[9]).toBe(p.points[499]);
    expect(thinProfile(p.points.slice(0, 3), 10)).toHaveLength(3);

    const { line: d, area } = profilePaths(p, 300, 60, { maxPoints: 20 });
    expect(d.startsWith('M0.0,')).toBe(true);
    expect(d.split('L')).toHaveLength(20);
    expect(area.endsWith('Z')).toBe(true);
    const ys = d
      .slice(1)
      .split('L')
      .map((c) => Number(c.split(',')[1]));
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ys)).toBeLessThanOrEqual(60);
  });

  it('a flat profile draws a flat line (no division by zero)', () => {
    const p = buildDrawProfile(line(3), [50, 50, 50])!;
    const { line: d } = profilePaths(p, 100, 40);
    expect(d).not.toContain('NaN');
  });
});

describe('scrubProfile', () => {
  // 1 km climbing 100 m evenly: a 10 % grade everywhere.
  const pts = line(11);
  const p = buildDrawProfile(
    pts,
    pts.map((_, i) => 200 + i * 10 * (haversineM(pts[0]!, pts[1]!) / 100)),
  )!;

  it('maps a finger position to distance, elevation, grade and a point on the line', () => {
    const mid = scrubProfile(p, 0.5)!;
    expect(mid.distanceM).toBeCloseTo(p.totalM / 2, 3);
    expect(mid.gradePct).toBeCloseTo(10, 1);
    expect(mid.at[1]).toBeCloseTo(47.005, 6);
    expect(mid.ratio).toBeCloseTo(0.5, 6);
    expect(mid.elevationM).toBeGreaterThan(p.minM);
  });

  it('clamps to the ends and refuses nonsense', () => {
    expect(scrubProfile(p, -3)!.distanceM).toBe(0);
    expect(scrubProfile(p, 9)!.at).toEqual(pts[10]);
    expect(scrubProfile(p, Number.NaN)).toBeNull();
    // A descent reads negative.
    const down = buildDrawProfile(line(3), [300, 280, 260])!;
    expect(scrubProfile(down, 0.5)!.gradePct).toBeLessThan(0);
  });
});
