import { PanResponder, type PanResponderInstance } from 'react-native';
import * as THREE from 'three';

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Spherical orbit camera state shared by the 3D terrain screens. */
export interface OrbitState {
  theta: number;
  phi: number;
  radius: number;
  center: THREE.Vector3;
}

/** Place `camera` on the orbit sphere around the look-at centre, facing it. */
export function positionCameraFromOrbit(camera: THREE.Camera, o: OrbitState): void {
  const c = o.center;
  camera.position.set(
    c.x + o.radius * Math.sin(o.phi) * Math.sin(o.theta),
    c.y + o.radius * Math.cos(o.phi),
    c.z + o.radius * Math.sin(o.phi) * Math.cos(o.theta),
  );
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

/** One two-finger touch sample: finger distance, twist angle and centroid. */
export interface TwoFingerSample {
  dist: number;
  ang: number;
  cx: number;
  cy: number;
}

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
}

/**
 * The gesture state machine shared by the 3D terrain screens: two fingers pinch
 * to zoom (plus a per-screen `onTwoFinger` behaviour), one finger drags (per-
 * screen `onSingle`). Create it once per screen (e.g. in a `useMemo`).
 */
export function createTerrainPanResponder({
  orbit,
  onTwoFinger,
  onSingle,
}: TerrainPanHandlers): PanResponderInstance {
  // Gesture bookkeeping lives in this closure; it's touched on touch events
  // only, never during render.
  const gp = { x: 0, y: 0, cx: 0, cy: 0, dist: 0, ang: 0, single: true };
  return PanResponder.create({
    onStartShouldSetPanResponderCapture: () => true,
    onMoveShouldSetPanResponderCapture: () => true,
    onPanResponderGrant: (_e, g) => {
      gp.x = g.x0;
      gp.y = g.y0;
      gp.cx = 0;
      gp.cy = 0;
      gp.dist = 0;
      gp.ang = 0;
      gp.single = true;
    },
    onPanResponderMove: (e, g) => {
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
        if (gp.dist > 0) {
          const o = orbit.current;
          o.radius = clamp(o.radius * (gp.dist / curr.dist), 0.8, 9);
          onTwoFinger(curr, { dist: gp.dist, ang: gp.ang, cx: gp.cx, cy: gp.cy });
        }
        gp.dist = curr.dist;
        gp.ang = curr.ang;
        gp.cx = curr.cx;
        gp.cy = curr.cy;
        gp.single = false;
      } else {
        if (gp.single) onSingle(g.moveX - gp.x, g.moveY - gp.y);
        gp.x = g.moveX;
        gp.y = g.moveY;
        gp.single = true;
        gp.dist = 0;
      }
    },
  });
}
