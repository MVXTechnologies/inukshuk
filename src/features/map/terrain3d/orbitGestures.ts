import { PanResponder, type PanResponderInstance } from 'react-native';
import * as THREE from 'three';
import type { GroundHeightFn, Vec3Like } from '@core/geo/terrainRay';

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Azimuth change per horizontal px of a one-finger orbit drag (trail view). */
export const ORBIT_THETA_PER_PX = 0.008;
/** Tilt change per vertical px of a one-finger orbit drag (trail view). */
export const ORBIT_PHI_PER_PX = 0.006;

/** Spherical orbit camera state shared by the 3D terrain screens. */
export interface OrbitState {
  theta: number;
  phi: number;
  radius: number;
  center: THREE.Vector3;
}

/**
 * Place `camera` on the orbit sphere around the look-at centre, facing it.
 * When a `groundHeight` sampler is given, the eye is clamped to stay above the
 * terrain surface (+`margin`) — at high tilt and low radius the orbit sphere
 * can otherwise pass through peaks.
 */
export function positionCameraFromOrbit(
  camera: THREE.Camera,
  o: OrbitState,
  groundHeight?: GroundHeightFn,
  margin = 0.035,
): void {
  const c = o.center;
  const x = c.x + o.radius * Math.sin(o.phi) * Math.sin(o.theta);
  let y = c.y + o.radius * Math.cos(o.phi);
  const z = c.z + o.radius * Math.sin(o.phi) * Math.cos(o.theta);
  if (groundHeight) y = Math.max(y, groundHeight(x, z) + margin);
  camera.position.set(x, y, z);
  camera.lookAt(c);
}

/**
 * Translate a screen-space drag (px) into a ground-plane move. Scaled by the
 * camera distance and rotated by the current azimuth so "up" on screen is
 * always away from the camera.
 */
export function groundPanDelta(
  theta: number,
  radius: number,
  dxPx: number,
  dyPx: number,
): { dx: number; dz: number } {
  const s = radius * 0.0016;
  const dx = dxPx * s;
  const dy = dyPx * s;
  return {
    dx: -dx * Math.cos(theta) + dy * Math.sin(theta),
    dz: dx * Math.sin(theta) + dy * Math.cos(theta),
  };
}

// Scratch raycaster/vector for screenPointRay (touch-event rate, no per-call GC).
const pickRaycaster = new THREE.Raycaster();
const pickNdc = new THREE.Vector2();

/**
 * The world-space ray through a view-local point (dp) — the geometric input to
 * tap-to-query / pinch-anchored zoom. Null while the view has no layout yet.
 */
export function screenPointRay(
  camera: THREE.Camera,
  x: number,
  y: number,
  viewW: number,
  viewH: number,
): { origin: Vec3Like; dir: Vec3Like } | null {
  if (viewW <= 0 || viewH <= 0) return null;
  pickNdc.set((x / viewW) * 2 - 1, 1 - (y / viewH) * 2);
  pickRaycaster.setFromCamera(pickNdc, camera);
  const { origin, direction } = pickRaycaster.ray;
  return {
    origin: { x: origin.x, y: origin.y, z: origin.z },
    dir: { x: direction.x, y: direction.y, z: direction.z },
  };
}

/** One two-finger touch sample: finger distance, twist angle and centroid. */
export interface TwoFingerSample {
  dist: number;
  ang: number;
  cx: number;
  cy: number;
}

/** Release velocity of a gesture: px/s (single-finger) and rad/s (twist). */
export interface GestureVelocity {
  x: number;
  y: number;
  twist: number;
}

// Tap classification: a touch that never grew a second finger, stayed within
// the slop and lifted quickly. Two such taps close together are a double-tap.
const TAP_MAX_MS = 280;
const TAP_SLOP_PX = 10;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP_PX = 60;
/** Drop release inertia when the finger rested this long before lifting. */
const STALE_VELOCITY_MS = 120;
/** New-sample weight when smoothing gesture velocity across move events. */
const VELOCITY_SMOOTHING = 0.65;
/**
 * Pinch activation deadband: the cumulative finger-distance change (ratio vs
 * the gesture's start) that turns zooming on. A two-finger SLIDE always has a
 * few px of distance jitter; without the deadband every slide frame also
 * applied a zoom step, and the anchored-zoom recentring fought the pan — the
 * "two-finger move sometimes doesn't work, worse zoomed in" feel. Once
 * crossed, the gesture zooms for its remainder (slide-then-pinch still works).
 */
