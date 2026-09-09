import type { TrackPoint } from '@core/models';
import { accumulateElevationGainLoss, computeTrackStats } from './index';
import {
  accumulateSegmentedElevation,
  computeSegmentedTrackStats,
  dropPointsDuringPauses,
  normalizeSegmentStarts,
  segmentIndexAt,
  segmentStartsFromPauses,
  splitSegments,
  startsNewSegment,
  totalPausedMs,
  type PauseInterval,
} from './segments';

const pt = (time: number, latitude = 46.8, altitude?: number): TrackPoint => ({
  latitude,
  longitude: -71.2,
  time,
  altitude,
});

// One pause from t=10 s to t=20 s.
const PAUSE: PauseInterval = { from: 10_000, to: 20_000 };

describe('pause intervals → segment membership', () => {
  it('assigns a fix to the segment after every pause that began before it', () => {
    const pauses = [PAUSE, { from: 30_000, to: 40_000 }];
    expect(segmentIndexAt(5_000, pauses)).toBe(0);
    expect(segmentIndexAt(10_000, pauses)).toBe(0); // the pause instant itself
    expect(segmentIndexAt(25_000, pauses)).toBe(1);
    expect(segmentIndexAt(45_000, pauses)).toBe(2);
  });

  it('keys on the pause START, so a fix stamped just before the resume tap still opens the new segment', () => {
    // Delivered after resume but computed 300 ms before the tap: it must not
    // be glued to the pre-pause fix — that is the exact A04 bridge.
    expect(startsNewSegment(pt(9_000), pt(19_700), [PAUSE])).toBe(true);
    expect(startsNewSegment(pt(9_000), pt(21_000), [PAUSE])).toBe(true);
  });

  it('is not a new segment without a pause in between, or without a predecessor', () => {
    expect(startsNewSegment(pt(1_000), pt(2_000), [PAUSE])).toBe(false);
    expect(startsNewSegment(pt(21_000), pt(22_000), [PAUSE])).toBe(false);
    expect(startsNewSegment(undefined, pt(22_000), [PAUSE])).toBe(false);
    expect(startsNewSegment(pt(1_000), pt(30_000), [])).toBe(false);
  });

  it('derives segment starts from a time-ordered point list', () => {
    const points = [pt(1_000), pt(2_000), pt(21_000), pt(22_000), pt(45_000)];
    const pauses = [PAUSE, { from: 30_000, to: 40_000 }];
    expect(segmentStartsFromPauses(points, pauses)).toEqual([2, 4]);
    expect(segmentStartsFromPauses(points, [])).toEqual([]);
    expect(segmentStartsFromPauses([], pauses)).toEqual([]);
  });

  it('a pause with no fixes after it adds no boundary', () => {
    expect(segmentStartsFromPauses([pt(1_000), pt(2_000)], [PAUSE])).toEqual([]);
  });

  it('sums completed pauses', () => {
    expect(totalPausedMs([])).toBe(0);
    expect(totalPausedMs([PAUSE, { from: 30_000, to: 40_500 }])).toBe(20_500);
  });
});

describe('dropPointsDuringPauses', () => {
  it('drops fixes stamped strictly inside a pause and keeps the rest, same reference when nothing drops', () => {
    const points = [pt(9_000), pt(10_000), pt(15_000), pt(20_000), pt(25_000)];
    expect(dropPointsDuringPauses(points, [PAUSE]).map((p) => p.time)).toEqual([
      9_000, 10_000, 20_000, 25_000,
    ]);
    const untouched = [pt(1_000), pt(25_000)];
    expect(dropPointsDuringPauses(untouched, [PAUSE])).toBe(untouched);
    expect(dropPointsDuringPauses(points, [])).toBe(points);
  });
});

describe('splitSegments / normalizeSegmentStarts', () => {
  it('cuts at the starts; no starts is one segment; nothing is no segments', () => {
    expect(splitSegments([1, 2, 3, 4, 5], [2, 4])).toEqual([[1, 2], [3, 4], [5]]);
    expect(splitSegments([1, 2, 3], [])).toEqual([[1, 2, 3]]);
    expect(splitSegments([], [1])).toEqual([]);
  });

  it('tolerates junk starts from disk: out of range, duplicates, unsorted, non-integers', () => {
    expect(normalizeSegmentStarts([4, 0, 2, 2, 7, -1, 1.5, NaN, 5], 5)).toEqual([2, 4]);
    expect(splitSegments([1, 2, 3], [0, 3, 10])).toEqual([[1, 2, 3]]);
  });
});

