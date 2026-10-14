import { createBearingFilter } from './bearingFilter';
import { normalizeDeg, unwrapDeg } from './heading';
import { createHeadingFollower, stepCriticallyDamped } from './headingMotion';
import { androidStream } from './testUtils';

/** A 60 Hz display. */
const FRAME_MS = 1000 / 60;

describe('stepCriticallyDamped', () => {
  it('matches a fine numerical integration of x″ = −ω²(x − g) − 2ωx′', () => {
    const omega = 14;
    let [x, v] = [10, -40];
    for (let i = 0; i < 100_000; i++) {
      const a = -omega * omega * x - 2 * omega * v;
      v += a * 1e-6;
      x += v * 1e-6;
    }
    const [cx, cv] = stepCriticallyDamped(10, -40, 0, omega, 0.1);
    expect(cx).toBeCloseTo(x, 3);
    expect(cv).toBeCloseTo(v, 1);
  });

  it('is the same path at any frame rate (closed form, not Euler)', () => {
    let a: [number, number] = [0, 0];
    for (let i = 0; i < 6; i++) a = stepCriticallyDamped(a[0], a[1], 30, 14, 0.05);
    let b: [number, number] = [0, 0];
    for (let i = 0; i < 36; i++) b = stepCriticallyDamped(b[0], b[1], 30, 14, 0.3 / 36);
    expect(a[0]).toBeCloseTo(b[0], 9);
    expect(a[1]).toBeCloseTo(b[1], 9);
  });

  it('never overshoots a fixed goal from rest', () => {
    let s: [number, number] = [0, 0];
    for (let i = 0; i < 200; i++) {
      s = stepCriticallyDamped(s[0], s[1], 90, 14, FRAME_MS / 1000);
      expect(s[0]).toBeLessThanOrEqual(90);
    }
    expect(s[0]).toBeCloseTo(90, 3);
  });
});

describe('createHeadingFollower: basics', () => {
  it('is empty before a target, then starts exactly on the first one, at rest', () => {
    const f = createHeadingFollower();
    expect(f.value()).toBeNull();
    expect(Number.isNaN(f.advance(0))).toBe(true);
    f.setTarget(-30, 0);
    expect(f.value()).toBe(330);
    expect(f.isSettled()).toBe(true);
    expect(f.advance(100)).toBe(330);
  });

  it('ignores non-finite input', () => {
    const f = createHeadingFollower();
    f.setTarget(NaN, 0);
    expect(f.value()).toBeNull();
    f.setTarget(10, 0);
    f.setTarget(Infinity, 10);
    expect(f.isSettled()).toBe(true);
  });

  it('glides to a new target with no overshoot and comes to rest exactly on it', () => {
    const f = createHeadingFollower();
    f.setTarget(0, 0);
    f.setTarget(40, 0);
    let prev = 0;
    let t = 0;
    while (!f.isSettled() && t < 3000) {
      t += FRAME_MS;
      const x = f.advance(t);
      expect(x).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(x).toBeLessThanOrEqual(40 + 1e-9);
      prev = x;
    }
    expect(f.isSettled()).toBe(true);
    expect(f.value()).toBe(40);
    expect(f.velocity()).toBe(0);
    // ~0.6 s to land (ω = 14 rad/s).
    expect(t).toBeLessThan(1000);
  });

  it('crosses north the short way, on a continuous scale (359° → 1° is +2°)', () => {
    const f = createHeadingFollower();
    f.setTarget(359, 0);
    f.setTarget(1, 0);
    let t = 0;
    while (!f.isSettled()) {
      t += FRAME_MS;
      const x = f.advance(t);
      expect(x).toBeGreaterThanOrEqual(359 - 1e-9);
      expect(x).toBeLessThanOrEqual(361 + 1e-9);
    }
    expect(f.value()).toBe(361);
    expect(normalizeDeg(f.value() ?? NaN)).toBeCloseTo(1, 9);
  });

  it('a repeated target does not wake a settled follower (Android keeps sending noise at rest)', () => {
    const f = createHeadingFollower();
    f.setTarget(90, 0);
    for (let t = 50; t < 2000; t += 50) {
      f.setTarget(90, t);
      expect(f.isSettled()).toBe(true);
    }
  });

  it('a long frame gap (app resumed) is clamped, not integrated as one huge step', () => {
    const f = createHeadingFollower();
    f.setTarget(0, 0);
    f.setTarget(90, 0);
    const x = f.advance(60_000);
    // 250 ms of motion, not a minute.
    const [expected] = stepCriticallyDamped(0, 0, 90, 14, 0.25);
    expect(x).toBeCloseTo(expected, 9);
    expect(x).toBeLessThan(85);
  });

  it('reset forgets everything', () => {
    const f = createHeadingFollower();
    f.setTarget(10, 0);
    f.setTarget(50, 10);
    f.advance(100);
    f.reset();
    expect(f.value()).toBeNull();
    expect(f.isSettled()).toBe(true);
    f.setTarget(200, 1000);
    expect(f.value()).toBe(200);
  });

  it('time going backwards is no time at all', () => {
    const f = createHeadingFollower();
    f.setTarget(0, 1000);
    f.setTarget(30, 1000);
    const a = f.advance(1100);
    expect(f.advance(1050)).toBe(a);
  });

  it('rejects bad options', () => {
    expect(() => createHeadingFollower({ omega: 0 })).toThrow();
    expect(() => createHeadingFollower({ lead: -0.1 })).toThrow();
    expect(() => createHeadingFollower({ lead: 1.5 })).toThrow();
    expect(() => createHeadingFollower({ maxLeadDeg: -1 })).toThrow();
    expect(() => createHeadingFollower({ rateCutoffHz: 0 })).toThrow();
    expect(() => createHeadingFollower({ staleMs: 0 })).toThrow();
  });
});

