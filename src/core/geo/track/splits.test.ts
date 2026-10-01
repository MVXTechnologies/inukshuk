import { walk } from './__fixtures__/walk';
import { computeTrackStats } from './index';
import { classifySegmentedSteps } from './movingTime';
import { computeSplits } from './splits';

const KM = 1000;
const MILE = 1609.344;

describe('computeSplits', () => {
  it('cuts a steady walk into whole kilometres and a partial last one', () => {
    const pts = walk([{ m: 2500, s: 2500 }]);
    const splits = computeSplits(pts, { unitM: KM });
    expect(splits).toHaveLength(3);
    expect(splits.map((s) => Math.round(s.distanceM))).toEqual([1000, 1000, 500]);
    expect(splits.map((s) => s.partial)).toEqual([false, false, true]);
    for (const s of splits) {
      expect(s.speedMps!).toBeCloseTo(1, 3);
      expect(s.elapsedS!).toBeCloseTo(s.distanceM, 0);
    }
  });

  it('uses miles when asked', () => {
    const pts = walk([{ m: 4000, s: 4000 }]);
    const splits = computeSplits(pts, { unitM: MILE });
    expect(splits).toHaveLength(3);
    expect(splits[0]!.distanceM).toBeCloseTo(MILE, 3);
  });

  it('keeps a stop out of the moving time but in the elapsed time', () => {
    const pts = walk([
      { m: 1500, s: 1500 },
      { m: 0, s: 600 },
      { m: 500, s: 500 },
    ]);
    const steps = classifySegmentedSteps(pts, []);
    const splits = computeSplits(pts, { unitM: KM, steps });
    expect(splits).toHaveLength(2);
    expect(splits[1]!.elapsedS!).toBeCloseTo(1600, -1);
    expect(splits[1]!.movingS!).toBeLessThan(1100);
    expect(splits[1]!.speedMps!).toBeCloseTo(1, 1);
    const total = splits.reduce((a, s) => a + s.movingS!, 0);
    const stats = computeTrackStats(pts);
    expect(total).toBeCloseTo(stats.movingTimeS, 3);
  });

  it('books the climb to the split it happens in, adding up to the trail total', () => {
    const pts = walk([
      { m: 1000, s: 1000, rise: 120 },
      { m: 1000, s: 1000, rise: -80 },
    ]);
    const splits = computeSplits(pts, { unitM: KM });
    // Hysteresis commits in 3 m steps, so a little lands later.
    expect(splits[0]!.ascentM).toBeGreaterThan(110);
    expect(splits[1]!.descentM).toBeGreaterThan(70);
    const stats = computeTrackStats(pts);
    expect(splits.reduce((a, s) => a + s.ascentM, 0)).toBeCloseTo(stats.ascentM, 6);
    expect(splits.reduce((a, s) => a + s.descentM, 0)).toBeCloseTo(stats.descentM, 6);
  });

  it('gives an untimed route distance and climb only', () => {
    const pts = walk([{ m: 1500, s: 1500, rise: 50 }], { timed: false });
    const splits = computeSplits(pts, { unitM: KM });
    expect(splits).toHaveLength(2);
    expect(splits[0]!.elapsedS).toBeNull();
    expect(splits[0]!.movingS).toBeNull();
    expect(splits[0]!.speedMps).toBeNull();
    expect(splits[0]!.ascentM).toBeGreaterThan(0);
  });

  it('never walks the hop across a recording pause', () => {
    const a = walk([{ m: 600, s: 600 }]);
    const b = walk([{ m: 600, s: 600 }], { t0: a[a.length - 1]!.time + 3_600_000 }).map((p) => ({
      ...p,
      latitude: p.latitude + 0.05, // 5 km further on
    }));
    const pts = [...a, ...b];
    const splits = computeSplits(pts, { unitM: KM, segmentStarts: [a.length] });
    const total = splits.reduce((s, x) => s + x.distanceM, 0);
    expect(total).toBeCloseTo(1200, 0);
    expect(splits.reduce((s, x) => s + x.elapsedS!, 0)).toBeCloseTo(1200, 0);
  });

  it('folds a sliver of a last split into the one before', () => {
    const pts = walk([{ m: 2005, s: 2005 }]);
    const splits = computeSplits(pts, { unitM: KM });
    expect(splits).toHaveLength(2);
    expect(splits[1]!.distanceM).toBeCloseTo(1005, 0);
  });

  it('returns nothing for degenerate input', () => {
    expect(computeSplits([], { unitM: KM })).toEqual([]);
    expect(computeSplits(walk([]), { unitM: KM })).toEqual([]);
    expect(computeSplits(walk([{ m: 10, s: 10 }]), { unitM: 0 })).toEqual([]);
    expect(computeSplits(walk([{ m: 0, s: 60 }]), { unitM: KM })).toEqual([]);
  });

  it('handles a trail that ends exactly on a split', () => {
    const pts = walk([{ m: 2000, s: 2000 }], { stepS: 10 });
    const splits = computeSplits(pts, { unitM: KM });
    expect(splits).toHaveLength(2);
    expect(splits[1]!.partial).toBe(false);
  });
});
