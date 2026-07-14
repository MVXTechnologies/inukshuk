import { createHeadingFilter, normalizeDeg, signedDeltaDeg, unwrapDeg } from './heading';

describe('normalizeDeg', () => {
  it('wraps into [0, 360)', () => {
    expect(normalizeDeg(0)).toBe(0);
    expect(normalizeDeg(360)).toBe(0);
    expect(normalizeDeg(370)).toBe(10);
    expect(normalizeDeg(-10)).toBe(350);
    expect(normalizeDeg(-370)).toBe(350);
  });
});

describe('signedDeltaDeg', () => {
  it('returns the shortest signed arc', () => {
    expect(signedDeltaDeg(10, 30)).toBeCloseTo(20, 10);
    expect(signedDeltaDeg(30, 10)).toBeCloseTo(-20, 10);
    expect(signedDeltaDeg(90, 90)).toBe(0);
  });

  it('crosses the 0/360 boundary the short way', () => {
    expect(signedDeltaDeg(350, 10)).toBeCloseTo(20, 10);
    expect(signedDeltaDeg(10, 350)).toBeCloseTo(-20, 10);
    expect(signedDeltaDeg(359.5, 0.5)).toBeCloseTo(1, 10);
    expect(signedDeltaDeg(0.5, 359.5)).toBeCloseTo(-1, 10);
  });

  it('returns +180 for antipodal headings (both directions)', () => {
    expect(signedDeltaDeg(0, 180)).toBe(180);
    expect(signedDeltaDeg(180, 0)).toBe(180);
    expect(signedDeltaDeg(90, 270)).toBe(180);
  });

  it('accepts unnormalized inputs', () => {
    expect(signedDeltaDeg(-10, 370)).toBeCloseTo(20, 10);
    expect(signedDeltaDeg(720, 361)).toBeCloseTo(1, 10);
  });
});

describe('unwrapDeg', () => {
  it('continues past 360 instead of jumping back to 0', () => {
    expect(unwrapDeg(350, 10)).toBeCloseTo(370, 10);
    expect(unwrapDeg(370, 30)).toBeCloseTo(390, 10);
  });

  it('continues below 0 instead of jumping to 350', () => {
    expect(unwrapDeg(10, 350)).toBeCloseTo(-10, 10);
    expect(unwrapDeg(-10, 330)).toBeCloseTo(-30, 10);
  });

  it('is a no-op when the heading equals the previous angle mod 360', () => {
    expect(unwrapDeg(725, 5)).toBeCloseTo(725, 10);
    expect(unwrapDeg(-355, 5)).toBeCloseTo(-355, 10);
  });

  it('a long random walk never jumps more than 180 between steps', () => {
    let continuous = 0;
    let heading = 0;
    for (let i = 0; i < 500; i++) {
      heading = normalizeDeg(heading + Math.sin(i * 0.7) * 170);
      const next = unwrapDeg(continuous, heading);
      expect(Math.abs(next - continuous)).toBeLessThanOrEqual(180);
      expect(normalizeDeg(next)).toBeCloseTo(heading, 8);
      continuous = next;
    }
  });
});

// ---------------------------------------------------------------------------
// A simulator of the real Android heading stream, so the acceptance criteria
// below are measured against what the device actually delivers (see the module
// header of ./heading):
//
// - azimuth derived from raw accelerometer + magnetometer → several degrees of
//   zero-mean noise even when the phone is flat on a table;
// - the native module drops any reading within ~2° of the last one it *sent*,
//   and rate-limits to 50 ms — so at rest the app is fed a stream consisting
//   entirely of ≥2° noise excursions.
// ---------------------------------------------------------------------------

/** Deterministic gaussian noise (Box–Muller over a seeded LCG). */
function gaussian(seed: number): () => number {
  let s = seed >>> 0;
  const next = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s >>> 8) / 16777216 || 1e-9;
  };
  return () => Math.sqrt(-2 * Math.log(next())) * Math.cos(2 * Math.PI * next());
}

