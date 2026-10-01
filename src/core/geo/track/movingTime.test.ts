import type { TrackPoint } from '@core/models';

import { computeTrackStats, haversineMeters } from './index';
import {
  classifyMovingSteps,
  classifySegmentedSteps,
  computeMovingTime,
  hasCurrentMovingStats,
  MOVING_MODEL_VERSION,
  movingModelKey,
  movingProfileFor,
  STEP_BREAK,
  STEP_GAP,
  STEP_INVALID,
  STEP_MOVING,
  trailTiming,
} from './movingTime';
import { computeSegmentedTrackStats } from './segments';

/** Metres per degree of latitude (close enough for synthetic tracks). */
const M_PER_DEG_LAT = 111_195;
const LAT0 = 46.8;
const LNG0 = -71.2;
const T0 = 1_700_000_000_000;

/** Deterministic PRNG so jitter tests are reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

/**
 * Build a 1 Hz (by default) track from phases. A phase moves north at
 * `speed` m/s for `seconds`; `jitterM` adds uniform ±jitter metres of GPS
 * noise to every fix in that phase.
 */
interface Phase {
  seconds: number;
  speed: number;
  jitterM?: number;
}

function track(phases: Phase[], opts?: { stepS?: number; seed?: number }): TrackPoint[] {
  const stepS = opts?.stepS ?? 1;
  const rand = rng(opts?.seed ?? 42);
  const pts: TrackPoint[] = [];
  let northM = 0;
  let t = 0;
  const push = (jitterM: number) => {
    const jn = jitterM ? (rand() * 2 - 1) * jitterM : 0;
    const je = jitterM ? (rand() * 2 - 1) * jitterM : 0;
    pts.push({
      latitude: LAT0 + (northM + jn) / M_PER_DEG_LAT,
      longitude: LNG0 + je / (M_PER_DEG_LAT * Math.cos((LAT0 * Math.PI) / 180)),
      time: T0 + t * 1000,
    });
  };
  push(phases[0]?.jitterM ?? 0);
  for (const ph of phases) {
    for (let s = stepS; s <= ph.seconds; s += stepS) {
      northM += ph.speed * stepS;
      t += stepS;
      push(ph.jitterM ?? 0);
    }
  }
  return pts;
}

describe('movingProfileFor', () => {
  it('maps built-in categories to activity thresholds', () => {
    expect(movingProfileFor('hike').stopSpeedMps).toBe(0.5);
    expect(movingProfileFor('walk').id).toBe('foot');
    expect(movingProfileFor('run').stopSpeedMps).toBe(1);
    expect(movingProfileFor('trail-run').stopSpeedMps).toBeLessThan(1);
    expect(movingProfileFor('bike').stopSpeedMps).toBe(1.5);
    expect(movingProfileFor('ski').display).toBe('speed');
    expect(movingProfileFor('kayak').id).toBe('paddle');
  });

  it('falls back to on-foot for uncategorized and custom categories', () => {
    expect(movingProfileFor(undefined).id).toBe('foot');
    expect(movingProfileFor(null).id).toBe('foot');
    expect(movingProfileFor('custom-abc123').id).toBe('foot');
    expect(movingProfileFor('').display).toBe('pace');
  });
});

describe('movingModelKey / hasCurrentMovingStats', () => {
  it('stamps the algorithm version and profile', () => {
    expect(movingModelKey('bike')).toBe(`v${MOVING_MODEL_VERSION}:bike`);
    expect(movingModelKey(undefined)).toBe(`v${MOVING_MODEL_VERSION}:foot`);
  });

  it('flags legacy stats and a changed category as stale', () => {
    expect(hasCurrentMovingStats({}, 'hike')).toBe(false);
    expect(hasCurrentMovingStats({ movingModel: movingModelKey('hike') }, 'hike')).toBe(true);
    // Hike and walk share a profile: re-filing between them needs no recompute.
    expect(hasCurrentMovingStats({ movingModel: movingModelKey('hike') }, 'walk')).toBe(true);
    expect(hasCurrentMovingStats({ movingModel: movingModelKey('hike') }, 'bike')).toBe(false);
    expect(hasCurrentMovingStats({ movingModel: 'v0:foot' }, 'hike')).toBe(false);
  });
});

