import { walk } from './__fixtures__/walk';
import { interpolateTrackAtDistance } from './interpolate';
import {
  buildTrackAxis,
  gradeAtDistance,
  indexAtDistance,
  interpolateOnAxis,
  pointAtIndex,
} from './trackAxis';

describe('trackAxis', () => {
  const pts = walk([{ m: 1000, s: 1000, rise: 100 }], { stepS: 10 });
  const axis = buildTrackAxis(pts);

  it('accumulates distance along the trail', () => {
    expect(axis.cumM[0]).toBe(0);
    expect(axis.totalM).toBeCloseTo(1000, 3);
    expect(axis.cumM[axis.cumM.length - 1]).toBeCloseTo(axis.totalM, 9);
  });

  it('finds the last point at or before a distance, clamped', () => {
    expect(indexAtDistance(axis, -5)).toBe(0);
    expect(indexAtDistance(axis, 0)).toBe(0);
    expect(indexAtDistance(axis, 55)).toBe(5);
    expect(indexAtDistance(axis, 1e9)).toBe(pts.length - 1);
    expect(indexAtDistance(buildTrackAxis([]), 10)).toBe(-1);
  });

  it('interpolates exactly like interpolateTrackAtDistance', () => {
    for (const d of [0, 3.3, 250, 777.7, 999.99, 1200]) {
      const a = interpolateOnAxis(pts, axis, d)!;
      const b = interpolateTrackAtDistance(pts, d)!;
      expect(a.latitude).toBeCloseTo(b.latitude, 9);
      expect(a.distanceM).toBeCloseTo(b.distanceM, 6);
      expect(a.elevation!).toBeCloseTo(b.elevation!, 6);
      expect(a.time!).toBeCloseTo(b.time!, 0);
    }
    expect(interpolateOnAxis([], buildTrackAxis([]), 5)).toBeNull();
  });

  it('drops time on untimed points', () => {
    const route = walk([{ m: 100, s: 100 }], { timed: false });
    const ax = buildTrackAxis(route);
    expect(interpolateOnAxis(route, ax, 50)!.time).toBeUndefined();
    expect(pointAtIndex(route, ax, 1)!.time).toBeUndefined();
    expect(pointAtIndex(route, ax, 999)).toBeNull();
  });

  it('measures the grade around a distance', () => {
    expect(gradeAtDistance(pts, axis, 500)).toBeCloseTo(10, 1);
    // Clamped window at the very start still reads the slope.
    expect(gradeAtDistance(pts, axis, 0)).toBeCloseTo(10, 1);
    const flat = pts.map((p) => ({ ...p, altitude: undefined }));
    expect(gradeAtDistance(flat, buildTrackAxis(flat), 500)).toBeNull();
    expect(gradeAtDistance([pts[0]!], buildTrackAxis([pts[0]!]), 0)).toBeNull();
  });
});
