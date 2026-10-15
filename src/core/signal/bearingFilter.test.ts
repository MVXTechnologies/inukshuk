import { createBearingFilter, smoothstep } from './bearingFilter';
import { normalizeDeg, signedDeltaDeg } from './heading';
import { androidStream, peakToPeak } from './testUtils';

// The replayed Android stream (σ 5°, ≥ 2° change gate, ~7 Hz): see ./testUtils.

interface Replay {
  /** Output per sample, with its time and the truth then. */
  rows: { t: number; dtMs: number; out: number; truth: number }[];
}

function replay(truth: (t: number) => number, durationMs: number, seed: number): Replay {
  const f = createBearingFilter();
  const rows: Replay['rows'] = [];
  let prevT = 0;
  for (const s of androidStream(truth, durationMs, seed)) {
    rows.push({
      t: s.timestampMs,
      dtMs: s.timestampMs - prevT,
      out: f.push(s),
      truth: truth(s.timestampMs),
    });
    prevT = s.timestampMs;
  }
  return { rows };
}

interface Smoothness {
  /** Steps that jumped > 5° beyond what the truth moved in that sample: visible snaps. */
  snaps: number;
  /** The most negative step against a clockwise turn (a visible kick back), °. */
  worstBack: number;
  /** Mean and worst |output − truth|, °. */
  meanErr: number;
  maxErr: number;
}

/** How a replay looks from `fromMs` on, sample by sample. */
function smoothness(r: Replay, fromMs: number): Smoothness {
  let snaps = 0;
  let worstBack = 0;
  let errSum = 0;
  let n = 0;
  let maxErr = 0;
  for (let i = 1; i < r.rows.length; i++) {
    const a = r.rows[i - 1];
    const b = r.rows[i];
    if (a === undefined || b === undefined || b.t < fromMs) continue;
    const step = signedDeltaDeg(a.out, b.out);
    if (Math.abs(step) - Math.abs(signedDeltaDeg(a.truth, b.truth)) > 5) snaps++;
    worstBack = Math.min(worstBack, step);
    const err = Math.abs(signedDeltaDeg(b.out, b.truth));
    errSum += err;
    n++;
    maxErr = Math.max(maxErr, err);
  }
  return { snaps, worstBack, meanErr: errSum / Math.max(1, n), maxErr };
}

/*
 * The thresholds below come from replaying the same six seeds through both
 * filters. 2.5's hold-and-snap filter measured, per run: slow 3°/s turn
 * 6–9 snaps; walking 15°/s turn 1–11 snaps and kicks back to −9.4°; brisk
 * 90°/s turn 6–15 snaps and kicks back to −12.8°. This filter: 0–4, 0–2 and
 * 1–4 snaps, kicks back at most −4.9° / −7.3°, at about the same lag.
 */

const SEEDS = [1, 2, 3, 11, 22, 33];

describe('createBearingFilter: basics', () => {
  it('passes the first reading through; value() is null before it', () => {
    const f = createBearingFilter();
    expect(f.value()).toBeNull();
    expect(f.push({ degrees: 42, timestampMs: 0 })).toBeCloseTo(42, 9);
    expect(f.value()).toBeCloseTo(42, 9);
  });

  it('normalises out-of-range input and ignores a non-finite one', () => {
    const f = createBearingFilter();
    expect(Number.isNaN(f.push({ degrees: NaN, timestampMs: 0 }))).toBe(true);
    expect(f.push({ degrees: -90, timestampMs: 0 })).toBeCloseTo(270, 9);
    expect(f.push({ degrees: Infinity, timestampMs: 100 })).toBeCloseTo(270, 9);
    expect(f.push({ degrees: 630, timestampMs: 200 })).toBeCloseTo(270, 9);
  });

  it('reset forgets everything', () => {
    const f = createBearingFilter();
    for (let i = 0; i < 20; i++) f.push({ degrees: i * 6, timestampMs: i * 100 });
    f.reset();
    expect(f.value()).toBeNull();
    expect(f.turnRateDegPerSec()).toBe(0);
    expect(f.push({ degrees: 7, timestampMs: 5000 })).toBeCloseTo(7, 9);
  });

  it('rejects inconsistent options', () => {
    expect(() =>
      createBearingFilter({ gateRateLoDegPerSec: 10, gateRateHiDegPerSec: 4 }),
    ).toThrow();
    expect(() => createBearingFilter({ gateRateLoDegPerSec: -1 })).toThrow();
    expect(() => createBearingFilter({ gateGapLoDeg: 12, gateGapHiDeg: 5 })).toThrow();
    expect(() => createBearingFilter({ lowAccuracyScale: 0 })).toThrow();
    expect(() => createBearingFilter({ lowAccuracyScale: 2 })).toThrow();
    expect(() => createBearingFilter({ settleMs: -1 })).toThrow();
  });

  it('smoothstep: 0 below, 1 above, smooth and monotonic between', () => {
    expect(smoothstep(4, 10, 0)).toBe(0);
    expect(smoothstep(4, 10, 4)).toBe(0);
    expect(smoothstep(4, 10, 7)).toBeCloseTo(0.5, 12);
    expect(smoothstep(4, 10, 10)).toBe(1);
    expect(smoothstep(4, 10, 99)).toBe(1);
    let prev = 0;
    for (let x = 4; x <= 10; x += 0.25) {
      const y = smoothstep(4, 10, x);
      expect(y).toBeGreaterThanOrEqual(prev);
      prev = y;
    }
  });
});

