import { alphaForCutoff, createOneEuroFilter } from './oneEuro';

describe('alphaForCutoff', () => {
  it('is in (0, 1) and grows with the cutoff', () => {
    const low = alphaForCutoff(0.1, 0.1);
    const high = alphaForCutoff(10, 0.1);
    expect(low).toBeGreaterThan(0);
    expect(high).toBeLessThan(1);
    expect(high).toBeGreaterThan(low);
  });

  it('grows with the time step (a longer gap moves the filter further)', () => {
    expect(alphaForCutoff(1, 0.2)).toBeGreaterThan(alphaForCutoff(1, 0.02));
  });
});

describe('createOneEuroFilter', () => {
  it('returns the first sample verbatim; value() is null before it', () => {
    const f = createOneEuroFilter();
    expect(f.value()).toBeNull();
    expect(f.push(5, 0)).toBe(5);
    expect(f.value()).toBe(5);
    expect(f.speed()).toBe(0);
  });

  it('lags a step change instead of snapping to it', () => {
    const f = createOneEuroFilter({ minCutoffHz: 0.1, beta: 0 });
    f.push(0, 0);
    const out = f.push(100, 100);
    expect(out).toBeGreaterThan(0);
    expect(out).toBeLessThan(20);
  });

  it('converges to a constant input', () => {
    const f = createOneEuroFilter({ minCutoffHz: 0.5, beta: 0.01 });
    let out = f.push(0, 0);
    for (let i = 1; i <= 400; i++) out = f.push(50, i * 100);
    expect(out).toBeCloseTo(50, 1);
  });

  it('beta makes a ramp track with far less lag', () => {
    const ramp = (beta: number) => {
      const f = createOneEuroFilter({ minCutoffHz: 0.06, beta, dCutoffHz: 1 });
      let out = 0;
      for (let i = 0; i <= 40; i++) out = f.push(i * 5, i * 100); // 50 units/s for 4 s
      return out;
    };
    const truth = 200;
    const lagNoBeta = truth - ramp(0);
    const lagWithBeta = truth - ramp(0.12);
    expect(lagWithBeta).toBeLessThan(lagNoBeta / 3);
    expect(lagWithBeta).toBeLessThan(10);
  });

  it('estimates the speed of a steady ramp', () => {
    const f = createOneEuroFilter({ minCutoffHz: 0.06, beta: 0.12 });
    for (let i = 0; i <= 60; i++) f.push(i * 5, i * 100); // 50 units/s
    expect(f.speed()).toBeGreaterThan(35);
    expect(f.speed()).toBeLessThan(65);
  });

  it('does NOT let noise inflate the speed estimate (the deviation-chasing bug)', () => {
    const f = createOneEuroFilter({ minCutoffHz: 0.06, beta: 0.12 });
    let seed = 7;
    const noise = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return (seed / 2147483648) * 8 - 4; // ±4 units
    };
    for (let i = 0; i <= 300; i++) f.push(90 + noise(), i * 100);
    // A raw-derivative 1-Euro would read tens of units/s of phantom speed here.
    expect(Math.abs(f.speed())).toBeLessThan(3);
  });

  it('honours real timestamps: a slower stream still converges at the same rate', () => {
    const fast = createOneEuroFilter({ minCutoffHz: 0.3, beta: 0 });
    const slow = createOneEuroFilter({ minCutoffHz: 0.3, beta: 0 });
    fast.push(0, 0);
    slow.push(0, 0);
    for (let t = 50; t <= 1000; t += 50) fast.push(100, t);
    for (let t = 200; t <= 1000; t += 200) slow.push(100, t);
    expect(Math.abs((fast.value() ?? 0) - (slow.value() ?? 0))).toBeLessThan(5);
  });

  it('clamps an absurd sensor gap (no snap, no divide-by-zero)', () => {
    const f = createOneEuroFilter({ minCutoffHz: 0.5, beta: 0 });
    f.push(0, 0);
    const out = f.push(100, 3_600_000); // one hour later
    expect(out).toBeGreaterThan(0);
    expect(out).toBeLessThan(100);
  });

  it('falls back to defaultIntervalMs for missing / non-increasing timestamps', () => {
    const f = createOneEuroFilter({ minCutoffHz: 0.5, beta: 0, defaultIntervalMs: 100 });
    f.push(0);
    const a = f.push(10);
    expect(a).toBeGreaterThan(0);
    const g = createOneEuroFilter({ minCutoffHz: 0.5, beta: 0, defaultIntervalMs: 100 });
    g.push(0, 1000);
    expect(g.push(10, 1000)).toBeCloseTo(a, 6); // same-timestamp → default interval
    expect(() => g.push(10, 500)).not.toThrow(); // going backwards → default interval
  });

  it('cutoffScale below 1 filters harder', () => {
    const trusted = createOneEuroFilter({ minCutoffHz: 0.5, beta: 0 });
    const doubted = createOneEuroFilter({ minCutoffHz: 0.5, beta: 0 });
    trusted.push(0, 0);
    doubted.push(0, 0);
    expect(doubted.push(100, 100, 0.5)).toBeLessThan(trusted.push(100, 100, 1));
  });

  it('reset clears history', () => {
    const f = createOneEuroFilter();
    f.push(42, 0);
    f.push(50, 100);
    f.reset();
    expect(f.value()).toBeNull();
    expect(f.speed()).toBe(0);
    expect(f.push(7, 200)).toBe(7);
  });

  it('rejects invalid options and inputs', () => {
    expect(() => createOneEuroFilter({ minCutoffHz: 0 })).toThrow();
    expect(() => createOneEuroFilter({ beta: -1 })).toThrow();
    expect(() => createOneEuroFilter({ dCutoffHz: 0 })).toThrow();
    expect(() => createOneEuroFilter({ defaultIntervalMs: 0 })).toThrow();
    expect(() => createOneEuroFilter().push(Number.NaN)).toThrow();
    expect(() => createOneEuroFilter().push(1, 0, 0)).toThrow();
  });
});