const PINCH_ACTIVATE_RATIO = 0.06;

const wrapPi = (a: number) => (a > Math.PI ? a - 2 * Math.PI : a < -Math.PI ? a + 2 * Math.PI : a);

export interface TerrainPanHandlers {
  /** Orbit state the shared pinch-zoom adjusts (radius, clamped 0.8–9). */
  orbit: { current: { radius: number } };
  /**
   * Two-finger move beyond the shared pinch-zoom — twist/tilt on the live map,
   * bounded ground pan on the trail view. Called only once a previous sample
   * exists (never on the first two-finger event), after the zoom is applied.
   */
  onTwoFinger: (curr: TwoFingerSample, prev: TwoFingerSample) => void;
  /**
   * One-finger drag delta in px — ground pan on the live map, orbit on the
   * trail view. Skipped on the transition frame right after a two-finger phase.
   */
  onSingle: (dxPx: number, dyPx: number) => void;
  /** Any touch begins: screens cancel momentum / fly-to so the finger wins. */
  onGestureStart?: () => void;
  /** Drag released while still moving: screens launch inertia from this. */
  onRelease?: (vel: GestureVelocity) => void;
  /**
   * Called after each shared pinch-zoom step with the radius scale actually
   * applied (post-clamp) and the pinch centroid in view-local dp — screens
   * shift the orbit centre so the zoom anchors on the ground under the fingers.
   */
  onPinch?: (scale: number, cx: number, cy: number) => void;
  /** A clean single tap (view-local dp) — fires after the double-tap window. */
  onTap?: (x: number, y: number) => void;
  /** Double-tap (view-local dp) — zoom toward the tapped point. */
  onDoubleTap?: (x: number, y: number) => void;
}

/**
 * The gesture state machine shared by the 3D terrain screens: two fingers pinch
 * to zoom (plus a per-screen `onTwoFinger` behaviour), one finger drags (per-
 * screen `onSingle`), with release velocity, tap and double-tap classification
 * on top. Create it once per screen (e.g. in a `useMemo`).
 */
