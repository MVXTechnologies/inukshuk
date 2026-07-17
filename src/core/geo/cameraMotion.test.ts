import {
  FLY_TO_OMEGA,
  MOMENTUM_DECAY_PER_FRAME,
  applyMomentum,
  closestEquivalentAngle,
  springSettled,
  springStep,
  type MomentumVelocity,
  type SpringState,
} from './cameraMotion';

const FRAME = 1 / 60;

describe('applyMomentum', () => {
  it('is a no-op with zero velocity', () => {
    const r = applyMomentum({ x: 0, y: 0, twist: 0 }, FRAME);
    expect(r.dx).toBe(0);
    expect(r.dy).toBe(0);
    expect(r.dTwist).toBe(0);
    expect(r.done).toBe(true);
  });

  it('returns this frame displacement and decays the velocity ~0.9 per frame', () => {
    const r = applyMomentum({ x: 600, y: -300, twist: 2 }, FRAME);
    expect(r.dx).toBeCloseTo(600 * FRAME, 10);
    expect(r.dy).toBeCloseTo(-300 * FRAME, 10);
    expect(r.dTwist).toBeCloseTo(2 * FRAME, 10);
    expect(r.vel.x).toBeCloseTo(600 * MOMENTUM_DECAY_PER_FRAME, 10);
    expect(r.vel.y).toBeCloseTo(-300 * MOMENTUM_DECAY_PER_FRAME, 10);
    expect(r.vel.twist).toBeCloseTo(2 * MOMENTUM_DECAY_PER_FRAME, 10);
    expect(r.done).toBe(false);
  });

  it('follows the exponential decay curve across many frames', () => {
    let vel: MomentumVelocity = { x: 1000, y: 0, twist: 0 };
    for (let i = 0; i < 30; i++) vel = applyMomentum(vel, FRAME).vel;
    expect(vel.x).toBeCloseTo(1000 * Math.pow(MOMENTUM_DECAY_PER_FRAME, 30), 6);
  });

  it('is frame-rate independent: one 0.1 s step decays like six 1/60 s steps', () => {
    const big = applyMomentum({ x: 1000, y: 0, twist: 0 }, 0.1).vel.x;
    let vel: MomentumVelocity = { x: 1000, y: 0, twist: 0 };
    for (let i = 0; i < 6; i++) vel = applyMomentum(vel, 0.1 / 6).vel;
    expect(vel.x).toBeCloseTo(big, 8);
  });

  it('stops (zeroes the channel) once speed drops under the threshold', () => {
    const r = applyMomentum({ x: 3.2, y: 0, twist: 0.0105 }, FRAME);
    // 3.2·0.9 = 2.88 < 3 px/s and 0.0105·0.9 < 0.01 rad/s → both stop.
    expect(r.vel).toEqual({ x: 0, y: 0, twist: 0 });
    expect(r.done).toBe(true);
  });

  it('keeps twist coasting independently of the pan channels', () => {
    const r = applyMomentum({ x: 0, y: 0, twist: 1 }, FRAME);
    expect(r.vel.twist).toBeGreaterThan(0);
    expect(r.done).toBe(false);
  });

  it('does not move on a non-positive dt', () => {
    const r = applyMomentum({ x: 100, y: 100, twist: 1 }, 0);
    expect(r.dx).toBe(0);
    expect(r.vel.x).toBe(100);
    expect(r.done).toBe(false);
  });

  it('honours option overrides', () => {
    const r = applyMomentum({ x: 10, y: 0, twist: 0 }, FRAME, {
      decayPerFrame: 0.5,
      stopSpeedPx: 1,
    });
    expect(r.vel.x).toBeCloseTo(5, 10);
  });
});

describe('springStep', () => {
  const run = (from: number, target: number, seconds: number, omega = FLY_TO_OMEGA) => {
    let s: SpringState = { value: from, velocity: 0 };
    const steps = Math.round(seconds / FRAME);
    for (let i = 0; i < steps; i++) s = springStep(s, target, FRAME, omega);
    return s;
  };

  it('converges to within 1% of the initial offset in ~600 ms', () => {
    const s = run(1, 0, 0.6);
    expect(Math.abs(s.value)).toBeLessThan(0.01);
  });

  it('never overshoots the target from rest (critically damped)', () => {
    let s: SpringState = { value: 1, velocity: 0 };
    let prev = s.value;
    for (let i = 0; i < 240; i++) {
      s = springStep(s, 0, FRAME);
      expect(s.value).toBeGreaterThanOrEqual(0); // bounded: no crossing
      expect(s.value).toBeLessThanOrEqual(prev + 1e-12); // monotonic approach
      prev = s.value;
    }
  });

  it('is exact for the closed form regardless of step size', () => {
    // One 0.3 s step must equal 18 steps of 1/60 s (closed-form integration).
    const big = springStep({ value: 1, velocity: 0 }, 0, 0.3);
    const small = run(1, 0, 0.3);
    expect(small.value).toBeCloseTo(big.value, 10);
    expect(small.velocity).toBeCloseTo(big.velocity, 8);
  });

  it('handles an initial velocity toward the target with bounded overshoot', () => {
    let s: SpringState = { value: 1, velocity: -20 };
    let min = s.value;
    for (let i = 0; i < 240; i++) {
      s = springStep(s, 0, FRAME);
      min = Math.min(min, s.value);
    }
    // A hard shove may cross the target, but a critically damped spring's
    // overshoot stays small and it still settles.
    expect(min).toBeGreaterThan(-0.3);
    expect(Math.abs(s.value)).toBeLessThan(1e-3);
  });

  it('returns the state unchanged for a non-positive dt', () => {
    const s: SpringState = { value: 1, velocity: 2 };
    expect(springStep(s, 0, 0)).toBe(s);
  });
});

describe('springSettled', () => {
  it('is false while far from the target and true once close and slow', () => {
    expect(springSettled({ value: 1, velocity: 0 }, 0, 1e-3)).toBe(false);
    expect(springSettled({ value: 1e-4, velocity: 1 }, 0, 1e-3)).toBe(false);
    expect(springSettled({ value: 1e-4, velocity: 1e-4 }, 0, 1e-3)).toBe(true);
  });
});

describe('closestEquivalentAngle', () => {
  it('wraps the target to within π of the reference', () => {
    const cases: [number, number][] = [
      [0.6, 6.9],
      [0.6, -6.9],
      [3, 100],
      [-3, -100],
    ];
    for (const [target, ref] of cases) {
      const a = closestEquivalentAngle(target, ref);
      expect(Math.abs(a - ref)).toBeLessThanOrEqual(Math.PI + 1e-12);
      // Same angle modulo 2π.
      const diff = (a - target) / (2 * Math.PI);
      expect(diff).toBeCloseTo(Math.round(diff), 10);
    }
  });

  it('leaves an already-near target unchanged', () => {
    expect(closestEquivalentAngle(0.6, 0.7)).toBe(0.6);
  });
});