interface StreamOptions {
  /** True heading (deg) as a function of elapsed time (ms). */
  truth: (tMs: number) => number;
  durationMs: number;
  /** Std-dev of the raw magnetometer/accelerometer azimuth noise (deg). */
  noiseDeg: number;
  /** Sensor tick — how often the native module evaluates a new azimuth. */
  tickMs?: number;
  seed?: number;
}

/** The samples an app really receives from `Location.watchHeadingAsync` on Android. */
function androidHeadingStream(o: StreamOptions): { degrees: number; timestampMs: number }[] {
  const { truth, durationMs, noiseDeg, tickMs = 100, seed = 12345 } = o;
  const noise = gaussian(seed);
  const out: { degrees: number; timestampMs: number }[] = [];
  let lastSentRaw: number | null = null;
  let lastSentAt = -Infinity;
  for (let t = 0; t <= durationMs; t += tickMs) {
    const raw = normalizeDeg(truth(t) + noise() * noiseDeg);
    const movedEnough = lastSentRaw === null || Math.abs(signedDeltaDeg(lastSentRaw, raw)) > 2.03; // DEGREE_DELTA
    if (movedEnough && t - lastSentAt > 50) {
      lastSentRaw = raw;
      lastSentAt = t;
      out.push({ degrees: raw, timestampMs: t });
    }
  }
  return out;
}

