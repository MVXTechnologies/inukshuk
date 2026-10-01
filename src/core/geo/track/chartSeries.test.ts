import { walk } from './__fixtures__/walk';
import { averageHeartRate, buildChartSeries, heartRateBands, sampleIndexAt } from './chartSeries';
import { detectStops } from './highlights';
import { classifySegmentedSteps } from './movingTime';
import { buildTrackAxis } from './trackAxis';

const hike = walk(
  [
    { m: 1000, s: 1000, rise: 100 },
    { m: 0, s: 600 },
    { m: 1000, s: 500, rise: -100 },
  ],
  { stepS: 5 },
).map((p, i) => ({ ...p, heartRateBpm: 100 + (i % 50) }));
const axis = buildTrackAxis(hike);

describe('buildChartSeries', () => {
  const stops = detectStops(hike, classifySegmentedSteps(hike, []));
  const s = buildChartSeries(hike, axis, { samples: 101, stops, timed: true });

  it('samples evenly along the whole trail', () => {
    expect(s.distances).toHaveLength(101);
    expect(s.distances[0]).toBe(0);
    expect(s.distances[100]).toBeCloseTo(axis.totalM, 6);
  });

  it('follows the elevation', () => {
    expect(s.elevation![0]).toBeCloseTo(200, 0);
    expect(s.elevation![50]).toBeCloseTo(300, 0);
  });

  it('reads speed, breaking the line at the stop and marking it', () => {
    expect(s.speed![20]!).toBeCloseTo(1, 1);
    expect(s.speed![80]!).toBeCloseTo(2, 1);
    expect(s.speed![50]).toBeNull();
    expect(s.stopMarks).toHaveLength(1);
    expect(s.stopMarks[0]!.distanceM).toBeCloseTo(1000, -1);
    expect(s.stopMarks[0]!.durationS).toBeGreaterThan(500);
  });

  it('carries heart rate when the points have it', () => {
    expect(s.heartRate!.every((v) => v !== null && v >= 100 && v < 150)).toBe(true);
  });

  it('drops the speed series for an untimed route and HR/elevation when absent', () => {
    const route = walk([{ m: 1000, s: 1000 }], { timed: false }).map((p) => ({
      ...p,
      altitude: undefined,
    }));
    const r = buildChartSeries(route, buildTrackAxis(route), { timed: false });
    expect(r.speed).toBeNull();
    expect(r.heartRate).toBeNull();
    expect(r.elevation).toBeNull();
    expect(r.distances).toHaveLength(240);
  });

  it('drops implausible speeds (a GPS teleport)', () => {
    const pts = walk([{ m: 1000, s: 10 }]);
    const r = buildChartSeries(pts, buildTrackAxis(pts), { timed: true, samples: 10 });
    expect(r.speed).toBeNull();
  });
});

describe('sampleIndexAt', () => {
  it('finds the nearest sample, clamped', () => {
    const s = { distances: [0, 50, 100], totalM: 100 };
    expect(sampleIndexAt(s, 0)).toBe(0);
    expect(sampleIndexAt(s, 40)).toBe(1);
    expect(sampleIndexAt(s, 500)).toBe(2);
    expect(sampleIndexAt({ distances: [], totalM: 0 }, 5)).toBe(0);
  });
});

describe('heart rate helpers', () => {
  it('averages the points that carry a heart rate', () => {
    expect(
      averageHeartRate([
        { ...hike[0]!, heartRateBpm: 120 },
        { ...hike[1]!, heartRateBpm: 141 },
      ]),
    ).toBe(131);
    expect(averageHeartRate(walk([{ m: 10, s: 10 }]))).toBeNull();
  });

  it('bands the top of the outing as hard and moderate', () => {
    expect(heartRateBands([120, null, 170])).toEqual([
      { fromBpm: 153, toBpm: 170, label: 'hard' },
      { fromBpm: 136, toBpm: 153, label: 'moderate' },
    ]);
    expect(heartRateBands([null])).toEqual([]);
  });
});
