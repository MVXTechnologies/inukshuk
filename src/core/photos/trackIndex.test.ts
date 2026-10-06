import { lineTrack, offset, outAndBack, T0 } from './__fixtures__/tracks';
import {
  indexTrack,
  passesNear,
  positionAtDistance,
  positionAtTime,
  timeAtDistance,
} from './trackIndex';

describe('indexTrack', () => {
  it('accumulates distance and knows the time span', () => {
    const idx = indexTrack(lineTrack({ lengthM: 1000 }));
    expect(idx.totalM).toBeCloseTo(1000, 0);
    expect(idx.startMs).toBe(T0);
    expect(idx.endMs).toBe(T0 + 1000 * 1000);
    expect(idx.timed).toHaveLength(101);
  });

  it('has no time span for an untimed (planned) route', () => {
    const idx = indexTrack(lineTrack({ lengthM: 500, untimed: true }));
    expect(idx.startMs).toBeUndefined();
    expect(idx.timed).toHaveLength(0);
    expect(positionAtTime(idx, T0)).toBeNull();
    expect(timeAtDistance(idx, 100)).toBeUndefined();
  });

  it('leaves out fixes whose clock went backwards', () => {
    const pts = lineTrack({ lengthM: 100 });
    pts[5] = { ...pts[5]!, time: T0 - 5000 };
    const idx = indexTrack(pts);
    expect(idx.timed).not.toContain(5);
    expect(idx.timed).toHaveLength(10);
  });

  it('copes with an empty or single-point trail', () => {
    const empty = indexTrack([]);
    expect(empty.totalM).toBe(0);
    expect(positionAtDistance(empty, 10)).toBeNull();
    expect(passesNear(empty, offset(0), 50)).toEqual([]);
    const one = indexTrack(lineTrack({ lengthM: 0 }));
    expect(one.startMs).toBeUndefined();
    expect(positionAtDistance(one, 10)!.distanceM).toBe(0);
    expect(passesNear(one, offset(5), 50)).toHaveLength(1);
    expect(passesNear(one, offset(500), 50)).toHaveLength(0);
  });
});

describe('positionAtDistance', () => {
  const idx = indexTrack(lineTrack({ lengthM: 1000, grade: 0.1 }));

  it('interpolates position and elevation', () => {
    const pos = positionAtDistance(idx, 255)!;
    expect(pos.distanceM).toBeCloseTo(255, 3);
    expect(pos.lngLat[0]).toBeCloseTo(offset(255)[0], 7);
    expect(pos.elevationM).toBeCloseTo(525.5, 3);
  });

  it('clamps to the ends', () => {
    expect(positionAtDistance(idx, -50)!.distanceM).toBe(0);
    expect(positionAtDistance(idx, 5000)!.distanceM).toBeCloseTo(1000, 0);
  });

  it('carries a missing elevation over from the neighbour', () => {
    const pts = lineTrack({ lengthM: 20 });
    delete pts[1]!.altitude;
    const pos = positionAtDistance(indexTrack(pts), 5)!;
    expect(pos.elevationM).toBe(500);
    const none = lineTrack({ lengthM: 20 }).map(({ altitude: _a, ...p }) => p);
    expect(positionAtDistance(indexTrack(none), 5)!.elevationM).toBeUndefined();
  });
});

describe('positionAtTime', () => {
  const idx = indexTrack(lineTrack({ lengthM: 1000 }));

  it('interpolates between the fixes around the time', () => {
    expect(positionAtTime(idx, T0 + 432_500)!.distanceM).toBeCloseTo(432.5, 3);
  });

  it('accepts times within the margin, clamped to the ends', () => {
    expect(positionAtTime(idx, T0 - 5 * 60_000)!.distanceM).toBe(0);
    expect(positionAtTime(idx, T0 + 1_000_000 + 5 * 60_000)!.distanceM).toBeCloseTo(1000, 0);
  });

  it('rejects times outside the margin', () => {
    expect(positionAtTime(idx, T0 - 11 * 60_000)).toBeNull();
    expect(positionAtTime(idx, T0 + 1_000_000 + 11 * 60_000)).toBeNull();
    expect(positionAtTime(idx, T0 - 1, { marginMs: 0 })).toBeNull();
  });

  it('puts a photo taken during a long pause at the nearer side of the gap', () => {
    const trail = outAndBack({ lengthM: 500, pauseS: 30 * 60 });
    const paused = indexTrack(trail);
    // 5 min into a 30-min stop at the far end: still at the turnaround.
    const mid = positionAtTime(paused, T0 + 500_000 + 5 * 60_000)!;
    expect(mid.distanceM).toBeCloseTo(500, 0);
    // 25 min in: the nearer side is the end of the pause — same spot, but the
    // distance is the one where the walk back starts.
    const late = positionAtTime(paused, T0 + 500_000 + 25 * 60_000)!;
    expect(late.distanceM).toBeCloseTo(500, 0);
  });

  it('does not interpolate across a gap in the middle of a walk', () => {
    const pts = lineTrack({ lengthM: 200 });
    // Lose the signal between 100 m and 110 m for 20 minutes.
    for (let i = 11; i < pts.length; i++) pts[i] = { ...pts[i]!, time: pts[i]!.time + 20 * 60_000 };
    const gap = indexTrack(pts);
    expect(positionAtTime(gap, T0 + 100_000 + 2 * 60_000)!.distanceM).toBeCloseTo(100, 3);
    expect(positionAtTime(gap, T0 + 100_000 + 19 * 60_000)!.distanceM).toBeCloseTo(110, 3);
  });
});

describe('timeAtDistance', () => {
  it('gives the time of the nearest timed fix', () => {
    const idx = indexTrack(lineTrack({ lengthM: 100 }));
    expect(timeAtDistance(idx, 42)).toBe(T0 + 40_000);
  });
});

describe('passesNear', () => {
  it('finds the closest point of the trail with its offset', () => {
    const idx = indexTrack(lineTrack({ lengthM: 1000 }));
    const [pass, ...rest] = passesNear(idx, offset(300, 12), 50);
    expect(rest).toHaveLength(0);
    expect(pass!.distanceM).toBeCloseTo(300, 0);
    expect(pass!.offTrackM).toBeCloseTo(12, 0);
  });

  it('returns nothing beyond the radius', () => {
    const idx = indexTrack(lineTrack({ lengthM: 1000 }));
    expect(passesNear(idx, offset(300, 80), 50)).toEqual([]);
  });

  it('returns one pass per visit on an out-and-back', () => {
    const idx = indexTrack(outAndBack({ lengthM: 1000 }));
    const passes = passesNear(idx, offset(300, 5), 50);
    expect(passes.map((p) => Math.round(p.distanceM))).toEqual([300, 1700]);
  });

  it('merges a turnaround into a single pass', () => {
    const idx = indexTrack(outAndBack({ lengthM: 1000 }));
    expect(passesNear(idx, offset(1000, 3), 30)).toHaveLength(1);
  });
});