describe('createHeadingFollower: lag', () => {
  /** Follow a clean ramp at `rate` °/s sampled at 10 Hz; mean lag over its steady part, ms. */
  function steadyLagMs(rate: number, lead: number): number {
    const f = createHeadingFollower({ lead });
    let sum = 0;
    let n = 0;
    let lastSample = -1;
    for (let k = 0; k <= 240; k++) {
      const t = k * FRAME_MS;
      // A 10 Hz sample, read at the first frame after it.
      const sampleAt = Math.floor(t / 100 + 1e-9) * 100;
      if (sampleAt !== lastSample) {
        lastSample = sampleAt;
        f.setTarget((rate * sampleAt) / 1000, t);
      }
      const x = f.advance(t);
      if (t > 2000) {
        sum += (rate * t) / 1000 - x;
        n++;
      }
    }
    return (sum / n / rate) * 1000;
  }

  it('without lead it trails a steady turn by ~2/ω (plus the half sample the staircase holds)', () => {
    const lag = steadyLagMs(60, 0);
    expect(lag).toBeGreaterThan((2 / 14) * 1000 + 30);
    expect(lag).toBeLessThan((2 / 14) * 1000 + 70);
  });

  it('the lead cancels its own lag: what remains is the sampling, not the smoothing', () => {
    const lag = steadyLagMs(60, 1);
    // The 10 Hz staircase alone holds each value ~50 ms on average.
    expect(lag).toBeGreaterThan(30);
    expect(lag).toBeLessThan(70);
  });

  it('once the samples stop, the lead goes and it lands on the last target', () => {
    const f = createHeadingFollower();
    for (let i = 0; i <= 10; i++) f.setTarget(i * 9, i * 100); // 90°/s for 1 s
    let t = 1000;
    let max = -Infinity;
    while (!f.isSettled() && t < 5000) {
      t += FRAME_MS;
      max = Math.max(max, f.advance(t));
    }
    expect(f.value()).toBe(90);
    // A clean stream stopping dead is the lead's worst case: it runs past the
    // last sample by at most the lead itself (2/ω × 90°/s ≈ 13°), then glides
    // back. Behind the bearing filter, which never stops dead, the overshoot it
    // adds is ~2° (see the replays below).
    expect(max - 90).toBeLessThan((2 / 14) * 90);
  });

  it('caps the lead', () => {
    const f = createHeadingFollower({ maxLeadDeg: 5 });
    for (let i = 0; i <= 5; i++) f.setTarget(i * 50, i * 100); // 500°/s
    let max = -Infinity;
    for (let t = 500; t < 520; t += 1) max = Math.max(max, f.advance(t));
    expect(max).toBeLessThan(250 + 5 + 1e-9);
  });
});

/*
 * The whole pipeline on the replayed Android stream, drawn at 60 Hz:
 * sensor → bearing filter → (a) each filtered sample drawn as it lands (2.6.0)
 * or (b) the follower advanced per frame (this module).
 *
 * Measured over six seeds (mean / worst), 2.6.0 → now:
 * - walking turn 15°/s: frames frozen 89 % → 12 %; per-frame step up to
 *   10° → 1.3°; jerk (RMS per-frame step error) 1.17° → 0.37°; lag 168 →
 *   148 ms.
 * - brisk turn 90°/s: frozen 88 % → 16 %; step up to 25° → 3.2°; jerk
 *   4.0° → 0.9°; lag 126 → 112 ms.
 * - at rest: still in both (0° peak-to-peak), and no frames drawn now.
 */
interface Drawn {
  t: number;
  out: number;
  truth: number;
}

function draw(
  truth: (t: number) => number,
  durationMs: number,
  seed: number,
  mode: 'step' | 'follow',
) {
  const filter = createBearingFilter();
  const follower = createHeadingFollower();
  const stream = androidStream(truth, durationMs, seed);
  const frames: Drawn[] = [];
  let i = 0;
  let shown: number | null = null;
  /** Frames that had to be drawn after the first 10 s. */
  let drawnLate = 0;
  for (let t = 0; t <= durationMs; t += FRAME_MS) {
    for (let s = stream[i]; s !== undefined && s.timestampMs <= t; s = stream[++i]) {
      const h = filter.push(s);
      if (mode === 'follow') follower.setTarget(h, s.timestampMs);
      else shown = shown === null ? h : unwrapDeg(shown, h);
    }
    let out: number | null;
    if (mode === 'follow') {
      if (!follower.isSettled() && t > 10_000) drawnLate++;
      out = follower.value() === null ? null : follower.advance(t);
    } else {
      out = shown;
    }
    if (out === null) continue;
    const prev = frames.at(-1);
    const tr = truth(t);
    frames.push({ t, out, truth: prev ? unwrapDeg(prev.truth, tr) : tr });
  }
  return { frames, drawnLate };
}

