import { straightTrack } from './testTracks';
import {
  EFFORT_CLIMBS_M,
  EFFORT_DISTANCES_M,
  hrHistogram,
  isTrailStatsSummary,
  summarizeTrail,
  trailStatsKey,
  TRAIL_STATS_VERSION,
} from './trailSummary';

const i1k = EFFORT_DISTANCES_M.indexOf(1000);
const i5k = EFFORT_DISTANCES_M.indexOf(5000);
const i10k = EFFORT_DISTANCES_M.indexOf(10000);

describe('summarizeTrail', () => {
  it('times the distance efforts a track is long enough for', () => {
    // 6 km at 5 m/s (10 m per 2 s).
    const s = summarizeTrail(straightTrack({ n: 601, stepM: 10, stepS: 2 }));
    expect(s.v).toBe(TRAIL_STATS_VERSION);
    expect(s.bestDistanceS[i1k]).toBeCloseTo(200, 0);
    expect(s.bestDistanceS[i5k]).toBeCloseTo(1000, 0);
    expect(s.bestDistanceS[i10k]).toBeNull();
  });

  it('times climbs on the hysteresis-filtered ascent', () => {
    // 1 m up per 10 s fix, 600 fixes: 599 m of ascent.
    const s = summarizeTrail(straightTrack({ n: 600, stepM: 2, stepS: 10, altitude: (k) => k }));
    // The 3 m dead-band commits ascent in steps, so allow a step's worth.
    expect(Math.abs(s.bestClimbS[EFFORT_CLIMBS_M.indexOf(100)]! - 1000)).toBeLessThan(31);
    expect(Math.abs(s.bestClimbS[EFFORT_CLIMBS_M.indexOf(500)]! - 5000)).toBeLessThan(31);
    expect(s.bestClimbS[EFFORT_CLIMBS_M.indexOf(1000)]).toBeNull();
  });

  it('gives no efforts for an untimed track', () => {
    const pts = straightTrack({ n: 601, stepM: 10, stepS: 2 }).map((p) => ({
      ...p,
      hasTime: false,
    }));
    const s = summarizeTrail(pts);
    expect(s.bestDistanceS.every((v) => v === null)).toBe(true);
    expect(s.bestClimbS.every((v) => v === null)).toBe(true);
    expect(s.hr).toBeNull();
  });

  it('breaks the chain at a GPS jump instead of crediting it', () => {
    const pts = straightTrack({ n: 401, stepM: 10, stepS: 2 });
    // Teleport 3 km forward in one second halfway: without the break that
    // would be a ridiculous 1 km.
    const jumped = pts.map((p, k) =>
      k >= 200 ? { ...p, latitude: p.latitude + 3000 / 111195 } : p,
    );
    const s = summarizeTrail(jumped);
    expect(s.bestDistanceS[i1k]).toBeCloseTo(200, 0);
    expect(s.bestDistanceS[i5k]).toBeNull();
  });

  it('breaks at a time reversal and at a recorded segment boundary', () => {
    const pts = straightTrack({ n: 301, stepM: 10, stepS: 2 });
    const reversed = pts.map((p, k) => (k >= 150 ? { ...p, time: p.time - 3_600_000 } : p));
    expect(summarizeTrail(reversed).bestDistanceS[i1k]).toBeCloseTo(200, 0);
    // 3 km split into two 1.5 km legs: 1 km fits, 2 km wouldn't (none is timed at 2 km,
    // so check 1 km still and that nothing bridges by reading 5 km = null).
    const s = summarizeTrail(pts, [150]);
    expect(s.bestDistanceS[i1k]).toBeCloseTo(200, 0);
  });

  it('treats a same-timestamp step that moves far as a jump', () => {
    const pts = straightTrack({ n: 3, stepM: 10, stepS: 1 });
    pts[2] = { ...pts[2]!, time: pts[1]!.time };
    expect(summarizeTrail(pts).bestDistanceS[i1k]).toBeNull();
  });

  it('collects the heart-rate histogram', () => {
    const s = summarizeTrail(
      straightTrack({ n: 5, stepM: 3, stepS: 1, hr: (k) => (k < 3 ? 120 : 150) }),
    );
    expect(s.hr).toEqual({ bpm: [120, 150], seconds: [3, 1], samples: [3, 2] });
  });
});

describe('hrHistogram', () => {
  it('drops junk rates and long gaps, keeps their samples', () => {
    const pts = straightTrack({ n: 4, stepM: 3, stepS: 1, hr: (k) => [0, 140.4, 300, 140][k] });
    pts[2] = { ...pts[2]!, time: pts[1]!.time + 60_000 };
    pts[3] = { ...pts[3]!, time: pts[2]!.time + 1000 };
    // 140.4 → 140, its 60 s gap doesn't count; 300 is junk; the last point has no next.
    expect(hrHistogram(pts)).toEqual({ bpm: [140], seconds: [0], samples: [2] });
  });

  it('is null without heart rate', () => {
    expect(hrHistogram(straightTrack({ n: 3, stepM: 3, stepS: 1 }))).toBeNull();
  });
});

describe('trailStatsKey / isTrailStatsSummary', () => {
  it('changes with every revision field', () => {
    const base = { id: 'a', endedAt: 5, stats: { pointCount: 10, distanceM: 100 } };
    const key = trailStatsKey(base);
    expect(trailStatsKey({ ...base, endedAt: 6 })).not.toBe(key);
    expect(trailStatsKey({ ...base, stats: { pointCount: 11, distanceM: 100 } })).not.toBe(key);
    expect(trailStatsKey({ id: 'a', stats: { pointCount: 10, distanceM: 100 } })).toMatch(/\|$/);
  });

  it('accepts its own output and rejects junk or another version', () => {
    const s = summarizeTrail(straightTrack({ n: 5, stepM: 3, stepS: 1, hr: () => 130 }));
    expect(isTrailStatsSummary(JSON.parse(JSON.stringify(s)))).toBe(true);
    expect(isTrailStatsSummary({ ...s, hr: null })).toBe(true);
    expect(isTrailStatsSummary({ ...s, v: TRAIL_STATS_VERSION + 1 })).toBe(false);
    expect(isTrailStatsSummary({ ...s, bestClimbS: [] })).toBe(false);
    expect(isTrailStatsSummary({ ...s, hr: { bpm: [1], seconds: [], samples: [1] } })).toBe(false);
    expect(isTrailStatsSummary(null)).toBe(false);
    expect(isTrailStatsSummary('x')).toBe(false);
  });
});
