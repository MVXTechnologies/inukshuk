import {
  circularMeanDeg,
  createAdaptiveHeadingSmoother,
  createHeadingSmoother,
  normalizeDeg,
  signedDeltaDeg,
  unwrapDeg,
} from './heading';

describe('normalizeDeg', () => {
  it('wraps into [0, 360)', () => {
    expect(normalizeDeg(0)).toBe(0);
    expect(normalizeDeg(360)).toBe(0);
    expect(normalizeDeg(370)).toBe(10);
    expect(normalizeDeg(-10)).toBe(350);
    expect(normalizeDeg(-370)).toBe(350);
  });
});

describe('circularMeanDeg', () => {
  it('averages nearby angles normally', () => {
    expect(circularMeanDeg([10, 20, 30])).toBeCloseTo(20, 4);
    expect(circularMeanDeg([90, 90, 90])).toBeCloseTo(90, 4);
  });

  it('handles the 0/360 wraparound (359 & 1 -> 0, not 180)', () => {
    expect(circularMeanDeg([359, 1])).toBeCloseTo(0, 4);
    expect(circularMeanDeg([350, 10])).toBeCloseTo(0, 4);
  });

  it('returns 0 for empty or fully-opposed input', () => {
    expect(circularMeanDeg([])).toBe(0);
    expect(circularMeanDeg([0, 180])).toBe(0);
  });
});

describe('createHeadingSmoother', () => {
  it('returns the first sample verbatim and null before any sample', () => {
    const s = createHeadingSmoother(0.2);
    expect(s.value()).toBeNull();
    expect(s.push(42)).toBeCloseTo(42, 4);
    expect(s.value()).toBeCloseTo(42, 4);
  });

  it('converges toward a steady input', () => {
    const s = createHeadingSmoother(0.3);
    s.push(0);
    let out = 0;
    for (let i = 0; i < 50; i++) out = s.push(90);
    expect(out).toBeCloseTo(90, 1);
  });

  it('smooths across the wraparound without spiking to ~180', () => {
    const s = createHeadingSmoother(0.5);
    s.push(359);
    const out = s.push(1); // halfway-ish between 359 and 1 is ~0, never ~180
    const dist = Math.min(normalizeDeg(out), 360 - normalizeDeg(out));
    expect(dist).toBeLessThan(5);
  });

  it('lags a step change (smoothing, not snapping)', () => {
    const s = createHeadingSmoother(0.2);
    s.push(0);
    const out = s.push(100); // one step toward 100, should be well short of it
    expect(out).toBeGreaterThan(0);
    expect(out).toBeLessThan(40);
  });

  it('reset clears history', () => {
    const s = createHeadingSmoother(0.2);
    s.push(123);
    s.reset();
    expect(s.value()).toBeNull();
  });

  it('rejects an out-of-range alpha', () => {
    expect(() => createHeadingSmoother(0)).toThrow();
    expect(() => createHeadingSmoother(1.5)).toThrow();
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
    // Deterministic pseudo-random turn sequence, including boundary crossings.
    for (let i = 0; i < 500; i++) {
      heading = normalizeDeg(heading + Math.sin(i * 0.7) * 170);
      const next = unwrapDeg(continuous, heading);
      expect(Math.abs(next - continuous)).toBeLessThanOrEqual(180);
      expect(normalizeDeg(next)).toBeCloseTo(heading, 8);
      continuous = next;
    }
  });
});

