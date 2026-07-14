import type { TrackNote, TrackPoint } from '@core/models';

import { mergeTracks, retargetNotesAfterTrim, sliceTrack } from './edit';

const pt = (latitude: number, longitude: number, time = 0, altitude?: number): TrackPoint => ({
  latitude,
  longitude,
  time,
  ...(altitude !== undefined ? { altitude } : {}),
});

const note = (id: string, distanceM: number, text = 'n'): TrackNote => ({
  id,
  distanceM,
  text,
  createdAt: 1,
});

const T0 = Date.parse('2024-01-01T10:00:00Z');
const MIN = 60_000;

describe('mergeTracks', () => {
  it('orders sources by start timestamp when all are timed (stable on ties)', () => {
    const afternoon = { name: 'B', points: [pt(2, 2, T0 + 60 * MIN), pt(2.1, 2.1, T0 + 61 * MIN)] };
    const morning = { name: 'A', points: [pt(1, 1, T0), pt(1.1, 1.1, T0 + MIN)] };
    const merged = mergeTracks([afternoon, morning]);
    expect(merged.name).toBe('Merged: A + B');
    expect(merged.points.map((p) => p.latitude)).toEqual([1, 1.1, 2, 2.1]);
    expect(merged.stats.pointCount).toBe(4);
  });

  it('keeps user order when any source lacks timestamps', () => {
    const timed = { name: 'Timed', points: [pt(1, 1, T0)] };
    const untimed = { name: 'Untimed', points: [pt(2, 2, 0)] };
    const merged = mergeTracks([untimed, timed]);
    expect(merged.name).toBe('Merged: Untimed + Timed');
    expect(merged.points.map((p) => p.latitude)).toEqual([2, 1]);
  });

  it('keeps user order for all-untimed sources', () => {
    const a = { name: 'A', points: [pt(5, 5)] };
    const b = { name: 'B', points: [pt(6, 6)] };
    expect(mergeTracks([b, a]).points.map((p) => p.latitude)).toEqual([6, 5]);
  });

  it('a leading time:0 point does not count as a timestamp for ordering', () => {
    // startTime must skip the 0-time fix and find the first real timestamp.
    const late = { name: 'Late', points: [pt(9, 9, 0), pt(9.1, 9.1, T0 + 60 * MIN)] };
    const early = { name: 'Early', points: [pt(8, 8, T0)] };
    const merged = mergeTracks([late, early]);
    expect(merged.points.map((p) => p.latitude)).toEqual([8, 9, 9.1]);
  });

  it('concatenates waypoints in merge order and recomputes stats', () => {
    const a = {
      name: 'A',
      points: [pt(45.0, -73.0, T0, 100), pt(45.001, -73.0, T0 + MIN, 110)],
      waypoints: [{ latitude: 45.0005, longitude: -73.0, name: 'wA' }],
    };
    const b = {
      name: 'B',
      points: [pt(45.002, -73.0, T0 + 2 * MIN, 120), pt(45.003, -73.0, T0 + 3 * MIN, 115)],
      waypoints: [{ latitude: 45.0025, longitude: -73.0, name: 'wB' }],
    };
    const merged = mergeTracks([b, a]); // user picked B first; timestamps put A first
    expect(merged.waypoints.map((w) => w.name)).toEqual(['wA', 'wB']);
    expect(merged.stats.pointCount).toBe(4);
    // ~111m per 0.001° of latitude, 3 segments ≈ 333m.
    expect(merged.stats.distanceM).toBeGreaterThan(300);
    expect(merged.stats.distanceM).toBeLessThan(370);
    expect(merged.stats.ascentM).toBeGreaterThan(0);
  });

  it('skips empty sources (name and points) and handles an all-empty merge', () => {
    const empty = { name: 'Empty', points: [] as TrackPoint[] };
    const a = { name: 'A', points: [pt(1, 1)] };
    const merged = mergeTracks([empty, a]);
    expect(merged.name).toBe('Merged: A');
    expect(merged.points).toHaveLength(1);

    const nothing = mergeTracks([empty]);
    expect(nothing.name).toBe('Merged trail');
    expect(nothing.points).toHaveLength(0);
    expect(nothing.stats.pointCount).toBe(0);
    expect(mergeTracks([]).points).toHaveLength(0);
  });

  it('falls back to a generic name when sources are unnamed', () => {
    const merged = mergeTracks([{ name: '  ', points: [pt(1, 1)] }]);
    expect(merged.name).toBe('Merged trail');
  });

  it('keeps per-point timestamps verbatim', () => {
    const a = { name: 'A', points: [pt(1, 1, T0), pt(1.1, 1.1, T0 + MIN)] };
    const merged = mergeTracks([a]);
    expect(merged.points.map((p) => p.time)).toEqual([T0, T0 + MIN]);
  });
});