/** Peak-to-peak spread of a set of headings, taking the circular short way. */
function peakToPeakDeg(headings: readonly number[]): number {
  const first = headings[0];
  if (first === undefined) return 0;
  let lo = 0;
  let hi = 0;
  for (const h of headings) {
    const d = signedDeltaDeg(first, h);
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  return hi - lo;
}

describe('createHeadingFilter', () => {
  it('returns the first sample verbatim; value() is null before it', () => {
    const f = createHeadingFilter();
    expect(f.value()).toBeNull();
    expect(f.push({ degrees: 42, timestampMs: 0 })).toBeCloseTo(42, 6);
    expect(f.value()).toBeCloseTo(42, 6);
  });

  it('normalizes out-of-range input', () => {
    const f = createHeadingFilter();
    expect(f.push({ degrees: -90, timestampMs: 0 })).toBeCloseTo(270, 6);
    expect(f.push({ degrees: 630, timestampMs: 100 })).toBeCloseTo(270, 6);
  });

  // ---- THE acceptance criterion the user cares about -----------------------
  it('is rock-steady at rest: a real noisy Android stream stays < 1° peak-to-peak', () => {
    const samples = androidHeadingStream({
      truth: () => 90,
      durationMs: 60_000,
      noiseDeg: 5,
    });
    // The gate really does hand us nothing but noise excursions.
    expect(samples.length).toBeGreaterThan(100);
    expect(peakToPeakDeg(samples.map((s) => s.degrees))).toBeGreaterThan(15);

    const f = createHeadingFilter();
    const out: number[] = [];
    for (const s of samples) {
      const y = f.push({ ...s, accuracy: 3 });
      if (s.timestampMs > 10_000) out.push(y); // skip the settle-in
    }
    // The acceptance criterion. (It is in fact exactly 0: the hold never breaks.)
    expect(peakToPeakDeg(out)).toBeLessThan(1);
    // …and it holds the truth, not some biased corner of the noise.
    const last = out[out.length - 1] ?? 0;
    expect(Math.abs(signedDeltaDeg(90, last))).toBeLessThan(4);
  });

  it('keeps a healthy margin between resting noise and the hold triggers', () => {
    // The two numbers that let the hold survive a noisy sensor. If a future
    // tweak erodes either margin, the needle starts to creep at rest again.
    let worstRate = 0;
    let worstDrift = 0;
    for (const seed of [11, 22, 33]) {
      const samples = androidHeadingStream({
        truth: () => 200,
        durationMs: 90_000,
        noiseDeg: 5,
        seed,
      });
      // A filter whose hold can never break, so we can watch the raw tendencies.
      const f = createHeadingFilter({
        enterTurnRateDegPerSec: 1e6,
        holdBreakoutDeg: 1e6,
      });
      const probe = createHeadingFilter({
        enterTurnRateDegPerSec: 1e-6,
        exitTurnRateDegPerSec: 0,
        turningDeadbandDeg: 0,
      });
      let anchor: number | null = null;
      for (const s of samples) {
        f.push({ ...s, accuracy: 3 });
        const tracked = probe.push({ ...s, accuracy: 3 }); // always-tracking reference
        if (s.timestampMs > 10_000) {
          anchor ??= tracked;
          worstRate = Math.max(worstRate, Math.abs(f.turnRateDegPerSec()));
          worstDrift = Math.max(worstDrift, Math.abs(signedDeltaDeg(anchor, tracked)));
        }
      }
    }
    expect(worstRate).toBeLessThan(8 / 1.5); // vs enterTurnRateDegPerSec = 8
    expect(worstDrift).toBeLessThan(10 / 1.5); // vs holdBreakoutDeg = 10
  });

  it('stays steady at rest even across the 0/360 boundary', () => {
    const samples = androidHeadingStream({
      truth: () => 0,
      durationMs: 60_000,
      noiseDeg: 5,
      seed: 999,
    });
    const f = createHeadingFilter();
    const out: number[] = [];
    for (const s of samples) {
      const y = f.push(s);
      if (s.timestampMs > 10_000) out.push(y);
    }
    expect(peakToPeakDeg(out)).toBeLessThan(1);
    expect(Math.abs(signedDeltaDeg(0, out[out.length - 1] ?? 0))).toBeLessThan(4);
  });

  it('tracks a real turn with a small lag (and catches up quickly)', () => {
    // Still for 3 s, then a 90°/s turn from 90° to 270° — a brisk half-turn.
    const rate = 90;
    const startMs = 3_000;
    const truth = (t: number) =>
      t < startMs ? 90 : Math.min(270, 90 + ((t - startMs) / 1000) * rate);
    const samples = androidHeadingStream({ truth, durationMs: 8_000, noiseDeg: 5 });

    const f = createHeadingFilter();
    let worstLagWhileTurning = 0;
    let out = 0;
    for (const s of samples) {
      out = f.push({ ...s, accuracy: 3 });
      const t = s.timestampMs;
      if (t > startMs + 700 && t < startMs + 2000) {
        worstLagWhileTurning = Math.max(
          worstLagWhileTurning,
          Math.abs(signedDeltaDeg(out, truth(t))),
        );
      }
    }
    // Once the turn is under way the filter is nearly transparent…
    expect(worstLagWhileTurning).toBeLessThan(15);
    // …and it arrives at the final heading, not short of it.
    expect(Math.abs(signedDeltaDeg(270, out))).toBeLessThan(3);
  });

  it('follows a full 360° rotation through the 0/360 boundary without unwinding', () => {
    const f = createHeadingFilter();
    let heading = 300;
    let out = f.push({ degrees: heading, timestampMs: 0 });
    for (let i = 1; i <= 60; i++) {
      heading = normalizeDeg(heading + 6); // 60°/s at 10 Hz
      out = f.push({ degrees: heading, timestampMs: i * 100 });
    }
    expect(Math.abs(signedDeltaDeg(out, heading))).toBeLessThan(15);
  });

  it('holds the output completely still until a turn is detected, then tracks', () => {
    const f = createHeadingFilter({ minCutoffHz: 100, beta: 0, turningDeadbandDeg: 0.5 });
    f.push({ degrees: 100, timestampMs: 0 });
    // minCutoff 100 Hz ⇒ the 1-Euro stage is a pass-through; only the hold acts.
    // Nudges too small and too slow to be a turn ⇒ the output does not budge.
    expect(f.push({ degrees: 101, timestampMs: 500 })).toBeCloseTo(100, 6);
    expect(f.push({ degrees: 102, timestampMs: 1000 })).toBeCloseTo(100, 6);
    expect(f.push({ degrees: 103, timestampMs: 1500 })).toBeCloseTo(100, 6);

    // A real turn (well above enterTurnRateDegPerSec) ⇒ tracked, minus the
    // small turning backlash.
    let out = 0;
    for (let i = 1; i <= 10; i++)
      out = f.push({ degrees: 103 + i * 9, timestampMs: 1500 + i * 100 });
    expect(out).toBeCloseTo(193 - 0.5, 0);
  });

  it('breaks the hold on a rotation too slow to trip the rate gate', () => {
    // 2°/s — under enterTurnRateDegPerSec (8). The breakout is the safety net:
    // the output must not stay frozen for ever.
    const f = createHeadingFilter();
    let out = f.push({ degrees: 100, timestampMs: 0 });
    for (let i = 1; i <= 200; i++) {
      out = f.push({ degrees: 100 + i * 0.2, timestampMs: i * 100 }); // 2°/s for 20 s
    }
    // Truth is 140°; we must be tracking it, not stuck at 100°.
    expect(Math.abs(signedDeltaDeg(out, 140))).toBeLessThan(11); // ≤ holdBreakoutDeg
    expect(Math.abs(signedDeltaDeg(out, 100))).toBeGreaterThan(20);
  });

  it('filters a poorly calibrated compass harder than a well calibrated one', () => {
    const run = (accuracy: number) => {
      const f = createHeadingFilter();
      f.push({ degrees: 0, timestampMs: 0, accuracy });
      let out = 0;
      for (let i = 1; i <= 10; i++) out = f.push({ degrees: 40, timestampMs: i * 100, accuracy });
      return out;
    };
    expect(run(0)).toBeLessThan(run(3));
    expect(run(0)).toBeGreaterThan(0); // damped, not frozen
    expect(run(1)).toBeLessThan(run(2));
  });

  it('treats unknown accuracy as trusted', () => {
    const unknown = createHeadingFilter();
    const trusted = createHeadingFilter();
    unknown.push({ degrees: 0, timestampMs: 0, accuracy: null });
    trusted.push({ degrees: 0, timestampMs: 0, accuracy: 3 });
    let a = 0;
    let b = 0;
    for (let i = 1; i <= 10; i++) {
      a = unknown.push({ degrees: 40, timestampMs: i * 100 });
      b = trusted.push({ degrees: 40, timestampMs: i * 100, accuracy: 3 });
    }
    expect(a).toBeCloseTo(b, 6);
  });

  it('exposes the turn rate it is tracking', () => {
    const f = createHeadingFilter();
    for (let i = 0; i <= 60; i++) f.push({ degrees: normalizeDeg(i * 6), timestampMs: i * 100 });
    expect(f.turnRateDegPerSec()).toBeGreaterThan(40); // ~60°/s, clockwise
    expect(f.turnRateDegPerSec()).toBeLessThan(80);
  });

  it('reset clears history', () => {
    const f = createHeadingFilter();
    f.push({ degrees: 123, timestampMs: 5 });
    f.reset();
    expect(f.value()).toBeNull();
    expect(f.turnRateDegPerSec()).toBe(0);
    expect(f.push({ degrees: 7, timestampMs: 6 })).toBeCloseTo(7, 6);
  });

  it('rejects invalid options', () => {
    expect(() => createHeadingFilter({ enterTurnRateDegPerSec: 0 })).toThrow();
    expect(() => createHeadingFilter({ exitTurnRateDegPerSec: -1 })).toThrow();
    expect(() =>
      createHeadingFilter({ enterTurnRateDegPerSec: 2, exitTurnRateDegPerSec: 5 }),
    ).toThrow();
    expect(() => createHeadingFilter({ holdBreakoutDeg: 0 })).toThrow();
    expect(() => createHeadingFilter({ turningDeadbandDeg: -1 })).toThrow();
    expect(() => createHeadingFilter({ holdBreakoutDeg: 2, turningDeadbandDeg: 3 })).toThrow();
    expect(() => createHeadingFilter({ lowAccuracyScale: 0 })).toThrow();
    expect(() => createHeadingFilter({ lowAccuracyScale: 1.5 })).toThrow();
    expect(() => createHeadingFilter({ minCutoffHz: 0 })).toThrow();
    expect(() => createHeadingFilter({ beta: -1 })).toThrow();
  });
});