describe('createAdaptiveHeadingSmoother', () => {
  it('returns the first sample verbatim and null before any sample', () => {
    const s = createAdaptiveHeadingSmoother();
    expect(s.value()).toBeNull();
    expect(s.push({ degrees: 42 })).toBeCloseTo(42, 6);
    expect(s.value()).toBeCloseTo(42, 6);
  });

  it('normalizes out-of-range input', () => {
    const s = createAdaptiveHeadingSmoother();
    expect(s.push({ degrees: -90 })).toBeCloseTo(270, 6);
    expect(s.push({ degrees: 630 })).toBeCloseTo(270, 6);
  });

  it('barely moves on small jitter (min alpha)', () => {
    const s = createAdaptiveHeadingSmoother({ minAlpha: 0.05, maxAlpha: 0.5 });
    s.push({ degrees: 90 });
    const out = s.push({ degrees: 92 });
    // deviation 2° of deltaForMax 30° → alpha ≈ 0.05 + 0.45·(2/30) = 0.08 → ~0.16° move
    expect(out).toBeGreaterThan(90);
    expect(out).toBeLessThan(90.5);
  });

  it('follows a large turn much faster than small jitter (adaptive alpha)', () => {
    const adaptive = createAdaptiveHeadingSmoother({ minAlpha: 0.05, maxAlpha: 0.5 });
    adaptive.push({ degrees: 0 });
    const afterBigStep = adaptive.push({ degrees: 90 }); // deviation ≥ deltaForMax → alpha 0.5
    expect(afterBigStep).toBeGreaterThan(30);

    // The same step through the fixed min-alpha would move only ~4.5°.
    const fixed = createHeadingSmoother(0.05);
    fixed.push(0);
    expect(fixed.push(90)).toBeLessThan(10);
  });

  it('converges to a steady input', () => {
    const s = createAdaptiveHeadingSmoother();
    s.push({ degrees: 10 });
    let out = 10;
    for (let i = 0; i < 200; i++) out = s.push({ degrees: 200 });
    expect(out).toBeCloseTo(200, 0);
  });

  it('smooths across the 0/360 wraparound without spiking toward 180', () => {
    const s = createAdaptiveHeadingSmoother();
    s.push({ degrees: 359 });
    for (let i = 0; i < 20; i++) {
      const out = s.push({ degrees: i % 2 === 0 ? 1 : 359 });
      const dist = Math.min(normalizeDeg(out), 360 - normalizeDeg(out));
      expect(dist).toBeLessThan(5);
    }
  });

  it('tracks a continuous fast rotation through the boundary', () => {
    const s = createAdaptiveHeadingSmoother();
    let heading = 300;
    let out = s.push({ degrees: heading });
    for (let i = 0; i < 40; i++) {
      heading = normalizeDeg(heading + 10); // full turn through 0/360
      out = s.push({ degrees: heading });
    }
    // Must have followed the rotation without getting stuck or reversing.
    expect(Math.abs(signedDeltaDeg(out, heading))).toBeLessThan(20);
  });

  it('trusts poorly calibrated readings less (accuracy gating)', () => {
    const good = createAdaptiveHeadingSmoother();
    const bad = createAdaptiveHeadingSmoother();
    good.push({ degrees: 0, accuracy: 3 });
    bad.push({ degrees: 0, accuracy: 3 });
    const goodOut = good.push({ degrees: 40, accuracy: 3 });
    const badOut = bad.push({ degrees: 40, accuracy: 0 });
    expect(badOut).toBeLessThan(goodOut);
    expect(badOut).toBeGreaterThan(0); // still moves — gated, not dropped
  });

  it('interpolates trust between calibration levels', () => {
    const mk = (accuracy: number) => {
      const s = createAdaptiveHeadingSmoother();
      s.push({ degrees: 0, accuracy: 3 });
      return s.push({ degrees: 40, accuracy });
    };
    expect(mk(0)).toBeLessThan(mk(1));
    expect(mk(1)).toBeLessThan(mk(2));
    expect(mk(2)).toBeLessThan(mk(3));
  });

  it('treats unknown accuracy as trusted', () => {
    const withNull = createAdaptiveHeadingSmoother();
    const withHigh = createAdaptiveHeadingSmoother();
    withNull.push({ degrees: 0, accuracy: null });
    withHigh.push({ degrees: 0, accuracy: 3 });
    expect(withNull.push({ degrees: 40, accuracy: null })).toBeCloseTo(
      withHigh.push({ degrees: 40, accuracy: 3 }),
      6,
    );
  });

  it('corrects for the sample interval: two half-interval steps ≈ one full step', () => {
    const single = createAdaptiveHeadingSmoother({ refIntervalMs: 100 });
    single.push({ degrees: 0, timestampMs: 0 });
    const oneStep = single.push({ degrees: 20, timestampMs: 100 });

    const double = createAdaptiveHeadingSmoother({ refIntervalMs: 100 });
    double.push({ degrees: 0, timestampMs: 0 });
    double.push({ degrees: 20, timestampMs: 50 });
    const twoSteps = double.push({ degrees: 20, timestampMs: 100 });

    // Not exact (alpha re-adapts to the shrinking deviation) but close: the
    // effective smoothing over 100 ms must not depend strongly on sensor rate.
    expect(Math.abs(twoSteps - oneStep)).toBeLessThan(3);
  });

  it('clamps a huge sensor gap instead of snapping', () => {
    const s = createAdaptiveHeadingSmoother({ minAlpha: 0.05, maxAlpha: 0.3, refIntervalMs: 100 });
    s.push({ degrees: 0, timestampMs: 0 });
    const out = s.push({ degrees: 90, timestampMs: 60_000 }); // 60 s gap
    // frames capped at 10 → alpha = 1-(1-0.3)^10 ≈ 0.97, i.e. near — but not
    // exactly — the sample; it must not overflow past it.
    expect(out).toBeGreaterThan(60);
    expect(out).toBeLessThanOrEqual(90);
  });

  it('ignores non-increasing timestamps (no rate correction)', () => {
    const s = createAdaptiveHeadingSmoother();
    s.push({ degrees: 0, timestampMs: 1000 });
    expect(() => s.push({ degrees: 10, timestampMs: 1000 })).not.toThrow();
    expect(() => s.push({ degrees: 10, timestampMs: 500 })).not.toThrow();
  });

  it('survives an exact 180° flip (degenerate vector)', () => {
    // alpha 0.5 on an exact antipode collapses the EMA vector to length 0;
    // the smoother must adopt the sample instead of emitting atan2(0, 0).
    const s = createAdaptiveHeadingSmoother({ minAlpha: 0.5, maxAlpha: 0.5 });
    s.push({ degrees: 0 });
    expect(s.push({ degrees: 180 })).toBeCloseTo(180, 6);

    const full = createAdaptiveHeadingSmoother({ minAlpha: 1, maxAlpha: 1 });
    full.push({ degrees: 0 });
    expect(full.push({ degrees: 180 })).toBeCloseTo(180, 6);
  });

  it('reset clears history', () => {
    const s = createAdaptiveHeadingSmoother();
    s.push({ degrees: 123, timestampMs: 5 });
    s.reset();
    expect(s.value()).toBeNull();
    expect(s.push({ degrees: 7, timestampMs: 6 })).toBeCloseTo(7, 6);
  });

  it('rejects invalid options', () => {
    expect(() => createAdaptiveHeadingSmoother({ minAlpha: 0 })).toThrow();
    expect(() => createAdaptiveHeadingSmoother({ minAlpha: 0.5, maxAlpha: 0.2 })).toThrow();
    expect(() => createAdaptiveHeadingSmoother({ maxAlpha: 1.5 })).toThrow();
    expect(() => createAdaptiveHeadingSmoother({ deltaForMaxAlphaDeg: 0 })).toThrow();
    expect(() => createAdaptiveHeadingSmoother({ refIntervalMs: -1 })).toThrow();
    expect(() => createAdaptiveHeadingSmoother({ lowAccuracyAlphaScale: 1.2 })).toThrow();
  });
});