/** Frame-by-frame look of a turn between `from` and `to` ms. */
function look(frames: Drawn[], from: number, to: number) {
  let frozen = 0;
  let n = 0;
  let maxStep = 0;
  let sq = 0;
  for (let k = 1; k < frames.length; k++) {
    const a = frames[k - 1];
    const b = frames[k];
    if (a === undefined || b === undefined || b.t < from || b.t > to) continue;
    const step = b.out - a.out;
    n++;
    if (Math.abs(step) < 1e-9) frozen++;
    maxStep = Math.max(maxStep, Math.abs(step));
    sq += (step - (b.truth - a.truth)) ** 2;
  }
  return { frozenShare: frozen / n, maxStep, jerk: Math.sqrt(sq / n) };
}

/** Mean lag behind the truth over [from, to], ms, for a turn at `rate` °/s. */
function lagMs(frames: Drawn[], from: number, to: number, rate: number): number {
  const first = frames[0];
  if (first === undefined) return NaN;
  const off = Math.round((first.out - first.truth) / 360) * 360;
  const span = frames.filter((f) => f.t >= from && f.t <= to);
  const mean = span.reduce((acc, f) => acc + (f.truth + off - f.out), 0) / span.length;
  return (mean / rate) * 1000;
}

const SEEDS = [1, 2, 3, 11, 22, 33];

describe('createHeadingFollower: replayed Android streams, drawn at 60 Hz', () => {
  const walk = (t: number) => (t < 5000 ? 90 : 90 + Math.min(90, ((t - 5000) / 1000) * 15));
  const brisk = (t: number) => (t < 5000 ? 350 : 350 + Math.min(180, ((t - 5000) / 1000) * 90));

  it('a walking turn (15°/s) moves on almost every frame, in small even steps, no laggier', () => {
    for (const seed of SEEDS) {
      const before = draw(walk, 15_000, seed, 'step').frames;
      const after = draw(walk, 15_000, seed, 'follow').frames;
      const b = look(before, 5000, 11_000);
      const a = look(after, 5000, 11_000);
      expect(b.frozenShare).toBeGreaterThan(0.85); // the staircase
      expect(a.frozenShare).toBeLessThan(0.2);
      expect(b.maxStep).toBeGreaterThan(6);
      expect(a.maxStep).toBeLessThan(1.5);
      expect(a.jerk).toBeLessThan(b.jerk / 2.5);
      expect(lagMs(after, 6500, 11_000, 15)).toBeLessThan(lagMs(before, 6500, 11_000, 15) + 10);
    }
  });

  it('a brisk turn (90°/s) across north: no jumps, no long way round, no laggier', () => {
    for (const seed of SEEDS) {
      const before = draw(brisk, 10_000, seed, 'step').frames;
      const after = draw(brisk, 10_000, seed, 'follow').frames;
      const b = look(before, 5000, 7000);
      const a = look(after, 5000, 7000);
      expect(b.maxStep).toBeGreaterThan(12);
      expect(a.maxStep).toBeLessThan(3.6); // 1.5° per frame is the turn itself
      expect(a.jerk).toBeLessThan(b.jerk / 3.5);
      expect(lagMs(after, 5700, 7000, 90)).toBeLessThan(lagMs(before, 5700, 7000, 90) + 10);
      // At the stop it runs past the filter's own overshoot by little.
      const past = (frames: Drawn[]) => {
        const off = Math.round(((frames[0]?.out ?? 0) - (frames[0]?.truth ?? 0)) / 360) * 360;
        return Math.max(...frames.filter((f) => f.t > 7300).map((f) => f.out - (f.truth + off)));
      };
      expect(past(after)).toBeLessThan(Math.max(0, past(before)) + 3.5);
      // Clockwise all the way: never a step back the long way round.
      for (let k = 1; k < after.length; k++) {
        const step = (after[k]?.out ?? 0) - (after[k - 1]?.out ?? 0);
        expect(step).toBeGreaterThan(-3);
      }
    }
  });

  it('at rest: perfectly still, and not a single frame to draw', () => {
    for (const seed of SEEDS) {
      const { frames, drawnLate } = draw(() => 90, 30_000, seed, 'follow');
      const outs = frames.filter((f) => f.t > 10_000).map((f) => f.out);
      expect(Math.max(...outs) - Math.min(...outs)).toBe(0);
      // 20 s of noise excursions (~8 a second) wake nothing: no frame loop at rest.
      expect(drawnLate).toBe(0);
    }
  });
});
