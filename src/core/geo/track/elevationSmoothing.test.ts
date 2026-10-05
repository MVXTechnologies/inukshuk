import type { TrackPoint } from '@core/models';

import {
  CLIMB_SMOOTHING_WINDOW_M,
  climbElevations,
  smoothElevationsByDistance,
} from './elevationSmoothing';
import { elevationGainLoss } from './index';

const M_PER_DEG_LAT = 111_195;

/** Points every `stepM` metres due north, elevation from `ele(distance)`. */
function line(n: number, stepM: number, ele: (d: number) => number | undefined): TrackPoint[] {
  return Array.from({ length: n }, (_, i) => {
    const h = ele(i * stepM);
    const p: TrackPoint = { latitude: 46 + (i * stepM) / M_PER_DEG_LAT, longitude: 7, time: 0 };
    if (h !== undefined) p.altitude = h;
    return p;
  });
}

const climb = (series: readonly (number | undefined)[]) =>
  elevationGainLoss(series, { threshold: 3 });

describe('smoothElevationsByDistance', () => {
  it('is the identity for a zero window, and keeps missing elevations missing', () => {
    const pts = line(10, 10, (d) => (d === 30 ? undefined : d / 10));
    expect(smoothElevationsByDistance(pts, 0)).toEqual(pts.map((p) => p.altitude));
    const smoothed = smoothElevationsByDistance(pts, 50);
    expect(smoothed[3]).toBeUndefined();
    expect(smoothed.filter((h) => h === undefined)).toHaveLength(1);
  });

  it('leaves a steady slope untouched away from the ends', () => {
    const pts = line(200, 5, (d) => 1000 + 0.2 * d);
    const smoothed = smoothElevationsByDistance(pts, 60);
    for (let i = 10; i < 190; i++) {
      expect(smoothed[i]).toBeCloseTo(pts[i]!.altitude!, 6);
    }
  });

  it('does not depend on how densely the profile is sampled', () => {
    const ele = (d: number) => 500 + 40 * Math.sin(d / 120);
    const sparse = smoothElevationsByDistance(line(101, 20, ele), 60);
    const dense = smoothElevationsByDistance(line(401, 5, ele), 60);
    for (let i = 5; i < 95; i++) {
      // Same distance: sparse index i ↔ dense index 4i.
      expect(Math.abs(sparse[i]! - dense[4 * i]!)).toBeLessThan(1);
    }
  });

  it('flattens pixel hopping to its mean', () => {
    // Alternating 10 m steps every 15 m: a traverse hopping between two rows.
    const pts = line(400, 5, (d) => (Math.floor(d / 15) % 2 === 0 ? 1000 : 1010));
    expect(climb(pts.map((p) => p.altitude)).ascentM).toBeGreaterThan(600);
    const smoothed = smoothElevationsByDistance(pts, CLIMB_SMOOTHING_WINDOW_M);
    expect(climb(smoothed).ascentM).toBeLessThan(10);
  });

  it('returns short or zero-length profiles as they are', () => {
    expect(smoothElevationsByDistance([], 60)).toEqual([]);
    const two = line(2, 10, (d) => d);
    expect(smoothElevationsByDistance(two, 60)).toEqual([0, 10]);
    const still = line(5, 0, () => 100);
    expect(smoothElevationsByDistance(still, 60)).toEqual([100, 100, 100, 100, 100]);
  });
});

describe('climbElevations', () => {
  it('keeps a clean profile exactly as recorded', () => {
    // 600 m of climb with a few small real bumps on the way.
    const pts = line(1200, 5, (d) => 800 + 0.1 * d + 4 * Math.sin(d / 40));
    const raw = pts.map((p) => p.altitude);
    expect(climbElevations(pts, 3)).toEqual(raw);
  });

  it('replaces stepping noise by the smoothed profile', () => {
    // A 10 % ramp whose samples hop ±6 m every few metres.
    const pts = line(2000, 5, (d) => 800 + 0.1 * d + (Math.floor(d / 15) % 2 === 0 ? -6 : 6));
    const raw = climb(pts.map((p) => p.altitude)).ascentM;
    const robust = climb(climbElevations(pts, 3)).ascentM;
    expect(raw).toBeGreaterThan(2500);
    // The real climb: 10 000 m × 10 %.
    expect(robust).toBeGreaterThan(950);
    expect(robust).toBeLessThan(1050);
  });

  it('never flips a short trail with a small real hill, or one without elevations', () => {
    // One 20 m hill, 300 m across, on a 1 km walk.
    const hill = line(200, 5, (d) => 200 + 20 * Math.max(0, Math.sin(((d - 350) / 300) * Math.PI)));
    expect(climbElevations(hill, 3)).toEqual(hill.map((p) => p.altitude));
    const none = line(50, 5, () => undefined);
    expect(climbElevations(none, 3)).toEqual(none.map(() => undefined));
  });

  it('treats a flat trail hopping 4 m between two pixels as noise', () => {
    const flat = line(400, 5, (d) => 200 + (Math.floor(d / 10) % 2 === 0 ? 0 : 4));
    expect(climb(flat.map((p) => p.altitude)).ascentM).toBeGreaterThan(300);
    expect(climb(climbElevations(flat, 3)).ascentM).toBeLessThan(5);
  });
});