describe('createBearingFilter: replayed noisy sensor streams (#704)', () => {
  it('is steady at rest: under 1.5° peak-to-peak over a minute, close to the truth', () => {
    for (const seed of SEEDS) {
      const r = replay(() => 90, 60_000, seed);
      // The stream really is nothing but ≥ 2° noise excursions.
      expect(peakToPeak(r.rows.map((x) => x.truth + 0))).toBe(0);
      const settled = r.rows.filter((x) => x.t > 10_000).map((x) => x.out);
      expect(settled.length).toBeGreaterThan(200);
      expect(peakToPeak(settled)).toBeLessThan(1.5);
      expect(Math.abs(signedDeltaDeg(90, settled[settled.length - 1] ?? 0))).toBeLessThan(3);
    }
  });

  it('is steady at rest on north itself, never flipping through 180° (wraparound)', () => {
    for (const seed of SEEDS) {
      const r = replay(() => 0, 60_000, seed);
      // Raw readings straddle 359°/0° all the time.
      expect(r.rows.some((x) => x.out > 350 || x.out < 10)).toBe(true);
      const settled = r.rows.filter((x) => x.t > 10_000).map((x) => x.out);
      expect(peakToPeak(settled)).toBeLessThan(1.5);
      for (const h of settled) expect(Math.abs(signedDeltaDeg(0, h))).toBeLessThan(4);
    }
  });

  it('glides through a slow turn (3°/s): few snaps, never far behind', () => {
    const truth = (t: number) => (t < 5000 ? 90 : 90 + ((t - 5000) / 1000) * 3);
    for (const seed of SEEDS) {
      const s = smoothness(replay(truth, 30_000, seed), 5000);
      expect(s.snaps).toBeLessThanOrEqual(4); // 2.5: 6–9
      expect(s.worstBack).toBeGreaterThan(-4);
      expect(s.maxErr).toBeLessThan(13);
    }
  });

  it('tracks a walking turn (15°/s) without snaps or kicks back', () => {
    const truth = (t: number) => (t < 5000 ? 90 : 90 + Math.min(90, ((t - 5000) / 1000) * 15));
    for (const seed of SEEDS) {
      const r = replay(truth, 20_000, seed);
      const s = smoothness(r, 5000);
      expect(s.snaps).toBeLessThanOrEqual(2); // 2.5: 1–11
      expect(s.worstBack).toBeGreaterThan(-6); // 2.5: down to −9.4
      expect(s.meanErr).toBeLessThan(4);
      const last = r.rows[r.rows.length - 1];
      expect(Math.abs(signedDeltaDeg(180, last?.out ?? 0))).toBeLessThan(4);
    }
  });

  it('follows a brisk 90°/s half-turn across north the short way, low-lag', () => {
    // 350° → 170° clockwise, through 0°.
    const truth = (t: number) => (t < 5000 ? 350 : 350 + Math.min(180, ((t - 5000) / 1000) * 90));
    for (const seed of SEEDS) {
      const r = replay(truth, 12_000, seed);
      const s = smoothness(r, 5000);
      expect(s.snaps).toBeLessThanOrEqual(5); // 2.5: 6–15
      // Never unwinding the long way round: no big counter-clockwise step.
      expect(s.worstBack).toBeGreaterThan(-8); // 2.5: down to −12.8
      expect(s.meanErr).toBeLessThan(7);
      // Under way (after its first 0.7 s) it is within a quarter second of the
      // turn (22.5° at 90°/s; 2.5 lagged up to 26°)…
      for (const row of r.rows.filter((x) => x.t > 5700 && x.t < 6900)) {
        expect(Math.abs(signedDeltaDeg(row.out, row.truth))).toBeLessThan(22.5);
      }
      // …and it arrives, not short of the final heading.
      const last = r.rows[r.rows.length - 1];
      expect(Math.abs(signedDeltaDeg(170, last?.out ?? 0))).toBeLessThan(3);
    }
  });

  it('follows a full clean rotation through north without unwinding', () => {
    const f = createBearingFilter();
    let h = 300;
    let out = f.push({ degrees: h, timestampMs: 0 });
    for (let i = 1; i <= 60; i++) {
      h = normalizeDeg(h + 6); // 60°/s at 10 Hz
      const next = f.push({ degrees: h, timestampMs: i * 100 });
      expect(signedDeltaDeg(out, next)).toBeGreaterThanOrEqual(0);
      out = next;
    }
    expect(Math.abs(signedDeltaDeg(out, h))).toBeLessThan(15);
  });

  it('alternating 359°/1° readings average to north, not to 180°', () => {
    const f = createBearingFilter();
    let out = 0;
    for (let i = 0; i < 100; i++) {
      out = f.push({ degrees: i % 2 === 0 ? 359 : 1, timestampMs: i * 100 });
      expect(Math.abs(signedDeltaDeg(0, out))).toBeLessThanOrEqual(1);
    }
  });

  it('moves less on a poorly calibrated compass than on a calibrated one', () => {
    const run = (accuracy: number) => {
      const f = createBearingFilter({ settleMs: 0 });
      f.push({ degrees: 0, timestampMs: 0, accuracy });
      let out = 0;
      for (let i = 1; i <= 10; i++) out = f.push({ degrees: 40, timestampMs: i * 100, accuracy });
      return out;
    };
    expect(run(0)).toBeLessThan(run(3));
    expect(run(0)).toBeGreaterThan(0);
  });

  it('settles from a noisy first reading instead of resting on it', () => {
    // The first reading is 8° off; the truth is 90° and steady.
    const f = createBearingFilter();
    f.push({ degrees: 98, timestampMs: 0, accuracy: 3 });
    let out = 98;
    const stream = androidStream(() => 90, 20_000, 5).filter((s) => s.timestampMs > 0);
    for (const s of stream) out = f.push(s);
    expect(Math.abs(signedDeltaDeg(90, out))).toBeLessThan(3);
  });

  it('stops where the turn stops: the glide limit never pushes it on past the estimate', () => {
    // A clean 90°/s turn that stops dead at 180°. The glide limit only CAPS a
    // step; 2.6.1's first cut also forced a minimum step of (rate − 20°/s)·dt
    // in the turn's direction, which carried the output past the stop.
    const f = createBearingFilter();
    let max = -Infinity;
    for (let i = 0; i <= 80; i++) {
      const t = i * 100;
      const truth = Math.min(180, 90 + Math.max(0, t - 1000) * 0.09);
      const out = f.push({ degrees: truth, timestampMs: t });
      max = Math.max(max, signedDeltaDeg(180, out));
    }
    expect(max).toBeLessThanOrEqual(1e-9);
    expect(Math.abs(signedDeltaDeg(180, f.value() ?? 0))).toBeLessThan(0.5);
  });

  it('exposes its turn rate', () => {
    const f = createBearingFilter();
    for (let i = 0; i <= 60; i++) f.push({ degrees: normalizeDeg(i * 6), timestampMs: i * 100 });
    expect(f.turnRateDegPerSec()).toBeGreaterThan(40);
    expect(f.turnRateDegPerSec()).toBeLessThan(80);
  });
});