export function createTerrainPanResponder({
  orbit,
  onTwoFinger,
  onSingle,
  onGestureStart,
  onRelease,
  onPinch,
  onTap,
  onDoubleTap,
}: TerrainPanHandlers): PanResponderInstance {
  // Gesture bookkeeping lives in this closure; it's touched on touch events
  // only, never during render.
  const gp = {
    x: 0,
    y: 0,
    cx: 0,
    cy: 0,
    dist: 0,
    ang: 0,
    single: true,
    // Tap + velocity tracking.
    startLx: 0,
    startLy: 0,
    t0: 0,
    tPrev: 0,
    vx: 0,
    vy: 0,
    vTwist: 0,
    moved: false,
    multi: false,
    // Pinch deadband bookkeeping: finger distance when the two-finger phase
    // began, and whether zooming has activated for this gesture.
    dist0: 0,
    pinching: false,
  };
  let lastTap: { t: number; x: number; y: number } | null = null;
  let pendingTap: ReturnType<typeof setTimeout> | null = null;

  const classifyTap = (x: number, y: number, ts: number) => {
    if (!onTap && !onDoubleTap) return;
    if (
      lastTap &&
      ts - lastTap.t <= DOUBLE_TAP_MS &&
      Math.hypot(x - lastTap.x, y - lastTap.y) <= DOUBLE_TAP_SLOP_PX
    ) {
      if (pendingTap) {
        clearTimeout(pendingTap);
        pendingTap = null;
      }
      lastTap = null;
      (onDoubleTap ?? onTap)?.(x, y);
      return;
    }
    lastTap = { t: ts, x, y };
    if (!onDoubleTap) {
      onTap?.(x, y);
      return;
    }
    // Hold the single tap for the double-tap window (the standard delay).
    pendingTap = setTimeout(() => {
      pendingTap = null;
      onTap?.(x, y);
    }, DOUBLE_TAP_MS);
  };

  return PanResponder.create({
    onStartShouldSetPanResponderCapture: () => true,
    onMoveShouldSetPanResponderCapture: () => true,
    onPanResponderGrant: (e, g) => {
      gp.x = g.x0;
      gp.y = g.y0;
      gp.cx = 0;
      gp.cy = 0;
      gp.dist = 0;
      gp.ang = 0;
      gp.single = true;
      gp.startLx = e.nativeEvent.locationX;
      gp.startLy = e.nativeEvent.locationY;
      gp.t0 = e.nativeEvent.timestamp;
      gp.tPrev = gp.t0;
      gp.vx = 0;
      gp.vy = 0;
      gp.vTwist = 0;
      gp.moved = false;
      gp.multi = false;
      gp.dist0 = 0;
      gp.pinching = false;
      onGestureStart?.();
    },
    onPanResponderMove: (e, g) => {
      const ts = e.nativeEvent.timestamp;
      const dtS = Math.max((ts - gp.tPrev) / 1000, 1e-4);
      const t = e.nativeEvent.touches;
      if (t.length >= 2 && t[0] && t[1]) {
        const fx = t[1].pageX - t[0].pageX;
        const fy = t[1].pageY - t[0].pageY;
        const curr: TwoFingerSample = {
          dist: Math.hypot(fx, fy),
          ang: Math.atan2(fy, fx),
          cx: (t[0].pageX + t[1].pageX) / 2,
          cy: (t[0].pageY + t[1].pageY) / 2,
        };
        if (gp.dist0 === 0) gp.dist0 = curr.dist;
        if (gp.dist > 0) {
          // Zoom only once the pinch intent is clear (see PINCH_ACTIVATE_RATIO)
          // so a plain two-finger slide is a pure pan.
          if (!gp.pinching && Math.abs(curr.dist / gp.dist0 - 1) > PINCH_ACTIVATE_RATIO) {
            gp.pinching = true;
          }
          if (gp.pinching) {
            const o = orbit.current;
            const oldRadius = o.radius;
            o.radius = clamp(oldRadius * (gp.dist / curr.dist), 0.8, 9);
            const scale = o.radius / oldRadius;
            if (onPinch && Math.abs(scale - 1) > 1e-4) {
              // Centroid in view-local coords, so screens can unproject it.
              onPinch(
                scale,
                (t[0].locationX + t[1].locationX) / 2,
                (t[0].locationY + t[1].locationY) / 2,
              );
            }
          }
          const dAng = wrapPi(curr.ang - gp.ang);
          const instTwist = dAng / dtS;
          gp.vTwist =
            gp.vTwist === 0 ? instTwist : gp.vTwist + (instTwist - gp.vTwist) * VELOCITY_SMOOTHING;
          onTwoFinger(curr, { dist: gp.dist, ang: gp.ang, cx: gp.cx, cy: gp.cy });
        }
        gp.dist = curr.dist;
        gp.ang = curr.ang;
        gp.cx = curr.cx;
        gp.cy = curr.cy;
        gp.single = false;
        gp.multi = true;
        gp.vx = 0;
        gp.vy = 0;
      } else {
        const dxPx = g.moveX - gp.x;
        const dyPx = g.moveY - gp.y;
        if (gp.single) {
          onSingle(dxPx, dyPx);
          const ivx = dxPx / dtS;
          const ivy = dyPx / dtS;
          gp.vx = gp.vx === 0 ? ivx : gp.vx + (ivx - gp.vx) * VELOCITY_SMOOTHING;
          gp.vy = gp.vy === 0 ? ivy : gp.vy + (ivy - gp.vy) * VELOCITY_SMOOTHING;
        } else {
          // Transition frame after a two-finger phase: restart velocity fresh.
          gp.vx = 0;
          gp.vy = 0;
        }
        gp.x = g.moveX;
        gp.y = g.moveY;
        gp.single = true;
        gp.dist = 0;
        // Re-baseline the deadband if a second finger lands again later.
        gp.dist0 = 0;
        gp.pinching = false;
        gp.vTwist = 0;
      }
      if (Math.hypot(g.dx, g.dy) > TAP_SLOP_PX) gp.moved = true;
      gp.tPrev = ts;
    },
    onPanResponderRelease: (e) => {
      const ts = e.nativeEvent.timestamp;
      if (!gp.multi && !gp.moved && ts - gp.t0 <= TAP_MAX_MS) {
        classifyTap(gp.startLx, gp.startLy, ts);
        return;
      }
      // Velocity is tracked from move timestamps ourselves — RN's gestureState
      // vx/vy units are inconsistent across platforms.
      if (onRelease && ts - gp.tPrev <= STALE_VELOCITY_MS) {
        onRelease({ x: gp.vx, y: gp.vy, twist: gp.vTwist });
      }
    },
  });
}
