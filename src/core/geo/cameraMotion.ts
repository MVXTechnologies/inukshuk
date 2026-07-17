/**
 * Pure camera-motion maths for the 3D terrain screens: release inertia
 * (exponential momentum decay) and critically-damped spring "fly-to" easing.
 * Kept in src/core (no three/react imports) so the decay and convergence
 * behaviour is unit-tested; the screens integrate these once per frame.
 */

/** Fraction of velocity kept per 60 Hz frame while coasting after release. */
export const MOMENTUM_DECAY_PER_FRAME = 0.9;
/** Screen-space speed (px/s) below which pan/orbit momentum stops. */
export const MOMENTUM_STOP_SPEED_PX = 3;
/** Angular speed (rad/s) below which twist momentum stops. */
export const MOMENTUM_STOP_SPEED_RAD = 0.01;

/**
 * Gesture release velocity: screen-space px/s for the single-finger drag and
 * rad/s for the two-finger twist. Screens map these onto orbit/pan deltas with
 * the same factors they use for live gestures.
 */
export interface MomentumVelocity {
  x: number;
  y: number;
  twist: number;
}

export interface MomentumStep {
  /** Displacements to apply this frame (same units as the velocity × s). */
  dx: number;
  dy: number;
  dTwist: number;
  /** Decayed velocity to carry into the next frame. */
  vel: MomentumVelocity;
  /** True once every channel has dropped below its stop threshold. */
  done: boolean;
}

/**
 * Advance coasting momentum by `dt` seconds: the frame's displacement plus the
 * exponentially decayed velocity (frame-rate independent — the decay factor is
 * `MOMENTUM_DECAY_PER_FRAME` per 60 Hz frame regardless of the actual dt).
 * Channels below their stop threshold are zeroed so motion ends crisply
 * instead of creeping forever.
 */
export function applyMomentum(
  vel: MomentumVelocity,
  dt: number,
  opts: { decayPerFrame?: number; stopSpeedPx?: number; stopSpeedRad?: number } = {},
): MomentumStep {
  const decay = opts.decayPerFrame ?? MOMENTUM_DECAY_PER_FRAME;
  const stopPx = opts.stopSpeedPx ?? MOMENTUM_STOP_SPEED_PX;
  const stopRad = opts.stopSpeedRad ?? MOMENTUM_STOP_SPEED_RAD;
  if (dt <= 0) {
    const done = Math.hypot(vel.x, vel.y) < stopPx && Math.abs(vel.twist) < stopRad;
    return { dx: 0, dy: 0, dTwist: 0, vel, done };
  }
  const k = Math.pow(decay, dt * 60);
  let nx = vel.x * k;
  let ny = vel.y * k;
  let nTwist = vel.twist * k;
  if (Math.hypot(nx, ny) < stopPx) {
    nx = 0;
    ny = 0;
  }
  if (Math.abs(nTwist) < stopRad) nTwist = 0;
  return {
    dx: vel.x * dt,
    dy: vel.y * dt,
    dTwist: vel.twist * dt,
    vel: { x: nx, y: ny, twist: nTwist },
    done: nx === 0 && ny === 0 && nTwist === 0,
  };
}

/**
 * Angular frequency of the fly-to spring. A critically damped spring settles
 * to <1% of the initial offset in ≈6.6/ω seconds, so ω=12 gives the ~600 ms
 * recenter/zoom animations.
 */
export const FLY_TO_OMEGA = 12;

export interface SpringState {
  value: number;
  velocity: number;
}

/**
 * One exact integration step of a critically damped spring toward `target`.
 * Closed form (not Euler), so it is unconditionally stable for any dt and —
 * for a start at rest — approaches the target monotonically, never
 * overshooting.
 */
export function springStep(
  s: SpringState,
  target: number,
  dt: number,
  omega = FLY_TO_OMEGA,
): SpringState {
  if (dt <= 0) return s;
  const dx = s.value - target;
  const e = Math.exp(-omega * dt);
  const t1 = (s.velocity + omega * dx) * dt;
  return {
    value: target + (dx + t1) * e,
    velocity: (s.velocity - t1 * omega) * e,
  };
}

/** Whether a spring is close enough to its target to snap there and stop. */
export function springSettled(
  s: SpringState,
  target: number,
  posEps: number,
  velEps = posEps * FLY_TO_OMEGA,
): boolean {
  return Math.abs(s.value - target) < posEps && Math.abs(s.velocity) < velEps;
}

/**
 * Wrap `target` to the equivalent angle (± n·2π) nearest `reference`, so a
 * fly-to on an orbit azimuth takes the short way round instead of unwinding
 * whole turns accumulated while spinning.
 */
export function closestEquivalentAngle(target: number, reference: number): number {
  const twoPi = 2 * Math.PI;
  return target + twoPi * Math.round((reference - target) / twoPi);
}