describe('sliceTrack', () => {
  const points = [
    pt(45.0, -73.0, T0, 100),
    pt(45.001, -73.0, T0 + MIN, 105),
    pt(45.002, -73.0, T0 + 2 * MIN, 112),
    pt(45.003, -73.0, T0 + 3 * MIN, 120),
    pt(45.004, -73.0, T0 + 4 * MIN, 118),
  ];

  it('keeps the inclusive [startIdx, endIdx] window and recomputes stats', () => {
    const { points: kept, stats } = sliceTrack(points, 1, 3);
    expect(kept.map((p) => p.latitude)).toEqual([45.001, 45.002, 45.003]);
    expect(stats.pointCount).toBe(3);
    expect(stats.durationS).toBe(120); // timestamps kept verbatim
    expect(kept[0]!.time).toBe(T0 + MIN);
    // 2 segments of ~111m each.
    expect(stats.distanceM).toBeGreaterThan(200);
    expect(stats.distanceM).toBeLessThan(240);
  });

  it('is a no-op when the window covers everything', () => {
    const { points: kept, stats } = sliceTrack(points, 0, points.length - 1);
    expect(kept).toEqual(points);
    expect(stats.pointCount).toBe(points.length);
  });

  it('clamps out-of-range indices instead of throwing', () => {
    const { points: kept } = sliceTrack(points, -10, 999);
    expect(kept).toHaveLength(points.length);
    const { points: tail } = sliceTrack(points, 3.9, 999); // fractional start floors
    expect(tail.map((p) => p.latitude)).toEqual([45.003, 45.004]);
  });

  it('returns empty for inverted or fully out-of-range windows', () => {
    expect(sliceTrack(points, 3, 1).points).toHaveLength(0);
    expect(sliceTrack(points, 99, 120).points).toHaveLength(0);
    expect(sliceTrack(points, 3, 1).stats.pointCount).toBe(0);
  });

  it('handles empty input and single-point windows', () => {
    expect(sliceTrack([], 0, 0).points).toHaveLength(0);
    expect(sliceTrack([], 0, 0).stats.distanceM).toBe(0);
    const single = sliceTrack(points, 2, 2);
    expect(single.points).toHaveLength(1);
    expect(single.stats.distanceM).toBe(0);
  });

  it('works on untimed tracks (all time:0)', () => {
    const untimed = [pt(1, 1), pt(1.001, 1), pt(1.002, 1)];
    const { points: kept, stats } = sliceTrack(untimed, 0, 1);
    expect(kept).toHaveLength(2);
    expect(stats.durationS).toBe(0);
    expect(stats.distanceM).toBeGreaterThan(0);
  });
});

describe('retargetNotesAfterTrim', () => {
  // 4 equal ~111m segments along a meridian: anchors are easy to reason about.
  const points = [
    pt(45.0, -73.0),
    pt(45.001, -73.0),
    pt(45.002, -73.0),
    pt(45.003, -73.0),
    pt(45.004, -73.0),
  ];
  const segM = 111.2; // approx metres per 0.001° latitude

  it('shifts kept notes left by the cut distance and drops out-of-range ones', () => {
    const notes = [
      note('before', 0.2 * segM),
      note('inside', 1.5 * segM),
      note('after', 3.5 * segM),
    ];
    const { kept, dropped } = retargetNotesAfterTrim(notes, points, 1, 3);
    expect(dropped.map((n) => n.id)).toEqual(['before', 'after']);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.id).toBe('inside');
    expect(kept[0]!.distanceM).toBeCloseTo(0.5 * segM, -1);
  });

  it('keeps notes anchored exactly at the trim boundaries', () => {
    const startM = segM; // cumulative distance to index 1
    const endM = 3 * segM;
    const { kept } = retargetNotesAfterTrim([note('a', startM), note('b', endM)], points, 1, 3);
    expect(kept.map((n) => n.id)).toEqual(['a', 'b']);
    expect(kept[0]!.distanceM).toBeCloseTo(0, 0);
  });

  it('drops everything when the window is empty and handles no points', () => {
    const notes = [note('x', 10)];
    expect(retargetNotesAfterTrim(notes, points, 3, 1).dropped).toHaveLength(1);
    expect(retargetNotesAfterTrim(notes, [], 0, 0).dropped).toHaveLength(1);
    expect(retargetNotesAfterTrim([], points, 0, 4)).toEqual({ kept: [], dropped: [] });
  });
});