describe('computeSegmentedTrackStats', () => {
  // A 1 km relocation while paused: two legs 1 km apart, ~28 m each.
  const legA = [pt(0, 46.8, 100), pt(1_000, 46.80025, 101), pt(2_000, 46.8005, 102)];
  const legB = [pt(22_000, 46.8095, 150), pt(23_000, 46.80975, 151), pt(24_000, 46.81, 152)];
  const points = [...legA, ...legB];

  it('is exactly computeTrackStats for a single segment', () => {
    expect(computeSegmentedTrackStats(points, [])).toEqual(computeTrackStats(points));
    expect(computeSegmentedTrackStats([], [])).toEqual(computeTrackStats([]));
  });

  it('never bridges the boundary: distance, moving time, D± and duration are per-leg sums', () => {
    const flat = computeTrackStats(points);
    const segmented = computeSegmentedTrackStats(points, [3]);
    const a = computeTrackStats(legA);
    const b = computeTrackStats(legB);

    // The flat computation credits the ~1 km relocation and the 20 s pause.
    expect(flat.distanceM).toBeGreaterThan(1000);
    expect(flat.movingTimeS).toBeGreaterThan(20);
    expect(flat.ascentM).toBeGreaterThan(40);

    expect(segmented.distanceM).toBeCloseTo(a.distanceM + b.distanceM, 6);
    expect(segmented.distanceM).toBeLessThan(150); // two ~56 m legs, no 1 km hop
    expect(segmented.movingTimeS).toBe(a.movingTimeS + b.movingTimeS);
    expect(segmented.durationS).toBe(4);
    expect(segmented.ascentM).toBeCloseTo(a.ascentM + b.ascentM, 6);
    expect(segmented.descentM).toBe(0);
    expect(segmented.pointCount).toBe(6);
  });

  it('unions extents, takes the max speed and weights the average by moving time', () => {
    const s = computeSegmentedTrackStats(points, [3]);
    expect(s.bbox).toEqual({ minLat: 46.8, minLng: -71.2, maxLat: 46.81, maxLng: -71.2 });
    expect(s.minAltitudeM).toBe(100);
    expect(s.maxAltitudeM).toBe(152);
    const a = computeTrackStats(legA);
    const b = computeTrackStats(legB);
    expect(s.maxSpeedMps).toBeCloseTo(Math.max(a.maxSpeedMps, b.maxSpeedMps), 9);
    expect(s.avgSpeedMps).toBeCloseTo(
      (a.avgSpeedMps * a.movingTimeS + b.avgSpeedMps * b.movingTimeS) /
        (a.movingTimeS + b.movingTimeS),
      9,
    );
  });

  it('restarts the elevation hysteresis at a boundary (a pause on the summit is not a descent)', () => {
    const summit = [pt(0, 46.8, 500), pt(1_000, 46.8002, 504)];
    const valley = [pt(30_000, 46.9, 100), pt(31_000, 46.9002, 104)];
    const s = computeSegmentedTrackStats([...summit, ...valley], [2]);
    expect(s.descentM).toBe(0);
    expect(s.ascentM).toBe(8);
  });
});

describe('accumulateSegmentedElevation', () => {
  it('sums per-segment gain/loss and leaves the reference where the last segment ended', () => {
    const points = [
      pt(0, 46.8, 100),
      pt(1_000, 46.8, 110),
      pt(30_000, 46.9, 50),
      pt(31_000, 46.9, 45),
    ];
    const acc = accumulateSegmentedElevation(points, [2]);
    expect(acc.ascentM).toBe(10);
    expect(acc.descentM).toBe(5);
    expect(acc.reference).toBe(45);
    // Single segment: the plain accumulator.
    expect(accumulateSegmentedElevation(points, [])).toEqual(
      accumulateElevationGainLoss(points.map((p) => p.altitude)),
    );
  });
});