describe('computeMovingTime', () => {
  it('counts a continuous walk in full', () => {
    const pts = track([{ seconds: 1800, speed: 1.3 }]);
    const r = computeMovingTime(pts);
    expect(r.movingTimeS).toBe(1800);
    expect(r.movingDistanceM).toBeCloseTo(1800 * 1.3, -1);
  });

  it('excludes a 5-minute stop in the middle of a walk', () => {
    const pts = track([
      { seconds: 600, speed: 1.3 },
      { seconds: 300, speed: 0 },
      { seconds: 600, speed: 1.3 },
    ]);
    const r = computeMovingTime(pts);
    // The smoothing window blurs each edge of the stop by a few seconds.
    expect(Math.abs(r.movingTimeS - 1200)).toBeLessThanOrEqual(12);
    const stats = computeTrackStats(pts, { category: 'hike' });
    expect(stats.durationS).toBe(1500);
    expect(stats.movingTimeS).toBe(r.movingTimeS);
    expect(stats.avgSpeedMps).toBeCloseTo(1.3, 1);
  });

  it('does not count GPS drift while stopped as moving', () => {
    const pts = track([
      // Real moving fixes are smooth-ish (chip filtering); a parked phone
      // wanders in metres.
      { seconds: 600, speed: 1.3, jitterM: 0.3 },
      { seconds: 300, speed: 0, jitterM: 4 },
      { seconds: 600, speed: 1.3, jitterM: 0.3 },
    ]);
    const r = computeMovingTime(pts);
    expect(Math.abs(r.movingTimeS - 1200)).toBeLessThanOrEqual(20);
    // The naive per-step rule would have booked nearly the whole stop: ±4 m
    // jitter at 1 Hz is several m/s of apparent speed per step.
    let naiveStopSteps = 0;
    for (let i = 601; i <= 900; i++) {
      const step = haversineMeters(pts[i - 1]!, pts[i]!);
      if (step >= 0.5) naiveStopSteps += 1;
    }
    expect(naiveStopSteps).toBeGreaterThan(250);
    // And the drift doesn't inflate the moving speed.
    expect(r.movingDistanceM / r.movingTimeS).toBeLessThan(1.6);
  });

  it('does not count slowly wandering (correlated) drift while stopped', () => {
    // A parked phone's error is not white noise: it wanders, mean-reverting,
    // ~4 m per axis with a ~5 s memory — metres per second of fake motion.
    const rand = rng(3);
    const pts: TrackPoint[] = [];
    let north = 0;
    let dn = 0;
    let de = 0;
    for (let i = 0; i <= 1500; i++) {
      const stopped = i > 600 && i <= 900;
      if (!stopped && i > 0) north += 1.3;
      dn = 0.8 * dn + (rand() * 2 - 1) * (stopped ? 4 : 0.3);
      de = 0.8 * de + (rand() * 2 - 1) * (stopped ? 4 : 0.3);
      pts.push({
        latitude: LAT0 + (north + dn) / M_PER_DEG_LAT,
        longitude: LNG0 + de / (M_PER_DEG_LAT * Math.cos((LAT0 * Math.PI) / 180)),
        time: T0 + i * 1000,
      });
    }
    expect(Math.abs(computeMovingTime(pts).movingTimeS - 1200)).toBeLessThanOrEqual(30);
  });

  it('keeps a whole stop of pure drift (no motion at all) at ~zero moving time', () => {
    const pts = track([{ seconds: 600, speed: 0, jitterM: 5 }], { seed: 7 });
    expect(computeMovingTime(pts).movingTimeS).toBeLessThanOrEqual(15);
  });

  it('keeps a brief hesitation shorter than the minimum stop', () => {
    const pts = track([
      { seconds: 300, speed: 1.3 },
      { seconds: 8, speed: 0 },
      { seconds: 300, speed: 1.3 },
    ]);
    expect(computeMovingTime(pts).movingTimeS).toBe(608);
  });

  it('excludes long gaps with no fixes (auto-pause / signal loss)', () => {
    const walk = track([{ seconds: 300, speed: 1.3 }]);
    const last = walk[walk.length - 1]!;
    // 10 minutes with no fix, then 300 s more walking from the same place.
    const after = track([{ seconds: 300, speed: 1.3 }]).map((p) => ({
      ...p,
      latitude: p.latitude + (last.latitude - LAT0) + 1 / M_PER_DEG_LAT,
      time: p.time + (last.time - T0) + 600_000,
    }));
    const r = computeMovingTime([...walk, ...after]);
    expect(r.movingTimeS).toBe(600);
  });

  it('gives sparse recorders a proportionally longer gap limit', () => {
    // One fix every 30 s at walking pace: no step is a gap.
    const pts = track([{ seconds: 1800, speed: 1.3 }], { stepS: 30 });
    expect(computeMovingTime(pts).movingTimeS).toBe(1800);
  });

  it('removes red-light stops from a bike ride', () => {
    const pts = track([
      { seconds: 300, speed: 7 },
      { seconds: 45, speed: 0, jitterM: 2 },
      { seconds: 300, speed: 7 },
      { seconds: 60, speed: 0, jitterM: 2 },
      { seconds: 300, speed: 7 },
    ]);
    const bike = movingProfileFor('bike').stopSpeedMps;
    const r = computeMovingTime(pts, { stopSpeedMps: bike });
    expect(Math.abs(r.movingTimeS - 900)).toBeLessThanOrEqual(20);
    expect(r.movingDistanceM / r.movingTimeS).toBeCloseTo(7, 0);
  });

  it('uses the activity threshold: a 1 m/s crawl is moving on foot, stopped on a bike', () => {
    const pts = track([{ seconds: 120, speed: 1 }]);
    expect(computeTrackStats(pts, { category: 'hike' }).movingTimeS).toBe(120);
    expect(computeTrackStats(pts, { category: 'bike' }).movingTimeS).toBe(0);
  });

  it('handles empty, single-point and untimed tracks', () => {
    expect(computeMovingTime([])).toEqual({ movingTimeS: 0, movingDistanceM: 0 });
    const one = track([{ seconds: 0, speed: 0 }]);
    expect(one).toHaveLength(1);
    expect(computeMovingTime(one)).toEqual({ movingTimeS: 0, movingDistanceM: 0 });
    const untimed = track([{ seconds: 60, speed: 2 }]).map((p) => ({
      ...p,
      time: 0,
      hasTime: false,
    }));
    expect(computeMovingTime(untimed).movingTimeS).toBe(0);
  });

  it('ignores steps that go back in time', () => {
    const pts = track([{ seconds: 60, speed: 1.3 }]);
    const shuffled = [...pts.slice(0, 30), { ...pts[10]! }, ...pts.slice(30)];
    // The backwards step splits the run; both halves still count.
    expect(computeMovingTime(shuffled).movingTimeS).toBeGreaterThanOrEqual(58);
  });

  it('unwraps longitude across the antimeridian', () => {
    const pts: TrackPoint[] = [];
    for (let i = 0; i <= 120; i++) {
      // ~1.5 m/s eastward through 180°.
      const lng = 179.9995 + (i * 1.5) / (M_PER_DEG_LAT * Math.cos(0));
      pts.push({ latitude: 0, longitude: lng > 180 ? lng - 360 : lng, time: T0 + i * 1000 });
    }
    expect(computeMovingTime(pts).movingTimeS).toBe(120);
  });
});

