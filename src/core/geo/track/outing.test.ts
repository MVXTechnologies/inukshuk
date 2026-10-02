import { walk } from './__fixtures__/walk';
import { analyzeOuting, isTimedTrack } from './outing';

describe('analyzeOuting', () => {
  it('derives splits, stops, the steepest stretch and extremes in one go', () => {
    const pts = walk(
      [
        { m: 1200, s: 1200, rise: 30 },
        { m: 400, s: 900, rise: 100 },
        { m: 0, s: 600 },
        { m: 1600, s: 1300, rise: -130 },
      ],
      { stepS: 5 },
    );
    const a = analyzeOuting(pts, { splitUnitM: 1000, category: 'hike' });
    expect(a.timed).toBe(true);
    expect(a.axis.totalM).toBeCloseTo(3200, 0);
    expect(a.splits).toHaveLength(4);
    expect(a.splits[0]!.speedMps!).toBeCloseTo(1, 1);
    expect(a.stops).toHaveLength(1);
    expect(a.steepest.climb!.gradePct).toBeGreaterThan(15);
    expect(a.extremes!.highM).toBeCloseTo(330, 0);
  });

  it('gives an untimed route no stops and no paces', () => {
    const pts = walk([{ m: 2500, s: 2500, rise: 100 }], { timed: false });
    const a = analyzeOuting(pts, { splitUnitM: 1000 });
    expect(a.timed).toBe(false);
    expect(a.stops).toEqual([]);
    expect(a.splits.every((s) => s.speedMps === null)).toBe(true);
  });
});

describe('isTimedTrack', () => {
  it('needs two forward-moving timestamps', () => {
    expect(isTimedTrack(walk([{ m: 10, s: 10 }]))).toBe(true);
    expect(isTimedTrack(walk([{ m: 10, s: 10 }], { timed: false }))).toBe(false);
    expect(isTimedTrack(walk([]))).toBe(false);
    const frozen = walk([{ m: 10, s: 10 }]).map((p) => ({ ...p, time: 1000 }));
    expect(isTimedTrack(frozen)).toBe(false);
  });
});

describe('analyzeOuting on a long trail', () => {
  it('stays linear: 50 000 points well under a second', () => {
    const legs = Array.from({ length: 50 }, (_, i) => ({
      m: 1000,
      s: 1000,
      rise: i % 2 === 0 ? 60 : -50,
    }));
    const pts = walk(legs, { stepS: 1 });
    expect(pts.length).toBeGreaterThan(50_000);
    const t0 = Date.now();
    const a = analyzeOuting(pts, { splitUnitM: 1000 });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(a.splits).toHaveLength(50);
  });
});
