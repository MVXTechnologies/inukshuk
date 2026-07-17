import {
  applyMomentum,
  closestEquivalentAngle,
  springSettled,
  springStep,
  type MomentumVelocity,
  type SpringState,
} from '@core/geo/cameraMotion';

/**
 * Per-screen camera dynamics for the 3D terrain views: frame timing, release
 * inertia and spring fly-to animations, advanced once per rendered frame from
 * `onFrame`. The maths lives in @core/geo/cameraMotion (unit-tested); this
 * wrapper owns the mutable state and maps spring channels onto an orbit
 * object. Screens decide how momentum displacements apply (orbit angles on
 * the trail view, ground pan + twist on the live view).
 */

/** Structural view of the orbit refs both screens keep. */
export interface OrbitLike {
  theta: number;
  phi: number;
  radius: number;
  center: { x: number; y: number; z: number };
}

/** Orbit parameters a fly-to eases toward; omitted channels are left alone. */
export interface FlyTargets {
  theta?: number;
  phi?: number;
  radius?: number;
  centerX?: number;
  centerZ?: number;
}

interface Spring {
  state: SpringState;
  target: number;
}

type FlyChannels = Partial<Record<'theta' | 'phi' | 'radius' | 'centerX' | 'centerZ', Spring>>;

/** Snap-to-target threshold for fly springs (scene units / radians). */
const FLY_EPS = 1e-3;
/** Clamp on per-frame dt so hitches (GC, tile decode) don't teleport motion. */
const MAX_FRAME_DT_S = 0.1;

export function createCameraDynamics() {
  let lastMs: number | null = null;
  let vel: MomentumVelocity = { x: 0, y: 0, twist: 0 };
  let coasting = false;
  let fly: FlyChannels | null = null;

  return {
    /** Seconds since the previous frame (0 on the first, clamped after gaps). */
    frameDt(nowMs: number): number {
      const dt =
        lastMs === null ? 0 : Math.min(Math.max((nowMs - lastMs) / 1000, 0), MAX_FRAME_DT_S);
      lastMs = nowMs;
      return dt;
    },

    /** A new touch begins: kill any coasting/flying so the finger wins. */
    interrupt(): void {
      coasting = false;
      fly = null;
      vel = { x: 0, y: 0, twist: 0 };
    },

    /** Start coasting from a gesture's release velocity. */
    launchMomentum(v: MomentumVelocity): void {
      vel = v;
      coasting = true;
    },

    /**
     * Advance inertia by dt; returns this frame's displacements (same screen-
     * space units as live gestures) or null when idle.
     */
    stepMomentum(dt: number): { dx: number; dy: number; dTwist: number } | null {
      if (!coasting || dt <= 0) return null;
      const r = applyMomentum(vel, dt);
      vel = r.vel;
      if (r.done) coasting = false;
      return { dx: r.dx, dy: r.dy, dTwist: r.dTwist };
    },

    /** Begin easing the orbit toward `targets` (critically damped, ~600 ms). */
    flyTo(orbit: OrbitLike, targets: FlyTargets): void {
      const mk = (value: number, target: number): Spring => ({
        state: { value, velocity: 0 },
        target,
      });
      const f: FlyChannels = {};
      if (targets.theta !== undefined)
        f.theta = mk(orbit.theta, closestEquivalentAngle(targets.theta, orbit.theta));
      if (targets.phi !== undefined) f.phi = mk(orbit.phi, targets.phi);
      if (targets.radius !== undefined) f.radius = mk(orbit.radius, targets.radius);
      if (targets.centerX !== undefined) f.centerX = mk(orbit.center.x, targets.centerX);
      if (targets.centerZ !== undefined) f.centerZ = mk(orbit.center.z, targets.centerZ);
      fly = f;
    },

    /** Update centre targets mid-flight (follow-mode recenter on a moving user). */
    retargetCenter(centerX: number, centerZ: number): void {
      if (!fly) return;
      if (fly.centerX) fly.centerX.target = centerX;
      if (fly.centerZ) fly.centerZ.target = centerZ;
    },

    isFlying(): boolean {
      return fly !== null;
    },

    /** Advance the fly springs and write them onto the orbit. */
    stepFly(orbit: OrbitLike, dt: number): void {
      if (!fly || dt <= 0) return;
      let settled = true;
      const step = (ch: Spring | undefined, apply: (v: number) => void) => {
        if (!ch) return;
        ch.state = springStep(ch.state, ch.target, dt);
        if (springSettled(ch.state, ch.target, FLY_EPS)) {
          apply(ch.target); // snap the last fraction so motion ends crisply
        } else {
          apply(ch.state.value);
          settled = false;
        }
      };
      step(fly.theta, (v) => (orbit.theta = v));
      step(fly.phi, (v) => (orbit.phi = v));
      step(fly.radius, (v) => (orbit.radius = v));
      step(fly.centerX, (v) => (orbit.center.x = v));
      step(fly.centerZ, (v) => (orbit.center.z = v));
      if (settled) fly = null;
    },
  };
}

export type CameraDynamics = ReturnType<typeof createCameraDynamics>;