describe('segmented stats', () => {
  it('never counts the pause between <trkseg> segments', () => {
    const a = track([{ seconds: 300, speed: 1.3 }]);
    const lastA = a[a.length - 1]!;
    // Resume 20 minutes later, 2 km away (a drive between trailheads).
    const b = track([{ seconds: 300, speed: 1.3 }]).map((p) => ({
      ...p,
      latitude: p.latitude + 2000 / M_PER_DEG_LAT,
      time: p.time + (lastA.time - T0) + 1_200_000,
    }));
    const stats = computeSegmentedTrackStats([...a, ...b], [a.length], { category: 'hike' });
    expect(stats.movingTimeS).toBe(600);
    expect(stats.durationS).toBe(600);
    expect(stats.movingModel).toBe(movingModelKey('hike'));
  });

  it('stamps the model on single-segment and empty stats too', () => {
    expect(computeSegmentedTrackStats([], [], { category: 'run' }).movingModel).toBe(
      movingModelKey('run'),
    );
    expect(computeTrackStats(track([{ seconds: 10, speed: 2 }])).movingModel).toBe(
      movingModelKey(undefined),
    );
  });

  it('does not stamp stats computed with an overridden threshold', () => {
    const s = computeTrackStats(track([{ seconds: 10, speed: 2 }]), {
      movingSpeedThresholdMps: 0.2,
    });
    expect(s.movingModel).toBeUndefined();
  });
});

describe('trailTiming', () => {
  const base = { distanceM: 6000, durationS: 3600, movingTimeS: 3000, avgSpeedMps: 2 };

  it('returns elapsed and moving averages, pace for foot activities', () => {
    const t = trailTiming(base, 'hike');
    expect(t).toEqual({
      elapsedS: 3600,
      movingTimeS: 3000,
      display: 'pace',
      elapsedSpeedMps: 6000 / 3600,
      movingSpeedMps: 2,
    });
  });

  it('shows speed for bike rides', () => {
    expect(trailTiming(base, 'bike')?.display).toBe('speed');
  });

  it('falls back to distance ÷ moving time when no moving average is stored', () => {
    expect(trailTiming({ ...base, avgSpeedMps: 0 }, 'run')?.movingSpeedMps).toBe(2);
  });

  it('is null for an untimed trail', () => {
    expect(trailTiming({ ...base, durationS: 0, movingTimeS: 0 }, 'navigation')).toBeNull();
  });

  it('tolerates junk numbers', () => {
    const t = trailTiming({ distanceM: NaN, durationS: 60, movingTimeS: NaN, avgSpeedMps: NaN });
    expect(t).toEqual({
      elapsedS: 60,
      movingTimeS: 0,
      display: 'pace',
      elapsedSpeedMps: 0,
      movingSpeedMps: 0,
    });
  });
});

describe('classifySegmentedSteps (#511)', () => {
  it('marks the step into each segment as a break and classifies the rest per segment', () => {
    const mk = (t: number, lat: number) => ({ latitude: lat, longitude: -71.2, time: t * 1000 });
    const pts = [mk(0, 46.8), mk(10, 46.8001), mk(20, 46.8002), mk(4000, 46.81), mk(4010, 46.8101)];
    const steps = classifySegmentedSteps(pts, [3, 3, 0, 99]);
    expect(Array.from(steps)).toEqual([
      STEP_INVALID,
      STEP_MOVING,
      STEP_MOVING,
      STEP_BREAK,
      STEP_MOVING,
    ]);
  });

  it('flags a long fix gap and a backwards step', () => {
    const mk = (t: number, lat: number) => ({ latitude: lat, longitude: -71.2, time: t * 1000 });
    const pts = [
      mk(0, 46.8),
      mk(10, 46.8001),
      mk(20, 46.8002),
      mk(30, 46.8003),
      mk(500, 46.801),
      mk(400, 46.8011),
    ];
    const steps = classifyMovingSteps(pts);
    expect(steps[4]).toBe(STEP_GAP);
    expect(steps[5]).toBe(STEP_INVALID);
  });
});
